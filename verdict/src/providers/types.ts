// 外部服务接口。没有配置密钥的实现会抛 ProviderUnavailable，对应检查在报告里标为未执行。

export class ProviderUnavailable extends Error {}

export interface EvidenceAttributes {
  /** 画面中本订单商品的数量；看不清时为 null。 */
  objectCount: number | null;
  color: string | null;
  model: string | null;
  serialNumber: string | null;
  damageLocation: string | null;
  packagingOpened: boolean | null;
  packagingIntact: boolean | null;
  /** 画面中手写纸条上的挑战码；没有时为 null。 */
  challengeCodeSeen: string | null;
  screenRecapture: { likely: boolean; confidence: number; cues: string[] };
  physicalPlausibility: { plausible: boolean; confidence: number; reason: string };
  screenshot: {
    isScreenshot: boolean;
    orderNumber: string | null;
    amount: number | null;
    chatLines: { speaker: 'merchant' | 'buyer' | 'unknown'; text: string }[];
  };
  /** 可疑区域，x y w h，取值 0–1。 */
  suspiciousRegion: { bbox: [number, number, number, number]; reason: string } | null;
}

export interface VisionContext {
  productTitle: string;
  material: string | null;
}

export interface VisionProvider {
  readonly name: string;
  extract(image: Buffer, mime: string, ctx: VisionContext): Promise<EvidenceAttributes>;
}

export interface TrackingEvent {
  at: string;
  description: string;
}

export interface TrackingResult {
  status: 'in_transit' | 'delivered' | 'unknown';
  events: TrackingEvent[];
  deliveredAt?: string;
  deliveredPostalCode?: string;
  deliveredCity?: string;
  weightG?: number;
}

export interface TrackingProvider {
  readonly name: string;
  track(carrier: string, trackingNumber: string): Promise<TrackingResult>;
}

export interface SyntheticDetector {
  readonly name: string;
  readonly weight: number;
  score(image: Buffer, mime: string): Promise<{ aiProbability: number; raw?: unknown }>;
}

export interface SyntheticCacheEntry {
  detectors: { name: string; weight: number; aiProbability: number }[];
}
