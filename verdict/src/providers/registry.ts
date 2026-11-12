// provider 选择与按哈希缓存。缓存同时也是“录制回放”的载体：演示数据把录制结果预先写进缓存，
// 走的是和真实调用一样的代码路径，signal.provider 会标明结果来自哪里。
import { db } from '@/server/db';
import { claudeVisionFromEnv } from './claude-vision';
import type {
  EvidenceAttributes,
  SyntheticCacheEntry,
  TrackingProvider,
  TrackingResult,
  VisionContext,
} from './types';
import { ProviderUnavailable } from './types';

export const RECORDED = 'recorded-fixture';

interface CacheRow {
  provider: string;
  result: string;
}

function cacheGet<T>(kind: string, sha256: string): { provider: string; result: T } | null {
  const row = db().prepare('SELECT provider, result FROM provider_cache WHERE kind = ? AND sha256 = ?').get(kind, sha256) as
    | CacheRow
    | undefined;
  return row ? { provider: row.provider, result: JSON.parse(row.result) as T } : null;
}

export function cachePut(kind: string, sha256: string, provider: string, result: unknown): void {
  db()
    .prepare('INSERT OR REPLACE INTO provider_cache (kind, sha256, provider, result) VALUES (?, ?, ?, ?)')
    .run(kind, sha256, provider, JSON.stringify(result));
}

export interface ProviderOptions {
  /** 演示数据生成时不调用任何付费服务。 */
  offline?: boolean;
}

type VisionHit = { provider: string; attrs: EvidenceAttributes };

/** 同一张图同时被多个分析器抽取时，共用这一次模型调用。 */
const inflight = new Map<string, Promise<VisionHit>>();

async function extractFresh(
  evidence: { sha256: string; mime_type: string },
  read: () => Buffer,
  ctx: VisionContext,
  opts: ProviderOptions,
): Promise<VisionHit> {
  const hit = cacheGet<EvidenceAttributes>('vision', evidence.sha256);
  if (hit) return { provider: hit.provider, attrs: hit.result };
  const vision = opts.offline ? null : claudeVisionFromEnv();
  if (!vision) throw new ProviderUnavailable('No multimodal LLM configured (LLM_PROVIDER, LLM_API_KEY)');
  const attrs = await vision.extract(read(), evidence.mime_type, ctx);
  cachePut('vision', evidence.sha256, vision.name, attrs);
  return { provider: vision.name, attrs };
}

export async function extractAttributes(
  evidence: { sha256: string; mime_type: string },
  read: () => Buffer,
  ctx: VisionContext,
  opts: ProviderOptions = {},
): Promise<VisionHit> {
  const hit = cacheGet<EvidenceAttributes>('vision', evidence.sha256);
  if (hit) return { provider: hit.provider, attrs: hit.result };
  const key = evidence.sha256;
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = extractFresh(evidence, read, ctx, opts).finally(() => {
    if (inflight.get(key) === job) inflight.delete(key);
  });
  inflight.set(key, job);
  return job;
}

export function syntheticScores(sha256: string): { provider: string; entry: SyntheticCacheEntry } | null {
  const hit = cacheGet<SyntheticCacheEntry>('synthetic', sha256);
  return hit ? { provider: hit.provider, entry: hit.result } : null;
}

/** 物流模拟器：读订单上预置的轨迹。真实接入时换成 EasyPost、Shippo 实现。 */
export class SimulatedTracking implements TrackingProvider {
  readonly name = 'Tracking simulator';
  constructor(private data: TrackingResult | null) {}
  async track(): Promise<TrackingResult> {
    if (!this.data) throw new ProviderUnavailable('No tracking API configured (EASYPOST_API_KEY or SHIPPO_API_KEY), and this tracking number has no simulated history');
    return this.data;
  }
}

export function providerStatus() {
  const vision = claudeVisionFromEnv();
  return [
    {
      category: 'C2PA and implicit AI labels',
      state: 'active' as const,
      detail: 'Local byte-level parsing (detects manifests and AI source types; does not verify signatures)',
    },
    {
      category: 'Perceptual hash comparison',
      state: 'active' as const,
      detail: "Local 256-bit dHash, compared against this merchant's prior evidence",
    },
    {
      category: 'Multimodal LLM',
      state: vision ? ('active' as const) : ('off' as const),
      detail: vision ? vision.name : 'LLM_PROVIDER and LLM_API_KEY not configured; Consistency, Plausibility, Reference, and Records will not run on real photos',
    },
    {
      category: 'AI-generation detectors',
      state: 'off' as const,
      detail: 'Adapters for Hive, Sightengine, and AI or Not are not connected yet; Synthetic shows as not run for real photos',
    },
    { category: 'SynthID watermark', state: 'off' as const, detail: 'Not connected yet' },
    { category: 'Reverse image search', state: 'off' as const, detail: 'SerpAPI and TinEye not connected yet' },
    { category: 'Tracking', state: 'simulated' as const, detail: 'Tracking simulator; history comes from demo data on the order' },
    { category: 'PayPal', state: 'simulated' as const, detail: 'PayPal simulator; no real money moves' },
  ];
}

export function dataProcessors(): string[] {
  const vision = claudeVisionFromEnv();
  return vision ? ['Anthropic (Claude, for recognizing image content)'] : [];
}
