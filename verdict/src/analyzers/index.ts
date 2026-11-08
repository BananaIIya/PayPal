// 九个分析器。每个只输出结构化信号，不下结论，也不接触 PayPal 写接口。
// 买家陈述和图片里的文字在这里只被当作数据比较，不会进入任何判定指令。

import type { AnalyzerName, BBox, ClaimType, Direction, Signal, SourceMark, Strength } from '@/core/types';
import { extractAttributes, syntheticScores } from '@/providers/registry';
import type { TrackingProvider, TrackingResult } from '@/providers/types';
import { ProviderUnavailable } from '@/providers/types';
import { hammingDistance, isInformativeHash, readFile, REUSE_DISTANCE } from '@/server/storage';
import { scanProvenance } from './provenance-scan';
import { videoMeta } from './video-meta';

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
  /** image、video，或从视频抽出的 frame。 */
  kind?: string;
  /** frame 来自哪段视频。 */
  parent_id?: string | null;
  capture_meta?: string | null;
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
  challenge_pending: 1,
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
/**
 * 常见的剪辑软件会把名字写进视频元数据。不含 ffmpeg（Lavf）：压缩转码也会用到它；
 * 也不匹配单独的“Adobe”：很多手机写 XMP 时带着“Adobe XMP Core”。
 */
const EDIT_SOFTWARE_RE =
  /(CapCut|剪映|Premiere|After Effects|Final ?Cut|iMovie|DaVinci|InShot|KineMaster|Filmora|VN Video|VivaCut|Videoleap|PowerDirector|Movavi|Shotcut|Clipchamp)/i;

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;

async function provenance(ctx: AnalyzerContext): Promise<AnalyzerResult> {
  const signals: SignalDraft[] = [];
  const clean: EvidenceRow[] = [];
  for (const row of ctx.evidence) {
    const scan = scanProvenance(readFile(row.sha256), row.mime_type);
    if (scan.fullyGenerated && row.source !== 'reference') {
      // 签名没有核验，但“整份内容由 AI 从零生成”这种声明只会对提交者不利，没人会为了索赔去伪造它。
      // 所以不像 AI 修图那样只给中风险下限，而是作为硬规则直接判高风险。
      const what = row.kind === 'video' ? '整段视频' : '整张图片';
      signals.push(
        signal(
          'AI_PROVENANCE_FOUND',
          'contradicts_claim',
          'strong',
          0.9,
          [row],
          null,
          `文件的 C2PA 清单声明${what}由生成式 AI${scan.generator ? `（${scan.generator}）` : ''}从零生成，不是拍摄后再用 AI 修改的。签名尚未核验，但这类声明只会对提交者不利，不能当作实拍证据。`,
          { raw: scan, provider: '本地解析' },
        ),
      );
    } else if (scan.aiSourceType || scan.aigcLabel) {
      const what = scan.aigcLabel && !scan.aiSourceType ? 'GB 45438 隐式标识' : 'C2PA 清单里的 AI 来源声明';
      signals.push(
        signal(
          'PROVENANCE_CLAIM_UNVERIFIED',
          'contradicts_claim',
          'moderate',
          0.7,
          [row],
          null,
          `文件里有${what}${scan.generator ? `（${scan.generator}）` : ''}，但没有核验签名、签署者是否可信，也没有核验声明是否绑在当前内容上。这只说明文件带有一份来源声明，不能证明索赔不成立。需要未经编辑的原图，或其他独立证据。`,
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
  // 视频是否经过剪辑：元数据里的剪辑软件，以及现场录制中出现的画面突变。两者都只看文件本身，不需要模型。
  for (const v of ctx.evidence.filter((e) => e.kind === 'video')) {
    const meta = videoMeta(v.capture_meta);
    if (!meta) continue;
    const software = Object.values(meta.tags)
      .map((t) => String(t).match(EDIT_SOFTWARE_RE)?.[1])
      .find(Boolean);
    if (software) {
      signals.push(
        signal('VIDEO_EDITED', 'contradicts_claim', 'moderate', 0.75, [v], null, `视频元数据显示经过剪辑软件处理（${software}）。`, {
          raw: { tags: meta.tags },
          provider: '本地解析（ffprobe）',
        }),
      );
    }
    if (v.source === 'live_capture' && meta.sceneCutsMs.length) {
      signals.push(
        signal(
          'VIDEO_DISCONTINUITY',
          'contradicts_claim',
          'weak',
          0.6,
          [v],
          null,
          `现场录制的视频里有 ${meta.sceneCutsMs.length} 处画面突变（${meta.sceneCutsMs.map(seconds).join('、')}），连续录制一般不会出现。镜头快速移动、遮挡或光线突变也会造成这种情况。`,
          { raw: { sceneCutsMs: meta.sceneCutsMs }, provider: '本地解析（ffmpeg）' },
        ),
      );
    }
  }

  if (clean.length) {
    signals.push(
      signal('NO_PROVENANCE', 'neutral', 'weak', 1, clean, null, `${clean.length} 份证据未发现来源凭证。未检出不等于真实，只代表缺少这一信号。`, {
        provider: '本地解析',
      }),
    );
  }
  return { status: 'done', signals, note: '仅解析 C2PA 与隐式标识是否存在，未校验签名；SynthID 未接入。视频另查元数据里的剪辑软件和现场录制中的画面突变' };
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
          // 反证是库里已经存过的历史证据，不按这张图的上传来源降权。
          'paypal_record',
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
  // 视频本身不送进属性提取（多模态模型看的是图片），画面比对用它抽出来的帧。
  const videos = ctx.evidence.filter((e) => e.kind === 'video');
  const unframed = videos.filter((v) => videoMeta(v.capture_meta)?.frameExtraction !== 'ok');
  if (unframed.length) {
    const reason = videoMeta(unframed[0].capture_meta)?.reason ?? '原因未知';
    return { status: 'unavailable', reason: `${unframed.length} 段视频没有抽帧（${reason}），无法逐帧比对；处理好后重新分析` };
  }
  const items = await attributesFor(
    ctx.evidence.filter((e) => e.kind !== 'video'),
    ctx,
  );
  const provider = providerLabel(items);
  const signals: SignalDraft[] = [];
  const frames = items.filter((i) => i.row.kind === 'frame' && i.row.parent_id);
  const framesOf = (videoId: string) => frames.filter((f) => f.row.parent_id === videoId);

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

  // 近景天然只拍一部分，物体数量只在整体镜头之间比较。同一段视频的帧只取数量最多的一帧：
  // 镜头移动时有的帧拍不全，这不算矛盾。
  const isCountable = (i: (typeof items)[number]) => i.attrs.objectCount !== null && ['overall', 'contents'].includes(i.row.shot_label ?? '');
  const countable = [
    ...items.filter((i) => i.row.kind !== 'frame' && isCountable(i)),
    ...videos.flatMap((v) => {
      const counted = framesOf(v.id).filter(isCountable);
      return counted.length ? [counted.reduce((a, b) => (b.attrs.objectCount! > a.attrs.objectCount! ? b : a))] : [];
    }),
  ];
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

  const challenges = await assessChallenges(ctx);
  signals.push(...challenges.signals);
  return { status: 'done', signals };
}

/**
 * 核对画面里的挑战码。码一致只是提高可信度的线索，调用方在核验通过后才把拍摄从来源
 * `challenge_pending` 提升为现场拍摄。这里不写库。
 * 视频只要有一帧读到正确的码就算通过。识别服务不可用时记为未能核验，不当成“画面里没有码”。
 */
export async function assessChallenges(ctx: AnalyzerContext): Promise<{ matchedIds: string[]; signals: SignalDraft[] }> {
  const matchedIds: string[] = [];
  const signals: SignalDraft[] = [];
  const targets = ctx.evidence.filter((e) => e.challenge_id && e.kind !== 'frame' && ctx.challenges.has(e.challenge_id));

  for (const target of targets) {
    const challenge = ctx.challenges.get(target.challenge_id!)!;
    const frames = target.kind === 'video' ? ctx.evidence.filter((e) => e.kind === 'frame' && e.parent_id === target.id) : [target];
    if (target.kind === 'video' && frames.length === 0) {
      signals.push(
        signal('CHALLENGE_UNVERIFIED', 'neutral', 'weak', 0.5, [target], null, '视频没有抽出可以核验的画面，挑战码还没核对。核验通过之前，这份拍摄不按现场取证计。', {
          provider: '未执行',
        }),
      );
      continue;
    }
    let looked: Awaited<ReturnType<typeof attributesFor>>;
    try {
      looked = await attributesFor(frames, ctx);
    } catch (e) {
      if (e instanceof ProviderUnavailable) {
        signals.push(
          signal(
            'CHALLENGE_UNVERIFIED',
            'neutral',
            'weak',
            0.5,
            [target],
            null,
            '画面内容暂时无法识别，挑战码还没核验。核验通过之前，这份拍摄不按现场取证计。',
            { provider: '未执行' },
          ),
        );
        continue;
      }
      throw e;
    }
    const provider = providerLabel(looked);
    const seen = looked.filter((i) => i.attrs.challengeCodeSeen);
    const hit = seen.find((i) => norm(i.attrs.challengeCodeSeen) === norm(challenge.code));
    if (hit) {
      matchedIds.push(target.id);
      signals.push(
        signal(
          'CHALLENGE_MATCHED',
          'neutral',
          'weak',
          0.8,
          [target],
          null,
          `画面中的挑战码与下发的一致（${challenge.code}）。这只是提高可信度的线索，不能单独证明索赔内容。`,
          { provider },
        ),
      );
    } else if (seen.length) {
      const sample = seen[0];
      const where = target.kind === 'video' ? '视频画面' : '画面';
      signals.push(
        signal(
          'CHALLENGE_MISMATCH',
          'contradicts_claim',
          'moderate',
          0.85,
          [target.kind === 'video' ? sample.row : target],
          null,
          `${where}中的码 ${sample.attrs.challengeCodeSeen} 与下发的挑战码 ${challenge.code} 不一致。`,
          { provider },
        ),
      );
    } else {
      const where = target.kind === 'video' ? `视频抽出的 ${frames.length} 帧里都没有` : '画面中没有';
      signals.push(
        signal(
          'CHALLENGE_MISSING',
          'contradicts_claim',
          'weak',
          0.7,
          [target],
          null,
          `${where}识别到下发的挑战码 ${challenge.code}。也可能只是纸条被遮挡或拍得不清楚。`,
          { provider },
        ),
      );
    }
  }
  return { matchedIds, signals };
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
  // 只有快照和照片两边都有的字段才能比。一边缺失时记为无法核对，不能当成一致。
  if (ctx.claim.type === 'not_as_described' && ctx.order.listingSnapshot) {
    const snap = ctx.order.listingSnapshot;
    const fields = [
      { key: 'color' as const, label: '颜色' },
      { key: 'model' as const, label: '型号' },
    ];
    const diffs: { row: EvidenceRow; label: string; snap: string; seen: string }[] = [];
    const compared = new Set<string>();
    const comparedRows: EvidenceRow[] = [];
    for (const b of buyer) {
      let used = false;
      for (const f of fields) {
        const snapVal = snap[f.key]?.trim();
        const seen = b.attrs[f.key]?.trim();
        if (!snapVal || !seen) continue;
        used = true;
        compared.add(f.label);
        if (norm(seen) !== norm(snapVal)) diffs.push({ row: b.row, label: f.label, snap: snapVal, seen });
      }
      if (used) comparedRows.push(b.row);
    }
    if (diffs.length) {
      const described = [...new Map(diffs.map((d) => [d.label, d])).values()].map((d) => `${d.label}（快照 ${d.snap}，实物 ${d.seen}）`);
      signals.push(
        signal(
          'SNAPSHOT_DIFFERENCE',
          'supports_claim',
          'moderate',
          0.85,
          [...new Map(diffs.map((d) => [d.row.id, d.row])).values()],
          null,
          `已核对的字段与下单快照不一致：${described.join('、')}。`,
          { provider, raw: { snapshot: snap } },
        ),
      );
    } else if (compared.size) {
      const unchecked = fields.filter((f) => !compared.has(f.label)).map((f) => f.label);
      const rest = unchecked.length ? ` ${unchecked.join('、')}没有同时出现在快照和照片里，不能算一致。` : '';
      signals.push(
        signal(
          'SNAPSHOT_MATCH',
          'contradicts_claim',
          'moderate',
          0.75,
          comparedRows,
          null,
          `已核对的字段与下单快照一致（${[...compared].join('、')}）。${rest}`.trim(),
          { provider, raw: { snapshot: snap, compared: [...compared] } },
        ),
      );
    } else if (buyer.length) {
      signals.push(
        signal(
          'SNAPSHOT_UNVERIFIED',
          'neutral',
          'weak',
          0.6,
          buyer.map((b) => b.row),
          null,
          '下单快照和买家照片没有可以同时核对的颜色或型号，实物是否与下单时一致无法判断。',
          { provider, raw: { snapshot: snap } },
        ),
      );
    }
  }
  return { status: 'done', signals };
}

/** 下单行和模拟轨迹可能在同一次请求里各打一个时间戳。1 分钟以内不当成“单号属于另一票货”。 */
const SHIPPED_BEFORE_TOLERANCE_MS = 60_000;

function shippedBeforeOrder(firstEvent: string, createdAt: string): boolean {
  const eventMs = Date.parse(firstEvent);
  const orderMs = Date.parse(createdAt);
  if (Number.isNaN(eventMs) || Number.isNaN(orderMs)) return false;
  return orderMs - eventMs > SHIPPED_BEFORE_TOLERANCE_MS;
}

/** 轨迹里最早的一条。承运商不一定按时间正序返回。 */
function earliestEventAt(events: { at: string }[]): string | undefined {
  let best: { at: string; ms: number } | undefined;
  for (const event of events) {
    const ms = Date.parse(event.at);
    if (Number.isNaN(ms)) continue;
    if (!best || ms < best.ms) best = { at: event.at, ms };
  }
  return best?.at;
}

/**
 * 邮编只比实质内容。美国 ZIP+4、大小写和空格不算两个地址。
 * 95131 和 95131-1234 是同一处；94107 和 10001 仍是两处。
 */
function normalizePostal(raw: string): string {
  const compact = raw.trim().toUpperCase().replace(/[\s-]+/g, '');
  const us = compact.match(/^(\d{5})(\d{4})?$/);
  return us ? us[1] : compact;
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

  const firstEvent = earliestEventAt(t.events);
  // 同一秒内写入订单和轨迹会差几毫秒。只有早过这个窗口才当成另一票货，否则会盖住“已签收到正确邮编”。
  if (firstEvent && checksDelivery && shippedBeforeOrder(firstEvent, order.createdAt)) {
    signals.push(
      signal(
        'SHIPPED_BEFORE_ORDER',
        'supports_claim',
        'strong',
        0.95,
        carrier,
        'carrier_api',
        `该单号的首个物流事件（${firstEvent}）比下单时间（${order.createdAt}）早超过 1 分钟，不可能是这笔订单的包裹。`,
        { provider, raw },
      ),
    );
  } else if (checksDelivery && String(t.status).toLowerCase() === 'delivered') {
    const orderZipRaw = order.shipAddress?.postalCode?.trim() || '';
    const deliveredZipRaw = t.deliveredPostalCode?.trim() || '';
    const orderZip = normalizePostal(orderZipRaw);
    const deliveredZip = normalizePostal(deliveredZipRaw);
    const checksAddress = claim.type === 'not_received' || claim.type === 'return';
    if (orderZip && deliveredZip && orderZip !== deliveredZip) {
      signals.push(
        signal('DELIVERY_ADDRESS_MISMATCH', 'supports_claim', 'strong', 0.9, carrier, 'carrier_api', `物流签收邮编 ${deliveredZipRaw} 与订单收货邮编 ${orderZipRaw} 不一致。`, { provider, raw }),
      );
    } else if (checksAddress && orderZip && deliveredZip) {
      signals.push(
        signal('DELIVERED_CONFIRMED', 'contradicts_claim', 'moderate', 0.95, carrier, 'carrier_api', `物流显示已于 ${(t.deliveredAt ?? '').slice(0, 10)} 签收到订单收货地址（邮编 ${deliveredZipRaw}）。`, { provider, raw }),
      );
    } else if (checksAddress) {
      signals.push(
        signal(
          'DELIVERY_ADDRESS_UNVERIFIED',
          'neutral',
          'weak',
          0.6,
          carrier,
          'carrier_api',
          '物流显示已签收，但订单地址或签收邮编缺失，无法确认是否送到订单收货地址。',
          { provider, raw },
        ),
      );
    }
  } else if (checksDelivery && claim.type !== 'missing_items' && String(t.status).toLowerCase() === 'in_transit') {
    // 还在途中只说明“现在还没签收”，不能把两个关键命题判成已核实，否则会直接建议全额退款。
    signals.push(
      signal('TRACKING_NOT_DELIVERED', 'supports_claim', 'moderate', 0.9, carrier, 'carrier_api', '物流尚未显示签收，包裹可能仍在运输途中。', { provider, raw }),
    );
  } else if (checksDelivery && claim.type !== 'missing_items') {
    signals.push(
      signal('TRACKING_STATUS_UNKNOWN', 'neutral', 'weak', 0.5, carrier, 'carrier_api', '物流状态不明，不能据此判断包裹有没有送到。', { provider, raw }),
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
        signal('RECORD_NOT_FOUND', 'contradicts_claim', 'strong', 0.9, [row], 'paypal_record', `截图中的订单号 ${shot.orderNumber} 在交易记录中查不到。`, { provider, raw: shot }),
      );
    }
    if (shot.orderNumber && ctx.knownOrderNumbers.has(shot.orderNumber) && shot.amount !== null && Math.abs(shot.amount - ctx.order.amount) > 0.01 && shot.orderNumber === ctx.order.orderNo) {
      signals.push(
        signal('RECORD_NOT_FOUND', 'contradicts_claim', 'strong', 0.85, [row], 'paypal_record', `截图中的金额 ${shot.amount} 与交易记录 ${ctx.order.amount} 不一致。`, { provider, raw: shot }),
      );
    }
    // 只核对“商家说过的话”：买家自己发的内容不需要在商家消息库里。
    const merchantSaid = shot.chatLines.filter((l) => l.speaker === 'merchant');
    const notFound = merchantSaid.filter((l) => !merchantLines.has(normText(l.text)));
    // 消息库里没有这笔订单的任何商家消息时无从比对，不能据此判定截图有问题。
    if (notFound.length && merchantLines.size > 0) {
      const claimsAgreement = notFound.find((l) => AGREED_BY_MERCHANT.test(l.text)) ?? notFound[0];
      // 反证是商家消息库，不按截图本身的上传来源降权。
      signals.push(
        signal('SCREENSHOT_CONTENT_MISMATCH', 'contradicts_claim', 'strong', 0.9, [row], 'paypal_record', `截图显示商家说过“${claimsAgreement.text.slice(0, 40)}”，商家消息库中没有这条记录。`, {
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

