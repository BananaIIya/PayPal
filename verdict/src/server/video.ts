// 视频证据（开发文档“视频先用 ffmpeg 抽帧，帧作为图片输入其余分析器，原视频只给 Consistency 和 Provenance 使用”）。
// 抽帧按固定间隔加场景切换（文档“视频按固定间隔加场景切换抽帧，逐帧比对”）。
// 用系统里的 ffmpeg / ffprobe；没有安装时视频照样保存，但不抽帧，Consistency 会标为未执行，判定显示“核验不完整”。
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { VideoMeta } from '@/analyzers/video-meta';
import type { SourceMark } from '@/core/types';
import { addEvidence } from './repo';
import type { VideoMime } from './storage';

const run = promisify(execFile);

/** 每段视频最多抽这么多帧，避免长视频拖慢 LLM 属性提取。 */
export const MAX_FRAMES = 12;
/** 场景切换阈值（ffmpeg scene 分数，0–1）。 */
const SCENE_THRESHOLD = 0.4;
/** 场景切换帧和间隔帧离得这么近时只留间隔帧。 */
const NEAR_MS = 500;
const TIMEOUT_MS = 60_000;

const EXT: Record<VideoMime, string> = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };

const g = globalThis as unknown as { __verdictFfmpeg?: { ffmpeg: string; ffprobe: string } | null };

/** 依次试环境变量、PATH、Homebrew 和常见安装位置。桌面应用启动的进程 PATH 里可能没有 Homebrew。 */
export function ffmpegTools(): { ffmpeg: string; ffprobe: string } | null {
  if (g.__verdictFfmpeg !== undefined) return g.__verdictFfmpeg;
  const works = (bin: string) => {
    try {
      return spawnSync(bin, ['-version'], { timeout: 5000 }).status === 0;
    } catch {
      return false;
    }
  };
  const dirs = ['', '/opt/homebrew/bin/', '/usr/local/bin/', '/usr/bin/'];
  const ffmpeg = [process.env.FFMPEG_PATH, ...dirs.map((d) => `${d}ffmpeg`)].find((b): b is string => !!b && works(b));
  const ffprobe = [process.env.FFPROBE_PATH, ffmpeg ? path.join(path.dirname(ffmpeg), 'ffprobe') : undefined, ...dirs.map((d) => `${d}ffprobe`)].find(
    (b): b is string => !!b && works(b),
  );
  g.__verdictFfmpeg = ffmpeg && ffprobe ? { ffmpeg, ffprobe } : null;
  return g.__verdictFfmpeg;
}

export interface VideoInfo {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  /** 容器和视频流里的元数据标签（encoder、handler_name、软件名等）。 */
  tags: Record<string, string>;
}

export interface ExtractedFrame {
  atMs: number;
  reason: 'interval' | 'scene';
  data: Buffer;
}

export interface FrameExtraction {
  status: 'ok' | 'unavailable' | 'failed';
  reason: string | null;
  info: VideoInfo | null;
  frames: ExtractedFrame[];
  /** 场景切换的时间点（毫秒），包括没有单独抽帧的。现场录制的视频里出现这些说明可能经过剪辑。 */
  sceneCutsMs: number[];
}

/** 容器和视频流都可能有 encoder 之类的同名标签，冲突时流上的加前缀保留，剪辑软件的名字可能只在其中一处。 */
function mergeTags(format: Record<string, string> = {}, stream: Record<string, string> = {}): Record<string, string> {
  const tags = { ...format };
  for (const [k, v] of Object.entries(stream)) tags[k in tags && tags[k] !== v ? `stream.${k}` : k] = v;
  return tags;
}

async function probe(ffprobe: string, file: string): Promise<VideoInfo> {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: TIMEOUT_MS });
  const data = JSON.parse(stdout) as {
    format?: { duration?: string; tags?: Record<string, string> };
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string; tags?: Record<string, string> }[];
  };
  const video = data.streams?.find((s) => s.codec_type === 'video');
  if (!video) throw new Error('The file has no video track');
  const seconds = Number(data.format?.duration ?? video.duration);
  return {
    durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
    width: video.width ?? null,
    height: video.height ?? null,
    codec: video.codec_name ?? null,
    tags: mergeTags(data.format?.tags, video.tags),
  };
}

/** 跑一次 select 滤镜，返回输出的帧和 showinfo 打出的时间戳。 */
async function select(ffmpeg: string, file: string, dir: string, prefix: string, expr: string): Promise<{ atMs: number; data: Buffer }[]> {
  const pattern = path.join(dir, `${prefix}_%03d.jpg`);
  let stderr: string;
  try {
    ({ stderr } = await run(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'info', '-i', file, '-vf', `select='${expr}',scale='min(1280,iw)':-2,showinfo`, '-fps_mode', 'vfr', '-frames:v', String(MAX_FRAMES * 2), '-q:v', '3', pattern],
      { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    ));
  } catch (e) {
    // 一帧都没选中（比如整段没有场景切换）时 ffmpeg 以失败退出，这不是错误。
    const err = e as { stderr?: string };
    if (err.stderr?.includes('Nothing was written into output file')) return [];
    throw e;
  }
  const times = [...stderr.matchAll(/Parsed_showinfo.*?pts_time:\s*([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 1000));
  return times.flatMap((atMs, i) => {
    const out = path.join(dir, `${prefix}_${String(i + 1).padStart(3, '0')}.jpg`);
    return fs.existsSync(out) ? [{ atMs, data: fs.readFileSync(out) }] : [];
  });
}

export async function extractFrames(buf: Buffer, mime: VideoMime): Promise<FrameExtraction> {
  const tools = ffmpegTools();
  if (!tools) {
    return { status: 'unavailable', reason: 'ffmpeg is not installed on the server, so no frames were extracted from the video', info: null, frames: [], sceneCutsMs: [] };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-video-'));
  try {
    const file = path.join(dir, `input.${EXT[mime]}`);
    fs.writeFileSync(file, buf);
    const info = await probe(tools.ffprobe, file);
    // MediaRecorder 录的 WebM 常常不写时长，这时按 2 秒间隔、靠帧数上限收住。
    const intervalSec = Math.max(2, (info.durationMs ?? 0) / 1000 / 10);
    const interval = await select(tools.ffmpeg, file, dir, 'i', `isnan(prev_selected_t)+gte(t-prev_selected_t\\,${intervalSec})`);
    const scenes = await select(tools.ffmpeg, file, dir, 's', `gt(scene\\,${SCENE_THRESHOLD})`);
    const sceneCutsMs = scenes.map((s) => s.atMs);
    const extra = scenes.filter((s) => !interval.some((f) => Math.abs(f.atMs - s.atMs) < NEAR_MS));
    const frames: ExtractedFrame[] = [
      ...interval.slice(0, MAX_FRAMES).map((f) => ({ ...f, reason: 'interval' as const })),
      ...extra.map((f) => ({ ...f, reason: 'scene' as const })),
    ]
      .slice(0, MAX_FRAMES)
      .sort((a, b) => a.atMs - b.atMs);
    if (!frames.length) return { status: 'failed', reason: 'ffmpeg could not decode any frames from the video', info, frames: [], sceneCutsMs };
    return { status: 'ok', reason: null, info, frames, sceneCutsMs };
  } catch (e) {
    return { status: 'failed', reason: `Video parsing failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`, info: null, frames: [], sceneCutsMs: [] };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 保存一段视频和它抽出来的帧。帧继承视频的来源、层级、镜头和挑战码（同一次现场拍摄），
 * 用同一个上传时间，免得 Origin 把同一段视频的帧当成更早的历史证据。
 */
export async function addVideoEvidence(input: {
  claimId: string | null;
  orderId: string;
  source: Extract<SourceMark, 'live_capture' | 'challenge_pending' | 'uploaded' | 'manual_import' | 'paypal_dispute'>;
  file: Buffer;
  mime: VideoMime;
  shot: string | null;
  challengeId?: string | null;
  captureMeta?: Record<string, unknown>;
}): Promise<{ id: string; sha256: string; layer: string; frames: number; note: string | null }> {
  const at = new Date().toISOString();
  const extraction = await extractFrames(input.file, input.mime);
  const video: VideoMeta = {
    frameExtraction: extraction.status,
    reason: extraction.reason,
    durationMs: extraction.info?.durationMs ?? null,
    width: extraction.info?.width ?? null,
    height: extraction.info?.height ?? null,
    codec: extraction.info?.codec ?? null,
    tags: extraction.info?.tags ?? {},
    frames: extraction.frames.length,
    sceneCutsMs: extraction.sceneCutsMs,
  };
  const saved = await addEvidence({
    claimId: input.claimId,
    orderId: input.orderId,
    source: input.source,
    file: input.file,
    mime: input.mime,
    shot: input.shot,
    challengeId: input.challengeId,
    captureMeta: { ...input.captureMeta, video },
    at,
    kind: 'video',
  });
  for (const f of extraction.frames) {
    await addEvidence({
      claimId: input.claimId,
      orderId: input.orderId,
      source: input.source,
      file: f.data,
      mime: 'image/jpeg',
      shot: input.shot,
      challengeId: input.challengeId,
      captureMeta: { parentId: saved.id, atMs: f.atMs, reason: f.reason },
      at,
      kind: 'frame',
      parentId: saved.id,
    });
  }
  return { ...saved, frames: extraction.frames.length, note: extraction.reason };
}
