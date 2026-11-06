// 视频证据：文件类型识别、ffmpeg 抽帧、帧挂在视频下面、各分析器拿到的证据、剪辑痕迹信号、没有 ffmpeg 时的降级。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-video-test-'));
process.env.VERDICT_DATA_DIR = dir;
delete process.env.LLM_API_KEY;
delete process.env.LLM_PROVIDER;

let repo: typeof import('@/server/repo');
let video: typeof import('@/server/video');
let storage: typeof import('@/server/storage');
let ingest: typeof import('@/server/ingest');
let pipeline: typeof import('@/server/pipeline');
let db: typeof import('@/server/db');

type Tools = { ffmpeg: string; ffprobe: string } | null;
let tools: Tools = null;
const files: Record<string, Buffer> = {};

/** 用 ffmpeg 自带的测试画面生成样本：一段带硬切的，一段连续但元数据写着剪辑软件的。 */
function makeSamples(ffmpeg: string) {
  const out = (name: string) => path.join(dir, name);
  execFileSync(ffmpeg, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'color=c=red:duration=3:size=320x240:rate=15',
    '-filter_complex', '[0][1]concat=n=2:v=1[v]', '-map', '[v]',
    '-c:v', 'mpeg4', out('cut.mp4'),
  ]);
  execFileSync(ffmpeg, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=duration=5:size=320x240:rate=15',
    '-c:v', 'mpeg4', '-metadata', 'comment=Exported with CapCut', out('edited.mp4'),
  ]);
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=4:size=320x240:rate=15', '-c:v', 'libvpx', '-b:v', '300k', out('plain.webm')]);
  for (const name of ['cut.mp4', 'edited.mp4', 'plain.webm']) files[name] = fs.readFileSync(out(name));
}

beforeAll(async () => {
  const { seedDemo } = await import('@/demo/seed');
  repo = await import('@/server/repo');
  video = await import('@/server/video');
  storage = await import('@/server/storage');
  ingest = await import('@/server/ingest');
  pipeline = await import('@/server/pipeline');
  db = await import('@/server/db');
  await seedDemo();
  tools = video.ffmpegTools();
  if (tools) makeSamples(tools.ffmpeg);
}, 120000);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function newClaim() {
  const order = db.db().prepare("SELECT * FROM orders WHERE category = 'ceramics' LIMIT 1").get() as { id: string; merchant_id: string };
  const claimId = ingest.createClaim({ merchantId: order.merchant_id, orderId: order.id, origin: 'portal', type: 'damaged', status: 'analyzing' });
  return { claimId, orderId: order.id };
}

function challengeFor(claimId: string): string {
  const id = crypto.randomUUID();
  db.db()
    .prepare("INSERT INTO challenges (id, claim_id, shot_label, code, action, issued_at) VALUES (?, ?, 'overall', 'K7Q2', '把商品转半圈', ?)")
    .run(id, claimId, new Date().toISOString());
  return id;
}

describe('视频文件识别', () => {
  it('按文件头区分 WebM、MP4、MOV，不把 HEIC 和 Matroska 当视频', () => {
    const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${brand}`), Buffer.alloc(40)]);
    const ebml = (doc: string) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from(`\x42\x82\x84${doc}`), Buffer.alloc(40)]);
    expect(storage.sniffVideoType(ftyp('isom'))).toBe('video/mp4');
    expect(storage.sniffVideoType(ftyp('qt  '))).toBe('video/quicktime');
    expect(storage.sniffVideoType(ftyp('heic'))).toBeNull();
    expect(storage.sniffVideoType(ebml('webm'))).toBe('video/webm');
    expect(storage.sniffVideoType(ebml('matroska'))).toBeNull();
    expect(storage.sniffVideoType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(40).fill(0)]))).toBeNull();
  });
});

describe('抽帧', () => {
  it('按固定间隔抽帧，场景切换处另记时间点', async ({ skip }) => {
    if (!tools) skip();
    const cut = await video.extractFrames(files['cut.mp4'], 'video/mp4');
    expect(cut.status).toBe('ok');
    expect(cut.info?.durationMs).toBe(6000);
    expect(cut.frames.map((f) => f.atMs)).toEqual(expect.arrayContaining([0, 2000, 4000]));
    expect(cut.frames.length).toBeLessThanOrEqual(video.MAX_FRAMES);
    expect(cut.sceneCutsMs.some((t) => Math.abs(t - 3000) <= 200)).toBe(true);
    for (const f of cut.frames) expect(storage.sniffImageType(f.data)).toBe('image/jpeg');

    const webm = await video.extractFrames(files['plain.webm'], 'video/webm');
    expect(webm.status).toBe('ok');
    expect(webm.sceneCutsMs).toEqual([]);
  });
});

describe('视频证据进入分析', () => {
  it('帧挂在视频下面，继承来源和挑战码；原视频只给 Provenance 和 Consistency', async ({ skip }) => {
    if (!tools) skip();
    const { claimId, orderId } = newClaim();
    const challengeId = challengeFor(claimId);
    const saved = await video.addVideoEvidence({ claimId, orderId, source: 'live_capture', file: files['cut.mp4'], mime: 'video/mp4', shot: 'overall', challengeId });
    expect(saved.frames).toBeGreaterThan(1);
    const rows = repo.claimEvidence(claimId);
    const v = rows.find((r) => r.kind === 'video')!;
    const frames = rows.filter((r) => r.kind === 'frame');
    expect(v.id).toBe(saved.id);
    expect(v.dhash).toBeNull();
    expect(frames).toHaveLength(saved.frames);
    for (const f of frames) {
      expect(f).toMatchObject({ parent_id: v.id, source: 'live_capture', layer: 'B', challenge_id: challengeId, shot_label: 'overall', created_at: v.created_at });
      expect(f.dhash).toBeTruthy();
    }

    await pipeline.runAnalysis(claimId, { latencyMs: 0 });
    const signals = repo.claimSignals(claimId);
    // 现场录制里有硬切。
    const cut = signals.find((s) => s.code === 'VIDEO_DISCONTINUITY')!;
    expect(cut.analyzer).toBe('provenance');
    expect(cut.evidenceIds).toEqual([v.id]);
    // Provenance 看原视频，不看帧（帧没有元数据）。
    const none = signals.find((s) => s.code === 'NO_PROVENANCE')!;
    expect(none.evidenceIds).toEqual([v.id]);
    // 没有 LLM 时属性提取不可用，但视频已经抽帧，所以原因是模型而不是视频。
    const consistency = repo.claimRuns(claimId).find((r) => r.analyzer === 'consistency')!;
    expect(consistency.error ?? '').not.toContain('抽帧');
    // 页面上视频和帧的关系
    const detail = repo.claimDetail(claimId)!;
    expect(detail.evidence.find((e) => e.id === v.id)?.kind).toBe('video');
    expect(detail.evidence.filter((e) => e.parentId === v.id)).toHaveLength(saved.frames);
  });

  it('元数据里有剪辑软件时给出 VIDEO_EDITED；相册上传的视频不查画面突变', async ({ skip }) => {
    if (!tools) skip();
    const { claimId, orderId } = newClaim();
    await video.addVideoEvidence({ claimId, orderId, source: 'uploaded', file: files['edited.mp4'], mime: 'video/mp4', shot: 'overall' });
    await pipeline.runAnalysis(claimId, { latencyMs: 0 });
    const codes = repo.claimSignals(claimId).map((s) => s.code);
    expect(codes).toContain('VIDEO_EDITED');
    expect(codes).not.toContain('VIDEO_DISCONTINUITY');
    const report = JSON.parse(repo.latestVerdict(claimId)!.report) as import('@/core/types').VerdictReport;
    const finding = report.findings.find((f) => f.code === 'VIDEO_EDITED')!;
    expect(finding.normalExplanations).toContain('视频剪辑可能是为了保护隐私或压缩文件');
  });

  it('提交给 PayPal 的附件把视频换成它的第一帧', async ({ skip }) => {
    if (!tools) skip();
    const { claimId, orderId } = newClaim();
    const saved = await video.addVideoEvidence({ claimId, orderId, source: 'uploaded', file: files['edited.mp4'], mime: 'video/mp4', shot: 'overall' });
    await pipeline.runAnalysis(claimId, { latencyMs: 0 });
    const { selectAttachmentEvidence } = await import('@/server/attachments');
    const picked = selectAttachmentEvidence(claimId);
    expect(picked).toHaveLength(1);
    expect(picked[0]).toMatchObject({ kind: 'frame', parent_id: saved.id, mime_type: 'image/jpeg' });
    expect(JSON.parse(picked[0].capture_meta!).atMs).toBe(0);
  });

  it('没有 ffmpeg 时视频照样保存，Consistency 标为未执行，判定显示核验不完整', async ({ skip }) => {
    if (!tools) skip();
    const g = globalThis as unknown as { __verdictFfmpeg?: Tools };
    const saved = g.__verdictFfmpeg;
    g.__verdictFfmpeg = null;
    try {
      const { claimId, orderId } = newClaim();
      const res = await video.addVideoEvidence({ claimId, orderId, source: 'uploaded', file: files['plain.webm'], mime: 'video/webm', shot: 'overall' });
      expect(res.frames).toBe(0);
      expect(res.note).toContain('ffmpeg');
      expect(repo.claimEvidence(claimId).map((r) => r.kind)).toEqual(['video']);
      await pipeline.runAnalysis(claimId, { latencyMs: 0 });
      const run = repo.claimRuns(claimId).find((r) => r.analyzer === 'consistency')!;
      expect(run.status).toBe('unavailable');
      expect(run.error).toContain('没有抽帧');
      expect(repo.latestVerdict(claimId)!.incomplete).toBe(1);
      // 只有视频、没有帧时，图片类分析器没有可看的证据。
      const synthetic = repo.claimRuns(claimId).find((r) => r.analyzer === 'synthetic');
      expect(synthetic?.status).not.toBe('done');
    } finally {
      g.__verdictFfmpeg = saved;
    }
  });
});

describe('视频的来源凭证扫描', () => {
  it('MP4 里 C2PA 规定的 uuid 盒子按清单解析', async () => {
    const { scanProvenance } = await import('@/analyzers/provenance-scan');
    const payload = Buffer.concat([Buffer.from('d8fec3d61b0e483c92975828877ec481', 'hex'), Buffer.from('jumbc2pa...c2pa.actions digitalSourceType trainedAlgorithmicMedia Sora')]);
    const uuidBox = Buffer.concat([Buffer.alloc(4), Buffer.from('uuid'), payload]);
    uuidBox.writeUInt32BE(uuidBox.length, 0);
    const ftyp = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.alloc(4)]);
    const scan = scanProvenance(Buffer.concat([ftyp, uuidBox]), 'video/mp4');
    expect(scan).toMatchObject({ c2paManifest: true, aiSourceType: true, generator: 'Sora', containers: ['BMFF uuid'] });
    expect(scanProvenance(ftyp, 'video/mp4').c2paManifest).toBe(false);
  });
});
