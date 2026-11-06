// 视频证据的 capture_meta.video：上传时由 server/video.ts 写入，分析器和页面从这里读。

export interface VideoMeta {
  frameExtraction: 'ok' | 'unavailable' | 'failed';
  reason: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  /** 容器和视频流里的元数据标签（encoder、handler_name、软件名等）。 */
  tags: Record<string, string>;
  frames: number;
  /** 场景切换的时间点（毫秒）。 */
  sceneCutsMs: number[];
}

export function videoMeta(captureMeta: string | null | undefined): VideoMeta | null {
  if (!captureMeta) return null;
  try {
    return (JSON.parse(captureMeta) as { video?: VideoMeta }).video ?? null;
  } catch {
    return null;
  }
}
