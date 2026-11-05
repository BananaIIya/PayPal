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

export async function extractAttributes(
  evidence: { sha256: string; mime_type: string },
  read: () => Buffer,
  ctx: VisionContext,
  opts: ProviderOptions = {},
): Promise<{ provider: string; attrs: EvidenceAttributes }> {
  const hit = cacheGet<EvidenceAttributes>('vision', evidence.sha256);
  if (hit) return { provider: hit.provider, attrs: hit.result };
  const vision = opts.offline ? null : claudeVisionFromEnv();
  if (!vision) throw new ProviderUnavailable('未配置多模态 LLM（LLM_PROVIDER、LLM_API_KEY）');
  const attrs = await vision.extract(read(), evidence.mime_type, ctx);
  cachePut('vision', evidence.sha256, vision.name, attrs);
  return { provider: vision.name, attrs };
}

export function syntheticScores(sha256: string): { provider: string; entry: SyntheticCacheEntry } | null {
  const hit = cacheGet<SyntheticCacheEntry>('synthetic', sha256);
  return hit ? { provider: hit.provider, entry: hit.result } : null;
}

/** 物流模拟器：读订单上预置的轨迹。真实接入时换成 EasyPost、Shippo 实现。 */
export class SimulatedTracking implements TrackingProvider {
  readonly name = '物流模拟器';
  constructor(private data: TrackingResult | null) {}
  async track(): Promise<TrackingResult> {
    if (!this.data) throw new ProviderUnavailable('未配置物流接口（EASYPOST_API_KEY 或 SHIPPO_API_KEY），该单号也没有模拟轨迹');
    return this.data;
  }
}

export function providerStatus() {
  const vision = claudeVisionFromEnv();
  return [
    {
      category: 'C2PA 与 AI 隐式标识',
      state: 'active' as const,
      detail: '本地字节级解析（检测清单与 AI 来源类型，不校验签名）',
    },
    {
      category: '感知哈希比对',
      state: 'active' as const,
      detail: '本地 256 位 dHash，比对本商家历史证据',
    },
    {
      category: '多模态 LLM',
      state: vision ? ('active' as const) : ('off' as const),
      detail: vision ? vision.name : '未配置 LLM_PROVIDER 与 LLM_API_KEY；真实照片的 Consistency、Plausibility、Reference、Records 不会运行',
    },
    {
      category: 'AI 生成检测器',
      state: 'off' as const,
      detail: 'Hive、Sightengine、AI or Not 的适配器尚未接入；真实照片的 Synthetic 显示为未执行',
    },
    { category: 'SynthID 水印', state: 'off' as const, detail: '尚未接入' },
    { category: '反向搜图', state: 'off' as const, detail: 'SerpAPI、TinEye 尚未接入' },
    { category: '物流轨迹', state: 'simulated' as const, detail: '物流模拟器，轨迹来自订单上的演示数据' },
    { category: 'PayPal', state: 'simulated' as const, detail: 'PayPal 模拟器，没有真实资金流动' },
  ];
}

export function dataProcessors(): string[] {
  const vision = claudeVisionFromEnv();
  return vision ? ['Anthropic（Claude，用于识别画面内容）'] : [];
}
