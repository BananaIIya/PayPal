import type {
  AnalyzerName,
  CategoryPolicy,
  ClaimType,
  EngineConfig,
  Layer,
  SourceMark,
  Strength,
} from './types';

export const RULES_VERSION = 'mvp-2026-11-08';

export const SOURCE_LAYER: Record<SourceMark, Layer> = {
  paypal_record: 'A',
  carrier_api: 'A',
  listing_snapshot: 'A',
  reference: 'A',
  live_capture: 'B',
  challenge_pending: 'C',
  paypal_dispute: 'C',
  uploaded: 'C',
  manual_import: 'C',
  narrative: 'D',
};

export const SOURCE_LABEL: Record<SourceMark, string> = {
  paypal_record: 'PayPal record',
  carrier_api: 'Carrier API',
  listing_snapshot: 'Listing snapshot at order time',
  reference: 'Shipment reference',
  live_capture: 'Challenge code verified',
  challenge_pending: 'Challenge capture, pending verification',
  paypal_dispute: 'PayPal dispute attachment',
  uploaded: 'Gallery upload',
  manual_import: 'Merchant manual import',
  narrative: 'Written statement',
};

export const DEFAULT_CONFIG: EngineConfig = {
  strengthWeight: { strong: 3, moderate: 1.5, weak: 0.5 },
  sourceWeight: {
    paypal_record: 1,
    carrier_api: 1,
    listing_snapshot: 1,
    reference: 1,
    live_capture: 1,
    challenge_pending: 0.6,
    paypal_dispute: 0.8,
    uploaded: 0.6,
    manual_import: 0.6,
    narrative: 0.3,
  },
  riskMedium: 1,
  riskHigh: 3,
  minDataConfidence: 0.5,
  merchantRiskHigh: 0.5,
};

/**
 * 开发文档“默认权重”表把证据层级的权重分成四档，设置页按这四档编辑，
 * 保存时展开成每个来源的权重。
 */
export const LAYER_WEIGHT_GROUPS = {
  ab: { label: 'Tiers A and B (system records, live capture)', sources: ['paypal_record', 'carrier_api', 'listing_snapshot', 'reference', 'live_capture'] },
  cPaypal: { label: 'Tier C: PayPal dispute attachments', sources: ['paypal_dispute'] },
  cUploaded: { label: 'Tier C: gallery uploads, merchant imports, unverified challenge captures', sources: ['uploaded', 'manual_import', 'challenge_pending'] },
  d: { label: 'Tier D: written statements', sources: ['narrative'] },
} as const satisfies Record<string, { label: string; sources: SourceMark[] }>;
export type LayerGroup = keyof typeof LAYER_WEIGHT_GROUPS;

export function layerWeights(cfg: EngineConfig): Record<LayerGroup, number> {
  return {
    ab: cfg.sourceWeight.live_capture,
    cPaypal: cfg.sourceWeight.paypal_dispute,
    cUploaded: cfg.sourceWeight.uploaded,
    d: cfg.sourceWeight.narrative,
  };
}

export function sourceWeightsFromLayers(layers: Record<LayerGroup, number>): Record<SourceMark, number> {
  const out = {} as Record<SourceMark, number>;
  for (const [group, def] of Object.entries(LAYER_WEIGHT_GROUPS) as [LayerGroup, (typeof LAYER_WEIGHT_GROUPS)[LayerGroup]][]) {
    for (const source of def.sources) out[source] = layers[group];
  }
  return out;
}

export function isDefaultConfig(cfg: EngineConfig): boolean {
  const d = DEFAULT_CONFIG;
  return (
    (Object.keys(d.strengthWeight) as Strength[]).every((k) => cfg.strengthWeight[k] === d.strengthWeight[k]) &&
    (Object.keys(d.sourceWeight) as SourceMark[]).every((k) => cfg.sourceWeight[k] === d.sourceWeight[k]) &&
    cfg.riskMedium === d.riskMedium &&
    cfg.riskHigh === d.riskHigh &&
    cfg.minDataConfidence === d.minDataConfidence &&
    cfg.merchantRiskHigh === d.merchantRiskHigh
  );
}

/** 写进审计记录的一行权重配置。早于这个字段的判定没有记录配置。 */
export function describeConfig(cfg: EngineConfig | undefined): string {
  if (!cfg) return 'No weight configuration was recorded for this verdict (predates editable settings)';
  const s = cfg.strengthWeight;
  const l = layerWeights(cfg);
  return [
    cfg.scope ? `Category config: ${CATEGORY_LABEL[cfg.scope] ?? cfg.scope}` : isDefaultConfig(cfg) ? 'Default config' : 'Custom merchant config',
    `Strength ${s.strong}/${s.moderate}/${s.weak}`,
    `Tiers ${l.ab}/${l.cPaypal}/${l.cUploaded}/${l.d}`,
    `Risk thresholds ${cfg.riskMedium}/${cfg.riskHigh}`,
    `Q≥${cfg.minDataConfidence}`,
    `M≥${cfg.merchantRiskHigh}`,
  ].join(' · ');
}

export const CATEGORY_LABEL: Record<string, string> = {
  ceramics: 'Ceramics',
  electronics: 'Electronics',
  apparel: 'Apparel',
  fresh: 'Fresh food',
  general: 'Other',
};

/**
 * 判定直接为高风险、不被其他信号抵消的强反驳信号。
 * 只收有索赔之外的记录可以核对的情况：历史证据、网上更早的图片、交易记录、消息库。
 * 未核验的来源声明还没核实签名。序列号不符也可能是仓库错发，不在这里；
 * 现场或系统记录里读到的明显不符，由引擎在数据置信度足够时单独升到高风险，动作仍是先排查错发。
 * 买家自己的多份证据互相矛盾没有外部反证，不能当成已确认滥用。
 * 例外是 AI_PROVENANCE_FOUND：文件自己声明整份内容由 AI 从零生成。签名同样没核验，
 * 但这种声明只会对提交者不利，不存在为了索赔而伪造它的动机。AI 修图仍然只是中风险下限。
 */
export const HARD_RULE_CODES = new Set([
  'IMAGE_FOUND_ONLINE',
  'EVIDENCE_REUSED_ACROSS_CLAIMS',
  'RECORD_NOT_FOUND',
  'SCREENSHOT_CONTENT_MISMATCH',
  'AI_PROVENANCE_FOUND',
]);

/**
 * 只要出现就把判定抬到中风险的信号。
 * 这是 MVP 对文档的补充：默认权重下，相册上传（r=0.6）的中等信号最多得 1.5×1×0.6=0.9，
 * 到不了中风险阈值 1.0，但验收场景要求“无水印 AI 生成”“陈述与画面冲突”“翻拍屏幕”是中风险。
 */
export const MEDIUM_FLOOR_CODES = new Set([
  'SYNTHETIC_LIKELY',
  'SCREEN_RECAPTURE',
  'NARRATIVE_EVIDENCE_CONFLICT',
  'CHALLENGE_MISMATCH',
  // 文档判定表把这两种情况明确列为中风险，不应该被一个弱支持信号抵消到低风险。
  'DELIVERED_CONFIRMED',
  'WEIGHT_MISMATCH',
  // 照片之间对不上要核对，但没有外部反证，不能靠硬规则判成已确认滥用。
  'CROSS_EVIDENCE_CONTRADICTION',
  // 未核验的 AI 来源声明不能单独判高风险，但也不能维持低风险并建议退款。
  'PROVENANCE_CLAIM_UNVERIFIED',
]);

export const CLAIM_TYPE_LABEL: Record<ClaimType, string> = {
  not_received: 'Not received',
  damaged: 'Damaged',
  not_as_described: 'Not as described',
  missing_items: 'Missing items or empty box',
  return: 'Return dispute',
};

export const SHOT_LABEL: Record<string, string> = {
  overall: 'Whole item',
  damage_closeup: 'Damage close-up',
  difference_closeup: 'Difference close-up',
  package: 'Outer packaging',
  label: 'Shipping label close-up',
  serial_closeup: 'Serial number close-up',
  contents: 'All box contents',
  chat_screenshot: 'Chat screenshot',
  receipt: 'Receipt or document',
};

export const SHOT_HINT: Record<string, string> = {
  overall: 'Fit the whole item in the frame, with good lighting',
  damage_closeup: 'Move close to the problem area so details are clear',
  difference_closeup: 'Clearly show what differs from the listing',
  package: 'Photograph the outer packaging with any damaged side facing the camera',
  label: 'Aim at the shipping label so the tracking number is readable',
  serial_closeup: 'Aim at the serial or batch number so the characters are readable',
  contents: 'Spread out everything in the box and capture it all in one shot',
};

const BASE_REQUIRED_SHOTS: Record<ClaimType, string[]> = {
  not_received: [],
  damaged: ['overall', 'damage_closeup', 'package', 'label'],
  not_as_described: ['overall', 'difference_closeup', 'label'],
  missing_items: ['package', 'label', 'contents'],
  return: ['overall', 'serial_closeup', 'package'],
};

export function requiredShots(type: ClaimType, policy: CategoryPolicy): string[] {
  const base = policy.requiredShots?.[type] ?? BASE_REQUIRED_SHOTS[type];
  const needsIdentity = policy.identityRequired && type !== 'not_received' && !base.includes('serial_closeup');
  return needsIdentity ? [...base, 'serial_closeup'] : base;
}

/** 开发文档“按索赔类型启用的分析器”。 */
export function applicableAnalyzers(
  type: ClaimType,
  ctx: { hasImages: boolean; hasScreenshots: boolean },
): AnalyzerName[] {
  const imageSet: AnalyzerName[] = ['provenance', 'synthetic', 'origin', 'consistency', 'plausibility'];
  const out: AnalyzerName[] = [];
  if (type === 'not_received') {
    if (ctx.hasImages) out.push(...imageSet);
    out.push('logistics', 'records', 'behavior');
  } else if (type === 'return') {
    out.push(...imageSet, 'reference', 'logistics', 'records', 'behavior');
  } else {
    out.push(...imageSet, 'reference', 'logistics');
    if (ctx.hasScreenshots) out.push('records');
    out.push('behavior');
  }
  return out;
}

/**
 * 关键分析器。组里有一个不可用或失败，判定就不能是低风险。
 * 不能要求整组都不可用：来源解析在本地总会跑完，检测器没接入时仍会剩低风险并建议退款。
 */
export function keyAnalyzerGroups(type: ClaimType): AnalyzerName[][] {
  if (type === 'not_received') return [['logistics']];
  if (type === 'missing_items' || type === 'return') return [['provenance', 'synthetic'], ['logistics']];
  return [['provenance', 'synthetic']];
}

export interface PropositionDef {
  id: string;
  label: string;
  key: boolean | ((ctx: { policy: CategoryPolicy; hasReference: boolean }) => boolean);
  holdsBy?: string[];
  refutedBy?: string[];
  /** 这些镜头都有 A、B 层证据时，命题成立。 */
  requiredShots?: string[];
  /** 该来源有证据时，命题成立。 */
  coveredBySources?: SourceMark[];
  /** 分析器跑完且没有反驳信号时，命题成立。 */
  holdsWhenClean?: AnalyzerName;
  /** 由类目策略直接决定。 */
  policyField?: 'returnable';
}

const identityKey = ({ policy, hasReference }: { policy: CategoryPolicy; hasReference: boolean }) =>
  policy.identityRequired || hasReference;

export const PROPOSITIONS: Record<ClaimType, PropositionDef[]> = {
  not_received: [
    {
      id: 'delivered',
      label: 'Package was delivered',
      key: true,
      holdsBy: ['DELIVERED_CONFIRMED', 'DELIVERY_ADDRESS_MISMATCH'],
      refutedBy: ['SHIPPED_BEFORE_ORDER'],
    },
    {
      id: 'address_match',
      label: 'Delivery address is the order address',
      key: true,
      holdsBy: ['DELIVERED_CONFIRMED'],
      refutedBy: ['DELIVERY_ADDRESS_MISMATCH'],
    },
    { id: 'buyer_obtained', label: 'Buyer actually obtained it (rules out proxy receipt, misdelivery, theft)', key: false },
    {
      id: 'receipt_statement',
      label: 'Later messages say the item was received',
      key: false,
      holdsBy: ['NARRATIVE_EVIDENCE_CONFLICT'],
    },
  ],
  damaged: [
    {
      id: 'damage_exists',
      label: 'Damage exists',
      key: true,
      requiredShots: ['damage_closeup'],
      refutedBy: ['PHYSICALLY_IMPLAUSIBLE', 'SCREEN_RECAPTURE', 'SYNTHETIC_LIKELY', 'AI_PROVENANCE_FOUND'],
    },
    {
      id: 'is_order_item',
      label: "Damaged item is this order's item",
      key: identityKey,
      holdsBy: ['IDENTITY_MATCH'],
      refutedBy: ['IDENTITY_MISMATCH', 'DETAIL_ALTERED', 'EVIDENCE_REUSED_ACROSS_CLAIMS'],
    },
    { id: 'damaged_at_delivery', label: 'Already damaged at delivery', key: false, requiredShots: ['package'] },
    {
      id: 'pattern_matches_shipping',
      label: 'Damage pattern fits the shipping method',
      key: false,
      holdsWhenClean: 'plausibility',
      refutedBy: ['PHYSICALLY_IMPLAUSIBLE', 'DAMAGE_CAUSE_MISMATCH'],
    },
    { id: 'suitable_for_return', label: 'Item is suitable for return', key: false, policyField: 'returnable' },
  ],
  not_as_described: [
    {
      id: 'matches_snapshot',
      label: 'Item matches the listing snapshot at order time',
      key: true,
      holdsBy: ['SNAPSHOT_MATCH', 'IDENTITY_MATCH'],
      refutedBy: ['SNAPSHOT_DIFFERENCE', 'IDENTITY_MISMATCH'],
    },
    { id: 'affects_core', label: 'Difference affects core function', key: false },
  ],
  missing_items: [
    {
      id: 'shipped_contents',
      label: 'Shipped contents and quantity',
      key: true,
      coveredBySources: ['reference'],
      refutedBy: ['WEIGHT_SHORTFALL'],
    },
    {
      id: 'weights_consistent',
      label: 'Package weight is consistent across checkpoints',
      key: true,
      holdsBy: ['WEIGHT_MISMATCH'],
      refutedBy: ['WEIGHT_SHORTFALL'],
    },
    { id: 'unboxing_continuous', label: 'Unboxing is continuous', key: false, requiredShots: ['contents'] },
  ],
  return: [
    {
      id: 'return_delivered',
      label: 'Return package was shipped and delivered',
      key: true,
      holdsBy: ['DELIVERED_CONFIRMED'],
      refutedBy: ['DELIVERY_ADDRESS_MISMATCH'],
    },
    {
      id: 'returned_is_original',
      label: 'Returned item is the original (serial number, weight, wear)',
      key: true,
      holdsBy: ['IDENTITY_MATCH'],
      refutedBy: ['IDENTITY_MISMATCH', 'WEIGHT_MISMATCH'],
    },
  ],
};

export const SIGNAL_TITLE: Record<string, string> = {
  AI_PROVENANCE_FOUND: 'File declares it was fully AI-generated',
  PROVENANCE_CLAIM_UNVERIFIED: 'Unverified provenance claim; original photo or more evidence needed',
  NO_PROVENANCE: 'No provenance credentials found',
  C2PA_MANIFEST_UNVERIFIED: 'Content credentials present, not marked as AI-generated',
  SYNTHETIC_LIKELY: 'High AI-generation detection score',
  DETECTORS_DISAGREE: 'Detectors disagree',
  CROSS_EVIDENCE_CONTRADICTION: 'Evidence items contradict each other',
  NARRATIVE_EVIDENCE_CONFLICT: 'Statement conflicts with evidence',
  CHALLENGE_MISSING: 'No challenge code found in frame',
  CHALLENGE_MISMATCH: 'Challenge code in frame does not match the one issued',
  CHALLENGE_MATCHED: 'Challenge code in frame matches the one issued',
  CHALLENGE_UNVERIFIED: 'Challenge code could not be verified',
  PHYSICALLY_IMPLAUSIBLE: 'Damage pattern is implausible for the material',
  SCREEN_RECAPTURE: 'Possibly photographed from a screen',
  DAMAGE_CAUSE_MISMATCH: 'Damage does not fit the claimed cause',
  IDENTITY_MISMATCH: 'Item identifiers do not match the shipment reference',
  DETAIL_ALTERED: 'Item details differ from the shipment reference',
  IDENTITY_MATCH: 'Item identifiers match the shipment reference',
  SNAPSHOT_DIFFERENCE: 'Item differs from the listing snapshot at order time',
  SNAPSHOT_MATCH: 'Item matches the listing snapshot at order time',
  SNAPSHOT_UNVERIFIED: 'Item cannot be checked against the listing snapshot',
  IMAGE_FOUND_ONLINE: 'Same image found online earlier',
  EVIDENCE_REUSED_ACROSS_CLAIMS: 'Same image appears in another claim',
  DELIVERED_CONFIRMED: 'Tracking shows delivered to the order address',
  DELIVERY_ADDRESS_UNVERIFIED: 'Delivered, but cannot confirm it was the order address',
  DELIVERY_ADDRESS_MISMATCH: 'Delivery address does not match the order address',
  SHIPPED_BEFORE_ORDER: 'Tracking events predate the order',
  TRACKING_NOT_DELIVERED: 'Tracking does not show delivery yet',
  TRACKING_STATUS_UNKNOWN: 'Tracking status unknown',
  WEIGHT_MISMATCH: "Weight does not match the buyer's claim",
  WEIGHT_SHORTFALL: 'Weight is below the expected item weight',
  RECORD_NOT_FOUND: 'Order on the document not found in transaction records',
  SCREENSHOT_CONTENT_MISMATCH: 'Screenshot does not match message history',
  HIGH_CLAIM_FREQUENCY: 'Buyer files claims unusually often',
  SCRIPTED_NARRATIVE: 'Claim text closely matches other claims',
  SKU_CLAIM_CLUSTER: 'Cluster of same-reason claims on one SKU',
  LINKED_ACCOUNTS: 'Other accounts share the shipping address',
  VIDEO_EDITED: 'Video was processed with editing software',
  VIDEO_DISCONTINUITY: 'Abrupt cuts in live-recorded video',
};

/** 每个强信号附上的常见正常解释（开发文档“处置约束”）。 */
export const NORMAL_EXPLANATIONS: Record<string, string[]> = {
  AI_PROVENANCE_FOUND: [
    'The buyer may have uploaded an AI-generated illustration by mistake instead of a real photo; you can give them one chance to resubmit the original photo',
    'The manifest signature has not been verified, but AI retouching is recorded as an edit, not as fully generated, and does not trigger this',
  ],
  PROVENANCE_CLAIM_UNVERIFIED: [
    'The buyer may have only used an AI tool to circle the defect; in that case, ask for the unedited original photo',
    'AI retouching and background removal in phone galleries also write this kind of label',
    'Manifests can be stripped by re-encoding, so the absence of this claim does not mean a photo is authentic',
  ],
  IDENTITY_MISMATCH: ['The warehouse may have shipped another unit of the same product', 'The reference or capture may have a scanning or recognition error'],
  EVIDENCE_REUSED_ACROSS_CLAIMS: ['The same buyer may be adding material to the same after-sales case', "The image may be the merchant's own asset"],
  IMAGE_FOUND_ONLINE: ["The image may come from the merchant's own product photos", 'The buyer may have used an online image for illustration'],
  CROSS_EVIDENCE_CONTRADICTION: ['The photos may have been taken at different times or of different packages', 'Video edits may be for privacy or file compression'],
  RECORD_NOT_FOUND: ['The buyer may have mistyped the order number', 'The order may be from another store or account'],
  SCREENSHOT_CONTENT_MISMATCH: ['The conversation may have happened on a channel not connected to the message store, such as personal email', 'An agent may have replied to the buyer in another system'],
  DELIVERED_CONFIRMED: ['Delivery only proves delivery status: it could be proxy receipt, misdelivery, or theft', "Check the buyer's later messages to judge whether they actually got it"],
  DELIVERY_ADDRESS_MISMATCH: ['The recipient may have changed the address or chosen a pickup point', "The carrier's postal code record may be wrong"],
  SYNTHETIC_LIKELY: ['Detectors produce false positives; compression, heavy noise reduction, or beauty filters can also raise the score'],
  SCREEN_RECAPTURE: ['The buyer may have viewed the original on a computer and photographed the screen; ask them to photograph the item directly'],
  NARRATIVE_EVIDENCE_CONFLICT: ['The buyer may have described it inaccurately, or opened it to look before taking photos'],
  WEIGHT_MISMATCH: ['Packaging materials and scale error cause differences', 'Contents may also have been lost in transit after shipping'],
  HIGH_CLAIM_FREQUENCY: ['Bulk buyers naturally file more after-sales requests'],
  LINKED_ACCOUNTS: ['Shared delivery to a household, dorm, or office is normal; treat this as a lead only'],
  VIDEO_EDITED: ['Video edits may be for privacy or file compression', 'Some phone gallery export and compression features also write a software name'],
  VIDEO_DISCONTINUITY: ['Fast camera movement, occlusion, or sudden lighting changes can also register as scene cuts', 'Compare the extracted frames to confirm it is the same item before and after'],
};

export const STRENGTH_LABEL: Record<Strength, string> = { strong: 'strong', moderate: 'moderate', weak: 'weak' };

export const ANALYZER_LABEL: Record<AnalyzerName, { name: string; what: string }> = {
  provenance: { name: 'Provenance', what: 'Content credentials, AI labels, and video edit traces' },
  synthetic: { name: 'Synthetic', what: 'AI-generation detectors' },
  origin: { name: 'Origin', what: 'Prior evidence and reverse image search' },
  consistency: { name: 'Consistency', what: 'Cross-evidence and statement comparison' },
  plausibility: { name: 'Plausibility', what: 'Physical plausibility and screen recapture' },
  reference: { name: 'Reference', what: 'Shipment reference and listing snapshot comparison' },
  logistics: { name: 'Logistics', what: 'Tracking and weight' },
  records: { name: 'Records', what: 'Transaction and message record checks' },
  behavior: { name: 'Behavior', what: 'Buyer history and clustering' },
};

export const LEVEL_LABEL = { low: 'Low risk', medium: 'Medium risk', high: 'High risk', insufficient: 'Insufficient evidence' } as const;

export const STATUS_LABEL = {
  collecting: 'Waiting for buyer',
  analyzing: 'Analyzing',
  awaiting_decision: 'Awaiting decision',
  action_sent: 'Action sent',
  closed: 'Closed',
} as const;

export const ORIGIN_LABEL = { paypal_dispute: 'PayPal dispute', portal: 'Claim page', manual_import: 'Manual import' } as const;
