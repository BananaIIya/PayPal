// 九个分析器。每个只输出结构化信号，不下结论，也不接触 PayPal 写接口。
// 买家陈述和图片里的文字在这里只被当作数据比较，不会进入任何判定指令。

import type { AnalyzerName, BBox, ClaimType, Direction, Signal, SourceMark, Strength } from '@/core/types';
import { extractAttributes, syntheticScores } from '@/providers/registry';
import type { TrackingProvider, TrackingResult } from '@/providers/types';
import { ProviderUnavailable } from '@/providers/types';
import { hammingDistance, isInformativeHash, readFile, REUSE_DISTANCE } from '@/server/storage';
import { scanProvenance } from './provenance-scan';

export interface EvidenceRow {
  id: string;
  claim_id: string | null;
  order_id: string;
  source: SourceMark;
  sha256: string;
  dhash: string | null;
  layer: string;
  mime_type: string;
  shot_label: string | null;
  challenge_id: string | null;
  created_at: string;
  /** 原件按保留期删除的时间。删除后不能再读文件。 */
  purged_at?: string | null;
}

export interface OrderItem {
  sku: string;
  title: string;
  quantity: number;
  material?: string;
  color?: string;
  model?: string;
  weightG?: number;
}

export interface OrderView {
  id: string;
  merchantId: string;
  orderNo: string;
  buyerEmailHash: string | null;
  shipAddress: { city?: string; postalCode?: string; line1?: string } | null;
  items: OrderItem[];
  listingSnapshot: { title?: string; description?: string; color?: string; model?: string } | null;
  amount: number;
  carrier: string | null;
  trackingNumber: string | null;
  shippedWeightG: number | null;
  createdAt: string;
}

export interface OtherEvidence {
  id: string;
  claim_id: string | null;
  order_id: string;
  dhash: string | null;
  sha256: string;
  created_at: string;
  order_no: string;
}

export interface AnalyzerContext {
  claim: { id: string; type: ClaimType; narrative: string | null; createdAt: string };
  order: OrderView;
  evidence: EvidenceRow[];
  references: EvidenceRow[];
  challenges: Map<string, { code: string; action: string }>;
  messages: { sender: 'merchant' | 'buyer'; text: string; created_at: string }[];
  merchantEvidence: OtherEvidence[];
  knownOrderNumbers: Set<string>;
  tracking: TrackingProvider;
  behavior: {
    buyerClaims: number;
    similarNarrative: { orderNo: string; similarity: number } | null;
    skuReasonClaims: number;
    linkedAccounts: number;
  };
  offline: boolean;
}

export type SignalDraft = Omit<Signal, 'id' | 'analyzer'>;
export type AnalyzerResult =
  | { status: 'done'; signals: SignalDraft[]; note?: string }
  | { status: 'unavailable'; reason: string };

const LAYER_RANK: Record<SourceMark, number> = {
  narrative: 0,
  uploaded: 1,
  manual_import: 1,
  paypal_dispute: 2,
  live_capture: 3,
  reference: 4,
  listing_snapshot: 4,
  carrier_api: 4,
  paypal_record: 4,
};

/** 多份证据支撑同一信号时取最弱的来源，对买家更保守。 */
function weakestSource(rows: { source: SourceMark }[]): SourceMark {
  return rows.reduce((w, r) => (LAYER_RANK[r.source] < LAYER_RANK[w] ? r.source : w), rows[0].source);
}

function signal(
  code: string,
  direction: Direction,
  strength: Strength,
  confidence: number,
  rows: { id: string; source: SourceMark }[],
  basis: SourceMark | null,
  explanation: string,
  extra: { region?: { evidenceId: string; bbox: BBox }; raw?: unknown; provider?: string } = {},
): SignalDraft {
  return {
    code,
    direction,
    strength,
    confidence,
    evidenceIds: rows.map((r) => r.id),
    basisSource: basis ?? weakestSource(rows),
    explanation,
    ...extra,
  };
}

function productContext(ctx: AnalyzerContext) {
  const item = ctx.order.items[0];
  return { productTitle: item?.title ?? '未知商品', material: item?.material ?? null };
}

async function attributesFor(rows: EvidenceRow[], ctx: AnalyzerContext) {
  return Promise.all(
    rows.map(async (row) => {
      const { attrs, provider } = await extractAttributes(row, () => readFile(row.sha256), productContext(ctx), {
        offline: ctx.offline,
      });
      return { row, attrs, provider };
    }),
  );
}

function providerLabel(list: { provider: string }[]): string {
  return [...new Set(list.map((x) => x.provider))].join(', ');
}

/** 把易混字符归一，降低 OCR 错误造成硬规则误报的概率。 */
export function normalizeSerial(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/S/g, '5')
    .replace(/B/g, '8');
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
/** 比对聊天内容时忽略空白和标点，OCR 的细微差异不应该变成硬规则信号。 */
const normText = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

// ---------- Provenance ----------
async function provenance(ctx: AnalyzerContext): Promise<AnalyzerResult> {
  const signals: SignalDraft[] = [];
  const clean: EvidenceRow[] = [];
  for (const row of ctx.evidence) {
    const scan = scanProvenance(readFile(row.sha256), row.mime_type);
    if (scan.aiSourceType || scan.aigcLabel) {
      const what = scan.aigcLabel && !scan.aiSourceType ? 'AI 生成隐式标识（GB 45438）' : 'C2PA 清单声明的 AI 生成来源';
      signals.push(
        signal(
          'AI_PROVENANCE_FOUND',
          'contradicts_claim',
          'strong',
          0.95,
          [row],
          null,
          `文件元数据中包含${what}${scan.generator ? `，生成工具：${scan.generator}` : ''}。`,
          { raw: scan, provider: '本地解析' },
        ),
      );
    } else if (scan.c2paManifest) {
      signals.push(
        signal('C2PA_MANIFEST_UNVERIFIED', 'neutral', 'weak', 0.5, [row], null, '文件带有 C2PA 清单，未声明 AI 生成来源；当前版本未校验签名。', {
          raw: scan,
          provider: '本地解析',
        }),
      );
    } else {
      clean.push(row);
    }
  }
  if (clean.length) {
    signals.push(
      signal('NO_PROVENANCE', 'neutral', 'weak', 1, clean, null, `${clean.length} 份证据未发现来源凭证。未检出不等于真实，只代表缺少这一信号。`, {
        provider: '本地解析',
      }),
    );
  }
  return { status: 'done', signals, note: '仅解析 C2PA 与隐式标识是否存在，未校验签名；SynthID 未接入' };
}

// ---------- Synthetic ----------
async function synthetic(ctx: AnalyzerContext): Promise<AnalyzerResult> {
  const scored = ctx.evidence.map((row) => ({ row, hit: syntheticScores(row.sha256) }));
  const missing = scored.filter((s) => !s.hit);
  if (missing.length) {
    return { status: 'unavailable', reason: '未接入 AI 生成检测器（Hive、Sightengine、AI or Not）' };
  }
  const signals: SignalDraft[] = [];
  for (const { row, hit } of scored) {
    const dets = hit!.entry.detectors;
    const totalWeight = dets.reduce((a, d) => a + d.weight, 0);
    const avg = dets.reduce((a, d) => a + d.aiProbability * d.weight, 0) / totalWeight;
    const spread = Math.max(...dets.map((d) => d.aiProbability)) - Math.min(...dets.map((d) => d.aiProbability));
    if (spread >= 0.4) {
      signals.push(
        signal('DETECTORS_DISAGREE', 'neutral', 'weak', spread, [row], null, `检测器之间分歧较大（相差 ${(spread * 100).toFixed(0)}%），结果仅供参考。`, {
          raw: dets,
          provider: hit!.provider,
        }),
      );
    }
    if (avg >= 0.7) {
      signals.push(
        signal('SYNTHETIC_LIKELY', 'contradicts_claim', 'moderate', Math.round(avg * 100) / 100, [row], null, `AI 生成检测器加权概率为 ${(avg * 100).toFixed(0)}%。检测器可能误报，不能单独作为结论。`, {
          raw: dets,
          provider: hit!.provider,
        }),
      );
    }
  }
  return { status: 'done', signals };
}

// ---------- Origin ----------
async function origin(ctx: AnalyzerContext): Promise<AnalyzerResult> {
  const signals: SignalDraft[] = [];
  for (const row of ctx.evidence) {
    if (!row.dhash) continue;
    const match = ctx.merchantEvidence.find(
      (o) =>
        o.id !== row.id &&
        o.dhash &&
        // 同一索赔或同一订单内的补充材料不算复用；只和更早的证据比。
        o.claim_id !== row.claim_id &&
        o.order_id !== row.order_id &&
        o.created_at < row.created_at &&
        (o.sha256 === row.sha256 ||
          (isInformativeHash(o.dhash) && isInformativeHash(row.dhash!) && hammingDistance(o.dhash, row.dhash!) <= REUSE_DISTANCE)),
    );
    if (match) {
      const distance = hammingDistance(match.dhash!, row.dhash);
      signals.push(
        signal(
          'EVIDENCE_REUSED_ACROSS_CLAIMS',
          'contradicts_claim',
          'strong',
          distance === 0 ? 0.99 : Math.max(0.8, 1 - distance / 120),
          [row],
          null,
          `这张图与订单 ${match.order_no} 的历史证据高度相似（感知哈希差异 ${distance}/256），可能套用了其他订单的照片。`,
          {
            raw: { matchedEvidenceId: match.id, matchedOrder: match.order_no, hammingDistance: distance },
            provider: '本地感知哈希',
            region: { evidenceId: row.id, bbox: [0.02, 0.02, 0.96, 0.96] },
          },
        ),
      );
    }
  }
  return { status: 'done', signals, note: '已比对本商家历史证据；反向搜图未接入' };
}

// ---------- Consistency ----------
const UNOPENED_RE = /未拆封|没拆|没有拆|没打开|没有打开|还没开箱|未开封|未开箱|unopened|sealed/i;

async function consistency(ctx: AnalyzerContext): Promise<AnalyzerResult> {
  const items = await attributesFor(ctx.evidence, ctx);
  const provider = providerLabel(items);
  const signals: SignalDraft[] = [];

  const withSerial = items.filter((i) => i.attrs.serialNumber);
  const serials = new Set(withSerial.map((i) => normalizeSerial(i.attrs.serialNumber!)));
  if (serials.size > 1) {
    signals.push(
      signal(
        'CROSS_EVIDENCE_CONTRADICTION',
        'contradicts_claim',
        'strong',
        0.92,
        withSerial.map((i) => i.row),
        null,
        `同一索赔的多份证据中出现了不同的序列号：${withSerial.map((i) => i.attrs.serialNumber).join('、')}。`,
        { raw: withSerial.map((i) => ({ evidenceId: i.row.id, serial: i.attrs.serialNumber })), provider },
      ),
    );
  }

  // 近景天然只拍一部分，物体数量只在整体镜头之间比较。
  const countable = items.filter(
    (i) => i.attrs.objectCount !== null && ['overall', 'contents'].includes(i.row.shot_label ?? ''),
  );
  const counts = new Set(countable.map((i) => i.attrs.objectCount));
  if (counts.size > 1) {
    signals.push(
      signal(
        'CROSS_EVIDENCE_CONTRADICTION',
        'contradicts_claim',
        'strong',
        0.88,
        countable.map((i) => i.row),
        null,
        `不同证据中的商品数量不一致：${countable.map((i) => `${i.attrs.objectCount} 件`).join('、')}。`,
        { raw: countable.map((i) => ({ evidenceId: i.row.id, count: i.attrs.objectCount })), provider },
      ),
    );
  }

  // 陈述与画面：这里只做关键词比对，买家文字不进入任何提示词。
  if (ctx.claim.narrative && UNOPENED_RE.test(ctx.claim.narrative)) {
    const opened = items.filter((i) => i.attrs.packagingOpened === true);
    if (opened.length) {
      signals.push(
        signal(
          'NARRATIVE_EVIDENCE_CONFLICT',
          'contradicts_claim',
          'moderate',
          0.85,
          opened.map((i) => i.row),
          null,
          '买家陈述称商品未拆封，但提交的画面显示包装已经打开。',
          { provider },
        ),
      );
    }
  }

  // 挑战码：现场拍摄的镜头都应能在画面中读到。
  for (const { row, attrs } of items) {
    if (!row.challenge_id) continue;
    const challenge = ctx.challenges.get(row.challenge_id);
    if (!challenge) continue;
    if (!attrs.challengeCodeSeen) {
      signals.push(
        signal('CHALLENGE_MISSING', 'contradicts_claim', 'weak', 0.7, [row], null, `画面中没有识别到下发的挑战码 ${challenge.code}。也可能只是纸条被遮挡或拍得不清楚。`, { provider }),
      );
    } else if (norm(attrs.challengeCodeSeen) !== norm(challenge.code)) {
      signals.push(
        signal('CHALLENGE_MISMATCH', 'contradicts_claim', 'moderate', 0.85, [row], null, `画面中的码 ${attrs.challengeCodeSeen} 与下发的挑战码 ${challenge.code} 不一致。`, { provider }),
      );
    }
  }
  return { status: 'done', signals };
}

// ---------- Plausibility ----------
const SHIPPING_CAUSE_RE = /运输|快递|物流|压坏|压碎|摔|shipping|transit|courier/i;

async function plausibility(ctx: AnalyzerContext): Promise<AnalyzerResult> {
  const items = await attributesFor(ctx.evidence, ctx);
  const signals: SignalDraft[] = [];
  for (const { row, attrs, provider } of items) {
    const region = attrs.suspiciousRegion
      ? { evidenceId: row.id, bbox: attrs.suspiciousRegion.bbox as BBox }
      : undefined;
    if (attrs.screenRecapture.likely && attrs.screenRecapture.confidence >= 0.6) {
      signals.push(
        signal('SCREEN_RECAPTURE', 'contradicts_claim', 'moderate', attrs.screenRecapture.confidence, [row], null, `画面疑似对着屏幕翻拍：${attrs.screenRecapture.cues.join('、')}。`, { provider, raw: attrs.screenRecapture, region }),
      );
    }
    if (!attrs.physicalPlausibility.plausible && attrs.physicalPlausibility.confidence >= 0.6) {
      signals.push(
        signal('PHYSICALLY_IMPLAUSIBLE', 'contradicts_claim', 'moderate', attrs.physicalPlausibility.confidence, [row], null, attrs.physicalPlausibility.reason, { provider, raw: attrs.physicalPlausibility, region }),
      );
    }
  }
  if (ctx.claim.narrative && SHIPPING_CAUSE_RE.test(ctx.claim.narrative)) {
    const packages = items.filter((i) => i.row.shot_label === 'package');
    if (packages.length && packages.every((p) => p.attrs.packagingIntact === true)) {
      signals.push(
        signal('DAMAGE_CAUSE_MISMATCH', 'contradicts_claim', 'weak', 0.7, packages.map((p) => p.row), null, '买家称损坏发生在运输途中，但外包装看起来完好。', { provider: providerLabel(packages) }),
      );
    }
  }
  return { status: 'done', signals };
}

// ---------- Reference ----------
async function reference(ctx: AnalyzerContext): Promise<AnalyzerResult> {
  const buyer = await attributesFor(ctx.evidence, ctx);
  const refs = await attributesFor(ctx.references, ctx);
  const provider = providerLabel([...buyer, ...refs]);
  const signals: SignalDraft[] = [];

  const refSerial = refs.find((r) => r.attrs.serialNumber);
  const buyerSerials = buyer.filter((b) => b.attrs.serialNumber);
  const refColor = refs.find((r) => r.attrs.color)?.attrs.color ?? null;
  const refModel = refs.find((r) => r.attrs.model)?.attrs.model ?? null;

  if (refSerial && buyerSerials.length) {
    const expected = normalizeSerial(refSerial.attrs.serialNumber!);
    const mismatch = buyerSerials.filter((b) => normalizeSerial(b.attrs.serialNumber!) !== expected);
    if (mismatch.length) {
      signals.push(
        signal(
          'IDENTITY_MISMATCH',
          'contradicts_claim',
          'strong',
          0.95,
          mismatch.map((m) => m.row),
          null,
          `证据中的序列号 ${mismatch[0].attrs.serialNumber} 与发货留底 ${refSerial.attrs.serialNumber} 不一致。`,
          {
            provider,
            raw: { reference: refSerial.attrs.serialNumber, seen: mismatch.map((m) => m.attrs.serialNumber) },
            region: mismatch[0].attrs.suspiciousRegion
              ? { evidenceId: mismatch[0].row.id, bbox: mismatch[0].attrs.suspiciousRegion.bbox as BBox }
              : undefined,
          },
        ),
      );
    } else {
      signals.push(
        signal('IDENTITY_MATCH', 'supports_claim', 'strong', 0.95, buyerSerials.map((b) => b.row), null, `证据中的序列号与发货留底一致（${refSerial.attrs.serialNumber}）。`, { provider }),
      );
    }
  } else if (refs.length) {
    // 没有序列号时退回颜色、型号的成对比较，只能给出较弱的结论。
    const diffs = buyer.filter(
      (b) =>
        (refColor && b.attrs.color && norm(b.attrs.color) !== norm(refColor)) ||
        (refModel && b.attrs.model && norm(b.attrs.model) !== norm(refModel)),
    );
    const comparable = buyer.filter((b) => (refColor && b.attrs.color) || (refModel && b.attrs.model));
    if (diffs.length) {
      signals.push(
        signal('DETAIL_ALTERED', 'contradicts_claim', 'moderate', 0.75, diffs.map((d) => d.row), null, `证据中的颜色或型号与发货留底不同（留底：${[refColor, refModel].filter(Boolean).join('、')}）。`, { provider }),
      );
    } else if (comparable.length) {
      signals.push(
        signal('IDENTITY_MATCH', 'supports_claim', 'weak', 0.7, comparable.map((c) => c.row), null, '证据中的颜色与型号和发货留底一致；没有序列号可以进一步确认。', { provider }),
      );
    }
  }

  // 与下单时商品快照比对，只用快照，不用商家事后修改的商品页。
  if (ctx.claim.type === 'not_as_described' && ctx.order.listingSnapshot) {
    const snap = ctx.order.listingSnapshot;
    const differs = buyer.filter(
      (b) =>
        (snap.color && b.attrs.color && norm(b.attrs.color) !== norm(snap.color)) ||
        (snap.model && b.attrs.model && norm(b.attrs.model) !== norm(snap.model)),
    );
    if (differs.length) {
      signals.push(
        signal(
          'SNAPSHOT_DIFFERENCE',
          'supports_claim',
          'moderate',
          0.85,
          differs.map((d) => d.row),
          null,
          `实物与下单时快照不一致（快照：${[snap.color, snap.model].filter(Boolean).join('、')}；实物：${[differs[0].attrs.color, differs[0].attrs.model].filter(Boolean).join('、')}）。`,
          { provider, raw: { snapshot: snap } },
        ),
      );
    } else if (buyer.some((b) => b.attrs.color || b.attrs.model)) {
      signals.push(
        signal('SNAPSHOT_MATCH', 'contradicts_claim', 'moderate', 0.75, buyer.map((b) => b.row), null, '实物的颜色和型号与下单时快照一致。', { provider, raw: { snapshot: snap } }),
      );
    }
  }
  return { status: 'done', signals };
}

// ---------- Logistics ----------
async function logistics(ctx: AnalyzerContext): Promise<AnalyzerResult> {
  const { order, claim } = ctx;
  if (!order.trackingNumber) return { status: 'unavailable', reason: '订单没有物流单号' };
  let t: TrackingResult;
  try {
    t = await ctx.tracking.track(order.carrier ?? '', order.trackingNumber);
  } catch (e) {
    if (e instanceof ProviderUnavailable) return { status: 'unavailable', reason: e.message };
    throw e;
  }

  const signals: SignalDraft[] = [];
  const provider = ctx.tracking.name;
  const carrier = [{ id: `tracking:${order.trackingNumber}`, source: 'carrier_api' as SourceMark }];
  const raw = { tracking: t, orderAddress: order.shipAddress };
  const checksDelivery = claim.type === 'not_received' || claim.type === 'return' || claim.type === 'missing_items';

  const firstEvent = t.events[0]?.at;
  if (firstEvent && firstEvent < order.createdAt && checksDelivery) {
    signals.push(
      signal('SHIPPED_BEFORE_ORDER', 'supports_claim', 'strong', 0.95, carrier, 'carrier_api', `该单号的首个物流事件（${firstEvent.slice(0, 10)}）早于下单时间（${order.createdAt.slice(0, 10)}），不可能是这笔订单的包裹。`, { provider, raw }),
    );
  } else if (checksDelivery && t.status === 'delivered') {
    const orderZip = order.shipAddress?.postalCode;
    if (orderZip && t.deliveredPostalCode && orderZip !== t.deliveredPostalCode) {
      signals.push(
        signal('DELIVERY_ADDRESS_MISMATCH', 'supports_claim', 'strong', 0.9, carrier, 'carrier_api', `物流签收邮编 ${t.deliveredPostalCode} 与订单收货邮编 ${orderZip} 不一致。`, { provider, raw }),
      );
    } else if (claim.type === 'not_received' || claim.type === 'return') {
      signals.push(
        signal('DELIVERED_CONFIRMED', 'contradicts_claim', 'moderate', 0.95, carrier, 'carrier_api', `物流显示已于 ${(t.deliveredAt ?? '').slice(0, 10)} 签收到订单收货地址（邮编 ${t.deliveredPostalCode ?? '未知'}）。`, { provider, raw }),
      );
    }
  } else if (checksDelivery && claim.type !== 'missing_items') {
    signals.push(
      signal('TRACKING_NOT_DELIVERED', 'supports_claim', 'moderate', 0.9, carrier, 'carrier_api', '物流尚未显示签收。', { provider, raw }),
    );
  }

  // 称重比对。
  const theoretical = order.items.reduce((a, i) => a + (i.weightG ?? 0) * i.quantity, 0);
  const shipped = order.shippedWeightG;
  const carrierWeight = t.weightG;
  if (claim.type === 'missing_items' && theoretical > 0 && (shipped || carrierWeight)) {
    const observed = carrierWeight ?? shipped!;
    if (observed >= theoretical * 0.9) {
      signals.push(
        signal('WEIGHT_MISMATCH', 'contradicts_claim', 'moderate', 0.85, carrier, 'carrier_api', `买家称少件或空箱，但物流称重 ${observed}g 与完整商品的理论重量 ${theoretical}g 基本一致。`, { provider, raw: { ...raw, theoretical, shipped, carrierWeight } }),
      );
    } else {
      signals.push(
        signal('WEIGHT_SHORTFALL', 'supports_claim', 'moderate', 0.85, carrier, 'carrier_api', `物流称重 ${observed}g 明显低于理论重量 ${theoretical}g，买家的说法有依据。`, { provider, raw: { ...raw, theoretical, shipped, carrierWeight } }),
      );
    }
  } else if (claim.type === 'damaged' || claim.type === 'not_as_described') {
    if (theoretical > 0 && carrierWeight && carrierWeight < theoretical * 0.7) {
      signals.push(
        signal('WEIGHT_SHORTFALL', 'supports_claim', 'weak', 0.7, carrier, 'carrier_api', `物流称重 ${carrierWeight}g 低于理论重量 ${theoretical}g。`, { provider, raw: { ...raw, theoretical } }),
      );
    }
  }
  return { status: 'done', signals };
}

// ---------- Records ----------
const AGREED_BY_MERCHANT = /同意|已退款|退款/;

async function records(ctx: AnalyzerContext): Promise<AnalyzerResult> {
  const signals: SignalDraft[] = [];
  const screenshots = ctx.evidence.filter((e) => ['chat_screenshot', 'receipt'].includes(e.shot_label ?? ''));

  // 买家后续消息里的收货表述，只做关键词比对。
  if (ctx.claim.type === 'not_received') {
    const received = ctx.messages.find((m) => m.sender === 'buyer' && /(?<![没未不])(已?收到了|收到货|已签收|签收了)/.test(m.text));
    if (received) {
      signals.push(
        signal('NARRATIVE_EVIDENCE_CONFLICT', 'contradicts_claim', 'moderate', 0.8, [{ id: 'messages', source: 'narrative' }], 'narrative', `买家在后续消息中提到已收货：“${received.text.slice(0, 40)}”。`, { provider: '本地规则' }),
      );
    }
  }
  if (!screenshots.length) return { status: 'done', signals };

  const items = await attributesFor(screenshots, ctx);
  const merchantLines = new Set(ctx.messages.filter((m) => m.sender === 'merchant').map((m) => normText(m.text)));

  for (const { row, attrs, provider } of items) {
    const shot = attrs.screenshot;
    if (shot.orderNumber && !ctx.knownOrderNumbers.has(shot.orderNumber)) {
      signals.push(
        signal('RECORD_NOT_FOUND', 'contradicts_claim', 'strong', 0.9, [row], null, `截图中的订单号 ${shot.orderNumber} 在交易记录中查不到。`, { provider, raw: shot }),
      );
    }
    if (shot.orderNumber && ctx.knownOrderNumbers.has(shot.orderNumber) && shot.amount !== null && Math.abs(shot.amount - ctx.order.amount) > 0.01 && shot.orderNumber === ctx.order.orderNo) {
      signals.push(
        signal('RECORD_NOT_FOUND', 'contradicts_claim', 'strong', 0.85, [row], null, `截图中的金额 ${shot.amount} 与交易记录 ${ctx.order.amount} 不一致。`, { provider, raw: shot }),
      );
    }
    // 只核对“商家说过的话”：买家自己发的内容不需要在商家消息库里。
    const merchantSaid = shot.chatLines.filter((l) => l.speaker === 'merchant');
    const notFound = merchantSaid.filter((l) => !merchantLines.has(normText(l.text)));
    // 消息库里没有这笔订单的任何商家消息时无从比对，不能据此判定截图有问题。
    if (notFound.length && merchantLines.size > 0) {
      const claimsAgreement = notFound.find((l) => AGREED_BY_MERCHANT.test(l.text)) ?? notFound[0];
      signals.push(
        signal('SCREENSHOT_CONTENT_MISMATCH', 'contradicts_claim', 'strong', 0.9, [row], null, `截图显示商家说过“${claimsAgreement.text.slice(0, 40)}”，商家消息库中没有这条记录。`, {
          provider,
          raw: { notFound, storedMerchantMessages: merchantLines.size },
        }),
      );
    }
  }
  const note = merchantLines.size === 0 ? '消息库中没有这笔订单的商家消息，未核对聊天内容' : undefined;
  return { status: 'done', signals, note };
}

// ---------- Behavior ----------
async function behavior(ctx: AnalyzerContext): Promise<AnalyzerResult> {
  const b = ctx.behavior;
  const records: { id: string; source: SourceMark }[] = [{ id: `order:${ctx.order.id}`, source: 'paypal_record' }];
  const signals: SignalDraft[] = [];
  if (b.buyerClaims >= 3) {
    signals.push(signal('HIGH_CLAIM_FREQUENCY', 'contradicts_claim', 'weak', 0.7, records, 'paypal_record', `该买家在本店共有 ${b.buyerClaims} 次索赔（含本次）。`, { provider: '本地统计' }));
  }
  if (b.similarNarrative) {
    signals.push(signal('SCRIPTED_NARRATIVE', 'contradicts_claim', 'weak', b.similarNarrative.similarity, [{ id: 'narrative', source: 'narrative' }], 'narrative', `索赔文本与订单 ${b.similarNarrative.orderNo} 的索赔高度相似（${(b.similarNarrative.similarity * 100).toFixed(0)}%）。`, { provider: '本地统计' }));
  }
  if (b.skuReasonClaims >= 3) {
    signals.push(signal('SKU_CLAIM_CLUSTER', 'contradicts_claim', 'moderate', 0.7, records, 'paypal_record', `近 30 天同一 SKU 出现 ${b.skuReasonClaims} 笔同类索赔。可能是协同行为，也可能是真实质量问题。`, { provider: '本地统计' }));
  }
  if (b.linkedAccounts > 0) {
    signals.push(signal('LINKED_ACCOUNTS', 'contradicts_claim', 'weak', 0.5, records, 'paypal_record', `有 ${b.linkedAccounts} 个其他账户使用相同收货地址。家庭、宿舍、公司集中收货属正常情况，仅作线索。`, { provider: '本地统计' }));
  }
  return { status: 'done', signals };
}

export const ANALYZER_IMPL: Record<AnalyzerName, (ctx: AnalyzerContext) => Promise<AnalyzerResult>> = {
  provenance,
  synthetic,
  origin,
  consistency,
  plausibility,
  reference,
  logistics,
  records,
  behavior,
};

