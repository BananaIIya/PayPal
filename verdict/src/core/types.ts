// 核验管线与判定引擎共用的类型。这个目录不做任何 IO，也不依赖 PayPal 客户端。

export const ANALYZERS = [
  'provenance',
  'synthetic',
  'origin',
  'consistency',
  'plausibility',
  'reference',
  'logistics',
  'records',
  'behavior',
] as const;
export type AnalyzerName = (typeof ANALYZERS)[number];

export type ClaimType = 'not_received' | 'damaged' | 'not_as_described' | 'missing_items' | 'return';
export type ClaimOrigin = 'paypal_dispute' | 'portal' | 'manual_import';
export type ClaimStatus = 'collecting' | 'analyzing' | 'awaiting_decision' | 'action_sent' | 'closed';

export type SourceMark =
  | 'paypal_record'
  | 'carrier_api'
  | 'listing_snapshot'
  | 'reference'
  | 'live_capture'
  | 'paypal_dispute'
  | 'uploaded'
  | 'manual_import'
  | 'narrative';
export type Layer = 'A' | 'B' | 'C' | 'D';

export type Direction = 'contradicts_claim' | 'supports_claim' | 'neutral';
export type Strength = 'strong' | 'moderate' | 'weak';
export type BBox = [number, number, number, number]; // x, y, w, h，取值 0–1，相对图片尺寸

export interface Signal {
  id: string;
  analyzer: AnalyzerName;
  code: string;
  direction: Direction;
  strength: Strength;
  confidence: number;
  evidenceIds: string[];
  /** 信号所依据证据的来源，决定公式里的 r。 */
  basisSource: SourceMark;
  region?: { evidenceId: string; bbox: BBox };
  explanation: string;
  raw?: unknown;
  provider?: string;
}

export interface EvidenceRef {
  id: string;
  source: SourceMark;
  layer: Layer;
  shotLabel: string | null;
}

export type RunStatus = 'queued' | 'running' | 'done' | 'unavailable' | 'failed';
export interface AnalyzerRun {
  analyzer: AnalyzerName;
  status: RunStatus;
  error?: string | null;
  note?: string | null;
}

export type VerdictLevel = 'low' | 'medium' | 'high' | 'insufficient';
export type ActionType =
  | 'refund'
  | 'accept_claim'
  | 'send_message'
  | 'provide_evidence'
  | 'make_offer'
  | 'escalate'
  /** UNDER_REVIEW 时向 PayPal 追加说明。 */
  | 'provide_supporting_info'
  /** 退货纠纷中确认收到（或没收到）买家退回的包裹。 */
  | 'acknowledge_return_item'
  /** PayPal 判买家胜诉后申诉。 */
  | 'appeal';

/** acknowledge-return-item 的 acknowledgement_type。 */
export const RETURN_ACK_TYPES = ['ITEM_RECEIVED', 'ITEM_NOT_RECEIVED', 'DAMAGED', 'EMPTY_PACKAGE_OR_DIFFERENT', 'MISSING_ITEMS'] as const;
export type ReturnAckType = (typeof RETURN_ACK_TYPES)[number];

export interface CategoryPolicy {
  category: string;
  returnable: boolean;
  perishable: boolean;
  safetySensitive: boolean;
  identityRequired: boolean;
  /** 覆盖默认的必需镜头，键为索赔类型。 */
  requiredShots?: Partial<Record<ClaimType, string[]>>;
}

export interface MerchantRiskFactors {
  /** 同 SKU 索赔率相对店铺基线的偏离，0–1。 */
  skuDeviation: number;
  batchConfirmedIssue: boolean;
  listingChangedAfterOrder: boolean;
  missingReferenceOrWeight: boolean;
}

export interface EngineConfig {
  strengthWeight: Record<Strength, number>;
  sourceWeight: Record<SourceMark, number>;
  riskMedium: number;
  riskHigh: number;
  /** 文档只写“Q 充足”，未给数值；MVP 取 0.5，可配置。 */
  minDataConfidence: number;
  /** 文档只写“M 高”，未给数值；MVP 取 0.5，可配置。 */
  merchantRiskHigh: number;
}

export interface EngineInput {
  claim: {
    type: ClaimType;
    hasDispute: boolean;
    amount: number;
    currency: string;
    /** 时间线显示商家已同意退款，或买家已接受和解。 */
    alreadyAgreed: boolean;
    trackingNumber?: string | null;
    carrier?: string | null;
  };
  policy: CategoryPolicy;
  signals: Signal[];
  evidence: EvidenceRef[];
  /** 本索赔适用的分析器的运行状态。 */
  runs: AnalyzerRun[];
  hasReference: boolean;
  merchantFactors: MerchantRiskFactors;
  config: EngineConfig;
}

export type PropositionStatus = 'holds' | 'refuted' | 'insufficient';
export interface PropositionResult {
  id: string;
  label: string;
  key: boolean;
  status: PropositionStatus;
  supportingSignalIds: string[];
  refutingSignalIds: string[];
  layers: Layer[];
  note?: string;
}

export interface Finding {
  signalIds: string[];
  code: string;
  title: string;
  explanation: string;
  analyzer: AnalyzerName;
  direction: Direction;
  strength: Strength;
  confidence: number;
  contribution: number;
  evidenceIds: string[];
  region?: { evidenceId: string; bbox: BBox };
  normalExplanations: string[];
  provider?: string;
  hardRule: boolean;
}

export interface SuggestedAction {
  type: ActionType | 'none';
  label: string;
  reason: string;
  /** 将调用的 PayPal 操作，用于确认框展示。 */
  paypalOperation: string | null;
  message?: string;
  notes?: string;
  evidenceType?: 'OTHER' | 'PROOF_OF_FULFILLMENT';
  offerAmount?: number;
  refundAmount?: number;
  trackingNumber?: string;
  carrier?: string;
  attachEvidence?: boolean;
  /** 附核验报告 PDF（provide_evidence、appeal）。 */
  attachReport?: boolean;
  acknowledgementType?: ReturnAckType;
}

export interface VerdictReport {
  level: VerdictLevel;
  score: number;
  dataConfidence: number;
  merchantRisk: number;
  incomplete: boolean;
  qualityNotice: boolean;
  headline: string;
  decisionNeeded: string;
  notices: string[];
  primaryAction: SuggestedAction;
  alternatives: SuggestedAction[];
  propositions: PropositionResult[];
  missingShots: string[];
  lowTierShots: string[];
  findings: Finding[];
  topSignalIds: string[];
  notRun: { analyzer: AnalyzerName; status: RunStatus; reason: string }[];
  ruleTrace: string[];
  merchantFactors: MerchantRiskFactors;
  rulesVersion: string;
}
