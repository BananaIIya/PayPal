import type {
  AnalyzerName,
  CategoryPolicy,
  ClaimType,
  EngineConfig,
  Layer,
  SourceMark,
  Strength,
} from './types';

export const RULES_VERSION = 'mvp-2026-11-04';

export const SOURCE_LAYER: Record<SourceMark, Layer> = {
  paypal_record: 'A',
  carrier_api: 'A',
  listing_snapshot: 'A',
  reference: 'A',
  live_capture: 'B',
  paypal_dispute: 'C',
  uploaded: 'C',
  manual_import: 'C',
  narrative: 'D',
};

export const SOURCE_LABEL: Record<SourceMark, string> = {
  paypal_record: 'PayPal 记录',
  carrier_api: '物流接口',
  listing_snapshot: '下单时商品快照',
  reference: '商家留底',
  live_capture: '现场拍摄',
  paypal_dispute: 'PayPal 争议附件',
  uploaded: '相册上传',
  manual_import: '商家手动导入',
  narrative: '文字陈述',
};

export const DEFAULT_CONFIG: EngineConfig = {
  strengthWeight: { strong: 3, moderate: 1.5, weak: 0.5 },
  sourceWeight: {
    paypal_record: 1,
    carrier_api: 1,
    listing_snapshot: 1,
    reference: 1,
    live_capture: 1,
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
  ab: { label: 'A、B 层（系统记录、现场拍摄）', sources: ['paypal_record', 'carrier_api', 'listing_snapshot', 'reference', 'live_capture'] },
  cPaypal: { label: 'C 层：PayPal 争议附件', sources: ['paypal_dispute'] },
  cUploaded: { label: 'C 层：相册上传、商家导入', sources: ['uploaded', 'manual_import'] },
  d: { label: 'D 层：文字陈述', sources: ['narrative'] },
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
  if (!cfg) return '这次判定没有记录权重配置（早于设置页可编辑的版本）';
  const s = cfg.strengthWeight;
  const l = layerWeights(cfg);
  return [
    isDefaultConfig(cfg) ? '默认配置' : '商家自定义',
    `强度 ${s.strong}/${s.moderate}/${s.weak}`,
    `层级 ${l.ab}/${l.cPaypal}/${l.cUploaded}/${l.d}`,
    `风险阈值 ${cfg.riskMedium}/${cfg.riskHigh}`,
    `Q≥${cfg.minDataConfidence}`,
    `M≥${cfg.merchantRiskHigh}`,
  ].join(' · ');
}

export const CATEGORY_LABEL: Record<string, string> = {
  ceramics: '陶瓷',
  electronics: '电子产品',
  apparel: '服装',
  fresh: '生鲜',
  general: '其他',
};

/** 判定直接为高风险、不被其他信号抵消的强反驳信号（开发文档“计算步骤·硬规则”）。 */
export const HARD_RULE_CODES = new Set([
  'AI_PROVENANCE_FOUND',
  'IDENTITY_MISMATCH',
  'IMAGE_FOUND_ONLINE',
  'EVIDENCE_REUSED_ACROSS_CLAIMS',
  'RECORD_NOT_FOUND',
  'SCREENSHOT_CONTENT_MISMATCH',
  'CROSS_EVIDENCE_CONTRADICTION',
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
]);

export const CLAIM_TYPE_LABEL: Record<ClaimType, string> = {
  not_received: '未收到货',
  damaged: '损坏',
  not_as_described: '与描述不符',
  missing_items: '少件或空箱',
  return: '退货纠纷',
};

export const SHOT_LABEL: Record<string, string> = {
  overall: '商品整体照',
  damage_closeup: '损坏部位近景',
  difference_closeup: '差异部位近景',
  package: '外包装',
  label: '面单特写',
  serial_closeup: '序列号特写',
  contents: '箱内全部物品',
  chat_screenshot: '聊天截图',
  receipt: '收据或单据',
};

export const SHOT_HINT: Record<string, string> = {
  overall: '把商品完整放进取景框，光线充足',
  damage_closeup: '靠近问题部位拍摄，让细节清晰',
  difference_closeup: '拍清与商品描述不一致的地方',
  package: '拍外包装，有破损的面朝向镜头',
  label: '对准物流面单，让单号可读',
  serial_closeup: '对准序列号或批次号，让字符可读',
  contents: '把箱内所有物品摊开，一次拍全',
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

/** 这组分析器全部不可用时，判定不能是低风险（开发文档“未执行检查”）。 */
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
      label: '包裹是否已交付',
      key: true,
      holdsBy: ['DELIVERED_CONFIRMED', 'DELIVERY_ADDRESS_MISMATCH'],
      refutedBy: ['SHIPPED_BEFORE_ORDER', 'TRACKING_NOT_DELIVERED'],
    },
    {
      id: 'address_match',
      label: '签收地址是否为订单地址',
      key: true,
      holdsBy: ['DELIVERED_CONFIRMED'],
      refutedBy: ['DELIVERY_ADDRESS_MISMATCH', 'TRACKING_NOT_DELIVERED'],
    },
    { id: 'buyer_obtained', label: '买家是否实际取得（排除代收、投递错误、被盗）', key: false },
    {
      id: 'receipt_statement',
      label: '后续消息中是否出现已收货的表述',
      key: false,
      holdsBy: ['NARRATIVE_EVIDENCE_CONFLICT'],
    },
  ],
  damaged: [
    {
      id: 'damage_exists',
      label: '损坏是否存在',
      key: true,
      requiredShots: ['damage_closeup'],
      refutedBy: ['PHYSICALLY_IMPLAUSIBLE', 'SCREEN_RECAPTURE', 'AI_PROVENANCE_FOUND', 'SYNTHETIC_LIKELY'],
    },
    {
      id: 'is_order_item',
      label: '受损物是否为本订单商品',
      key: identityKey,
      holdsBy: ['IDENTITY_MATCH'],
      refutedBy: ['IDENTITY_MISMATCH', 'DETAIL_ALTERED', 'EVIDENCE_REUSED_ACROSS_CLAIMS'],
    },
    { id: 'damaged_at_delivery', label: '交付时是否已经损坏', key: false, requiredShots: ['package'] },
    {
      id: 'pattern_matches_shipping',
      label: '损坏形态与运输方式是否吻合',
      key: false,
      holdsWhenClean: 'plausibility',
      refutedBy: ['PHYSICALLY_IMPLAUSIBLE', 'DAMAGE_CAUSE_MISMATCH'],
    },
    { id: 'suitable_for_return', label: '商品是否适宜退回', key: false, policyField: 'returnable' },
  ],
  not_as_described: [
    {
      id: 'matches_snapshot',
      label: '实物与下单时商品快照是否一致',
      key: true,
      holdsBy: ['SNAPSHOT_MATCH', 'IDENTITY_MATCH'],
      refutedBy: ['SNAPSHOT_DIFFERENCE', 'IDENTITY_MISMATCH'],
    },
    { id: 'affects_core', label: '差异是否影响核心功能', key: false },
  ],
  missing_items: [
    {
      id: 'shipped_contents',
      label: '发货内容与数量',
      key: true,
      coveredBySources: ['reference'],
      refutedBy: ['WEIGHT_SHORTFALL'],
    },
    {
      id: 'weights_consistent',
      label: '各节点包裹重量是否一致',
      key: true,
      holdsBy: ['WEIGHT_MISMATCH'],
      refutedBy: ['WEIGHT_SHORTFALL'],
    },
    { id: 'unboxing_continuous', label: '开箱过程是否连续', key: false, requiredShots: ['contents'] },
  ],
  return: [
    {
      id: 'return_delivered',
      label: '退回包裹是否寄出并送达',
      key: true,
      holdsBy: ['DELIVERED_CONFIRMED'],
      refutedBy: ['DELIVERY_ADDRESS_MISMATCH', 'TRACKING_NOT_DELIVERED'],
    },
    {
      id: 'returned_is_original',
      label: '退回物是否为原商品（序列号、重量、磨损）',
      key: true,
      holdsBy: ['IDENTITY_MATCH'],
      refutedBy: ['IDENTITY_MISMATCH', 'WEIGHT_MISMATCH'],
    },
  ],
};

export const SIGNAL_TITLE: Record<string, string> = {
  AI_PROVENANCE_FOUND: '文件带有 AI 生成标识',
  NO_PROVENANCE: '未发现来源凭证',
  C2PA_MANIFEST_UNVERIFIED: '存在内容凭证，未判定为 AI 生成',
  SYNTHETIC_LIKELY: 'AI 生成检测概率偏高',
  DETECTORS_DISAGREE: '检测器之间结论分歧',
  CROSS_EVIDENCE_CONTRADICTION: '多份证据之间相互矛盾',
  NARRATIVE_EVIDENCE_CONFLICT: '文字陈述与证据不一致',
  CHALLENGE_MISSING: '画面中没有识别到挑战码',
  CHALLENGE_MISMATCH: '画面中的挑战码与下发的不符',
  PHYSICALLY_IMPLAUSIBLE: '损坏形态不符合材料常识',
  SCREEN_RECAPTURE: '疑似对着屏幕翻拍',
  DAMAGE_CAUSE_MISMATCH: '损坏与声称原因不吻合',
  IDENTITY_MISMATCH: '商品身份特征与留底不符',
  DETAIL_ALTERED: '商品细节与留底有差异',
  IDENTITY_MATCH: '商品身份特征与留底一致',
  SNAPSHOT_DIFFERENCE: '实物与下单时快照有差异',
  SNAPSHOT_MATCH: '实物与下单时快照一致',
  IMAGE_FOUND_ONLINE: '网上存在更早的相同图片',
  EVIDENCE_REUSED_ACROSS_CLAIMS: '同一张图出现在其他索赔中',
  DELIVERED_CONFIRMED: '物流显示已签收到订单地址',
  DELIVERY_ADDRESS_MISMATCH: '签收地址与订单地址不一致',
  SHIPPED_BEFORE_ORDER: '物流事件早于下单时间',
  TRACKING_NOT_DELIVERED: '物流尚未显示签收',
  WEIGHT_MISMATCH: '称重与买家声称的内容不符',
  WEIGHT_SHORTFALL: '称重低于商品理论重量',
  RECORD_NOT_FOUND: '单据中的订单在交易记录里查不到',
  SCREENSHOT_CONTENT_MISMATCH: '截图内容与消息记录不符',
  HIGH_CLAIM_FREQUENCY: '该买家索赔频率偏高',
  SCRIPTED_NARRATIVE: '索赔文本与其他索赔高度相似',
  SKU_CLAIM_CLUSTER: '同 SKU 同理由索赔聚集',
  LINKED_ACCOUNTS: '存在共用收货地址的账户',
};

/** 每个强信号附上的常见正常解释（开发文档“处置约束”）。 */
export const NORMAL_EXPLANATIONS: Record<string, string[]> = {
  AI_PROVENANCE_FOUND: [
    '买家可能只是用 AI 工具圈出了瑕疵位置，此时请买家提供未经编辑的原图',
    '手机相册的 AI 修图、去背景等功能也会写入这类标识',
  ],
  IDENTITY_MISMATCH: ['仓库可能错发了同款的另一件商品', '留底或拍摄时可能存在扫描、识别错误'],
  EVIDENCE_REUSED_ACROSS_CLAIMS: ['同一买家可能在补充同一笔售后的材料', '图片也可能是商家自有素材'],
  IMAGE_FOUND_ONLINE: ['图片可能来自商家自己发布的商品图', '买家可能引用了网上的图片作说明'],
  CROSS_EVIDENCE_CONTRADICTION: ['多张图可能拍摄于不同时间或不同包裹', '视频剪辑可能是为了保护隐私或压缩文件'],
  RECORD_NOT_FOUND: ['买家可能输错了订单号', '订单可能来自其他店铺或其他账户'],
  SCREENSHOT_CONTENT_MISMATCH: ['对话可能发生在消息库未接入的渠道，例如私人邮箱', '客服可能在其他系统中答复过买家'],
  DELIVERED_CONFIRMED: ['签收只证明交付状态：可能是代收、投递错误或被盗', '请结合买家后续消息判断是否实际取得'],
  DELIVERY_ADDRESS_MISMATCH: ['收件人可能改过地址或选择了自提点', '物流公司的邮编记录可能有误'],
  SYNTHETIC_LIKELY: ['检测器存在误报，压缩、强降噪或美颜也可能抬高分数'],
  SCREEN_RECAPTURE: ['买家可能在电脑上查看原图后转拍，请其直接拍摄实物'],
  NARRATIVE_EVIDENCE_CONFLICT: ['买家可能描述不准确，或在拍摄前已经打开查看'],
  WEIGHT_MISMATCH: ['包装材料和称重误差会造成差异', '发货后也可能在运输途中丢失内件'],
  HIGH_CLAIM_FREQUENCY: ['批量采购的买家售后次数自然更多'],
  LINKED_ACCOUNTS: ['家庭、宿舍、公司集中收货属正常情况，只作线索'],
};

export const STRENGTH_LABEL: Record<Strength, string> = { strong: '强', moderate: '中', weak: '弱' };

export const ANALYZER_LABEL: Record<AnalyzerName, { name: string; what: string }> = {
  provenance: { name: 'Provenance', what: '内容凭证与 AI 标识' },
  synthetic: { name: 'Synthetic', what: 'AI 生成检测器' },
  origin: { name: 'Origin', what: '历史证据与反向搜图' },
  consistency: { name: 'Consistency', what: '跨证据与陈述比对' },
  plausibility: { name: 'Plausibility', what: '物理常识与翻拍' },
  reference: { name: 'Reference', what: '留底与商品快照比对' },
  logistics: { name: 'Logistics', what: '物流轨迹与称重' },
  records: { name: 'Records', what: '交易与消息记录核对' },
  behavior: { name: 'Behavior', what: '买家历史与聚集度' },
};

export const LEVEL_LABEL = { low: '低风险', medium: '中风险', high: '高风险', insufficient: '证据不足' } as const;

export const STATUS_LABEL = {
  collecting: '等待买家提交',
  analyzing: '分析中',
  awaiting_decision: '待商家决定',
  action_sent: '动作已发送',
  closed: '已结案',
} as const;

export const ORIGIN_LABEL = { paypal_dispute: 'PayPal 争议', portal: '索赔页', manual_import: '手动导入' } as const;
