// 编排器：按索赔类型派发分析器，并行运行；任一分析器完成后重新计算判定。
// MVP 用进程内执行代替 BullMQ + Worker，接口边界保持不变，之后可以把 runAnalysis 挪进 Worker。
import { ANALYZER_IMPL, type AnalyzerContext, type OtherEvidence } from '@/analyzers';
import { applicableAnalyzers, DEFAULT_CONFIG } from '@/core/catalog';
import { decide } from '@/core/engine';
import type { AnalyzerName, EngineInput, MerchantRiskFactors } from '@/core/types';
import { SimulatedTracking } from '@/providers/registry';
import { ProviderUnavailable } from '@/providers/types';
import { db, json, newId, nowIso, tx } from './db';
import {
  addTimeline,
  claimEvidence,
  claimRuns,
  claimSignals,
  getClaim,
  getOrder,
  getPolicy,
  getTracking,
  latestVerdict,
  orderReferences,
  toOrderView,
  type ClaimRow,
  type OrderRow,
} from './repo';

const ANALYZER_TIMEOUT_MS = 180_000;
/** 同 SKU 索赔率的店铺基线。MVP 用固定值，正式版从历史订单计算。 */
const BASELINE_CLAIM_RATE = 0.03;
const MIN_SKU_SAMPLE = 5;

const g = globalThis as unknown as { __verdictRunning?: Set<string> };
const running = (g.__verdictRunning ??= new Set<string>());

export interface RunOptions {
  /** 不调用付费服务，生成演示数据时使用。 */
  offline?: boolean;
  /** 演示用的人为延迟，让控制台能看到逐项更新。 */
  latencyMs?: number;
  only?: AnalyzerName[];
}

function bigrams(text: string): Set<string> {
  const clean = text.replace(/\s+/g, '');
  const out = new Set<string>();
  for (let i = 0; i < clean.length - 1; i++) out.add(clean.slice(i, i + 2));
  return out;
}

export function textSimilarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function skusOf(order: OrderRow): string[] {
  return json<{ sku: string }[]>(order.items, []).map((i) => i.sku);
}

function behaviorStats(claim: ClaimRow, order: OrderRow) {
  const conn = db();
  // 商家生成了链接、买家还没提交的索赔（collecting）不算买家的行为。
  const buyerClaims = order.buyer_email_hash
    ? (
        conn
          .prepare('SELECT COUNT(*) AS n FROM claims c JOIN orders o ON o.id = c.order_id WHERE o.buyer_email_hash = ? AND c.merchant_id = ? AND c.status != \'collecting\'')
          .get(order.buyer_email_hash, claim.merchant_id) as { n: number }
      ).n
    : 0;

  const others = conn
    .prepare(
      `SELECT c.id, c.narrative, c.claim_type, c.created_at, o.order_no, o.items, o.buyer_email_hash, o.ship_address
       FROM claims c JOIN orders o ON o.id = c.order_id
       WHERE c.merchant_id = ? AND c.id != ? AND c.status != 'collecting'`,
    )
    .all(claim.merchant_id, claim.id) as unknown as {
    id: string;
    narrative: string | null;
    claim_type: string;
    created_at: string;
    order_no: string;
    items: string;
    buyer_email_hash: string | null;
    ship_address: string | null;
  }[];

  let similarNarrative: { orderNo: string; similarity: number } | null = null;
  const narrative = claim.narrative ?? '';
  if (narrative.replace(/\s/g, '').length >= 12) {
    for (const o of others) {
      if (!o.narrative || o.buyer_email_hash === order.buyer_email_hash) continue;
      const similarity = textSimilarity(narrative, o.narrative);
      if (similarity >= 0.8 && (!similarNarrative || similarity > similarNarrative.similarity)) {
        similarNarrative = { orderNo: o.order_no, similarity: Math.round(similarity * 100) / 100 };
      }
    }
  }

  const skus = new Set(skusOf(order));
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const skuReasonClaims =
    1 +
    others.filter(
      (o) =>
        o.claim_type === claim.claim_type &&
        o.created_at >= cutoff &&
        json<{ sku: string }[]>(o.items, []).some((i) => skus.has(i.sku)),
    ).length;

  const addr = json<{ line1?: string; postalCode?: string } | null>(order.ship_address, null);
  const linked = new Set(
    others
      .filter((o) => {
        const a = json<{ line1?: string; postalCode?: string } | null>(o.ship_address, null);
        return a && addr && a.line1 === addr.line1 && a.postalCode === addr.postalCode && o.buyer_email_hash !== order.buyer_email_hash;
      })
      .map((o) => o.buyer_email_hash),
  );

  return { buyerClaims, similarNarrative, skuReasonClaims, linkedAccounts: linked.size };
}

function merchantFactors(claim: ClaimRow, order: OrderRow): MerchantRiskFactors {
  const conn = db();
  const skus = new Set(skusOf(order));
  const orders = conn.prepare('SELECT id, items FROM orders WHERE merchant_id = ?').all(claim.merchant_id) as unknown as { id: string; items: string }[];
  const sameSku = orders.filter((o) => json<{ sku: string }[]>(o.items, []).some((i) => skus.has(i.sku)));
  const claimCount = sameSku.reduce(
    (a, o) => a + (conn.prepare('SELECT COUNT(*) AS n FROM claims WHERE order_id = ?').get(o.id) as { n: number }).n,
    0,
  );
  const rate = sameSku.length ? claimCount / sameSku.length : 0;
  const skuDeviation = sameSku.length >= MIN_SKU_SAMPLE ? Math.min(1, Math.max(0, (rate - BASELINE_CLAIM_RATE) / 0.3)) : 0;

  const batchConfirmedIssue = order.batch
    ? (
        conn
          .prepare('SELECT COUNT(*) AS n FROM claims c JOIN orders o ON o.id = c.order_id WHERE o.batch = ? AND c.confirmed_quality_issue = 1 AND c.id != ?')
          .get(order.batch, claim.id) as { n: number }
      ).n > 0
    : false;

  const snap = json<Record<string, unknown> | null>(order.listing_snapshot, null);
  const current = json<Record<string, unknown> | null>(order.current_listing, null);
  const listingChangedAfterOrder = !!snap && !!current && JSON.stringify(snap) !== JSON.stringify(current);

  const missingReferenceOrWeight = orderReferences(order.id).length === 0 || order.shipped_weight_g === null;
  return { skuDeviation, batchConfirmedIssue, listingChangedAfterOrder, missingReferenceOrWeight };
}

function alreadyAgreed(order: OrderRow): boolean {
  const rows = db()
    .prepare("SELECT text FROM messages WHERE order_id = ? AND sender = 'merchant'")
    .all(order.id) as unknown as { text: string }[];
  return rows.some((m) => /同意.{0,6}退款|已为您退款|已退款/.test(m.text));
}

function buildContext(claim: ClaimRow, order: OrderRow, offline: boolean): AnalyzerContext {
  const conn = db();
  const evidence = claimEvidence(claim.id);
  const challenges = new Map<string, { code: string; action: string }>();
  for (const row of conn.prepare('SELECT id, code, action FROM challenges WHERE claim_id = ?').all(claim.id) as unknown as { id: string; code: string; action: string }[]) {
    challenges.set(row.id, { code: row.code, action: row.action });
  }
  const messages = conn
    .prepare('SELECT sender, text, created_at FROM messages WHERE order_id = ? ORDER BY created_at')
    .all(order.id) as unknown as AnalyzerContext['messages'];
  const merchantEvidence = conn
    .prepare(
      `SELECT e.id, e.claim_id, e.order_id, e.dhash, e.sha256, e.created_at, o.order_no
       FROM evidence e JOIN orders o ON o.id = e.order_id
       WHERE o.merchant_id = ? AND e.source != 'reference'`,
    )
    .all(claim.merchant_id) as unknown as OtherEvidence[];
  const known = conn.prepare('SELECT order_no FROM orders WHERE merchant_id = ?').all(claim.merchant_id) as unknown as { order_no: string }[];

  return {
    claim: { id: claim.id, type: claim.claim_type, narrative: claim.narrative, createdAt: claim.created_at },
    order: toOrderView(order),
    evidence,
    references: orderReferences(order.id),
    challenges,
    messages,
    merchantEvidence,
    knownOrderNumbers: new Set(known.map((k) => k.order_no)),
    tracking: new SimulatedTracking(getTracking(order)),
    behavior: behaviorStats(claim, order),
    offline,
  };
}

/** 判定引擎重新计算一次并写库。结果没变化时不新增记录，避免商家手里的 verdictId 无故失效。 */
export function recompute(claimId: string): void {
  const claim = getClaim(claimId);
  if (!claim) return;
  const order = getOrder(claim.order_id)!;
  const references = orderReferences(order.id);
  const evidence = [...claimEvidence(claimId), ...references].map((e) => ({
    id: e.id,
    source: e.source,
    layer: e.layer as EngineInput['evidence'][number]['layer'],
    shotLabel: e.shot_label,
  }));
  const signals = claimSignals(claimId);
  const input: EngineInput = {
    claim: {
      type: claim.claim_type,
      hasDispute: !!claim.paypal_dispute_id,
      amount: order.amount,
      currency: order.currency,
      alreadyAgreed: alreadyAgreed(order),
      trackingNumber: order.tracking_number,
      carrier: order.carrier,
    },
    policy: getPolicy(claim.merchant_id, order.category),
    signals,
    evidence,
    runs: claimRuns(claimId),
    hasReference: references.length > 0,
    merchantFactors: merchantFactors(claim, order),
    config: DEFAULT_CONFIG,
  };
  const report = decide(input);

  const previous = latestVerdict(claimId);
  const serialized = JSON.stringify(report);
  if (previous?.report === serialized) return;

  db()
    .prepare(
      `INSERT INTO verdicts (id, claim_id, seq, level, score, data_confidence, merchant_risk, incomplete, suggested_action, report, signal_ids, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId(),
      claimId,
      (previous?.seq ?? 0) + 1,
      report.level,
      report.score,
      report.dataConfidence,
      report.merchantRisk,
      report.incomplete ? 1 : 0,
      report.primaryAction.type,
      serialized,
      JSON.stringify(signals.map((s) => s.id)),
      nowIso(),
    );
}

function setRun(claimId: string, analyzer: AnalyzerName, status: string, fields: { error?: string | null; note?: string | null } = {}) {
  const now = nowIso();
  db()
    .prepare(
      `UPDATE analysis_runs SET status = ?, error = ?, note = ?,
         started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END,
         finished_at = CASE WHEN ? IN ('done','unavailable','failed') THEN ? ELSE finished_at END
       WHERE claim_id = ? AND analyzer = ?`,
    )
    .run(status, fields.error ?? null, fields.note ?? null, status, now, status, now, claimId, analyzer);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`超过 ${Math.round(ms / 1000)} 秒未完成`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function runAnalysis(claimId: string, opts: RunOptions = {}): Promise<void> {
  if (running.has(claimId)) return;
  running.add(claimId);
  try {
    const claim = getClaim(claimId);
    if (!claim) throw new Error(`索赔不存在：${claimId}`);
    const order = getOrder(claim.order_id)!;
    const evidence = claimEvidence(claimId);
    const hasScreenshots = evidence.some((e) => ['chat_screenshot', 'receipt'].includes(e.shot_label ?? ''));
    const applicable = applicableAnalyzers(claim.claim_type, { hasImages: evidence.length > 0, hasScreenshots });
    const targets = opts.only?.length ? applicable.filter((a) => opts.only!.includes(a)) : applicable;

    tx(() => {
      const conn = db();
      for (const analyzer of targets) {
        conn.prepare('DELETE FROM signals WHERE claim_id = ? AND analyzer = ?').run(claimId, analyzer);
        conn.prepare('DELETE FROM analysis_runs WHERE claim_id = ? AND analyzer = ?').run(claimId, analyzer);
        conn.prepare("INSERT INTO analysis_runs (id, claim_id, analyzer, status) VALUES (?, ?, ?, 'queued')").run(newId(), claimId, analyzer);
      }
      if (claim.status !== 'closed') conn.prepare("UPDATE claims SET status = 'analyzing' WHERE id = ?").run(claimId);
    });

    const ctx = buildContext(claim, order, !!opts.offline);

    await Promise.all(
      targets.map(async (analyzer, index) => {
        if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs! * (index + 1)));
        setRun(claimId, analyzer, 'running');
        try {
          const out = await withTimeout(ANALYZER_IMPL[analyzer](ctx), ANALYZER_TIMEOUT_MS);
          if (out.status === 'unavailable') {
            setRun(claimId, analyzer, 'unavailable', { error: out.reason });
          } else {
            const now = nowIso();
            tx(() => {
              for (const s of out.signals) {
                db()
                  .prepare(
                    `INSERT INTO signals (id, claim_id, analyzer, code, direction, strength, confidence, evidence_ids, basis_source, region, explanation, raw, provider, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  )
                  .run(
                    newId(),
                    claimId,
                    analyzer,
                    s.code,
                    s.direction,
                    s.strength,
                    s.confidence,
                    JSON.stringify(s.evidenceIds),
                    s.basisSource,
                    s.region ? JSON.stringify(s.region) : null,
                    s.explanation,
                    s.raw === undefined ? null : JSON.stringify(s.raw),
                    s.provider ?? null,
                    now,
                  );
              }
            });
            setRun(claimId, analyzer, 'done', { note: out.note });
          }
        } catch (e) {
          // 单个分析器失败不影响其他分析器；报告里会列为未执行。
          if (e instanceof ProviderUnavailable) setRun(claimId, analyzer, 'unavailable', { error: e.message });
          else setRun(claimId, analyzer, 'failed', { error: e instanceof Error ? e.message : String(e) });
        }
        recompute(claimId);
      }),
    );

    const after = getClaim(claimId)!;
    if (after.status === 'analyzing') {
      db().prepare("UPDATE claims SET status = 'awaiting_decision' WHERE id = ?").run(claimId);
    }
    const v = latestVerdict(claimId);
    if (v && !opts.offline) addTimeline(claimId, 'analysis', '核验完成');
  } finally {
    running.delete(claimId);
  }
}

/** 触发分析但不等待，供 API 路由使用。 */
export function startAnalysis(claimId: string, opts: RunOptions = {}): void {
  const latency = opts.latencyMs ?? Number(process.env.DEMO_ANALYZER_DELAY_MS ?? 350);
  void runAnalysis(claimId, { ...opts, latencyMs: latency }).catch((e) => {
    console.error(`[verdict] 分析失败 ${claimId}`, e);
  });
}
