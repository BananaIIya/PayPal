// 数据访问。页面、API 和管线共用，返回给前端的都是普通 JSON 对象。
import type { AnalyzerName, AnalyzerRun, CategoryPolicy, ClaimOrigin, ClaimStatus, ClaimType, Layer, Signal, SourceMark, VerdictLevel, VerdictReport } from '@/core/types';
import { SOURCE_LAYER } from '@/core/catalog';
import type { EvidenceRow, OrderItem, OrderView } from '@/analyzers';
import type { PayPalEnv } from '@/paypal/client';
import type { TrackingResult } from '@/providers/types';
import { db, json, newId, nowIso } from './db';
import { perceptualHash, saveFile } from './storage';

export interface OrderRow {
  id: string;
  merchant_id: string;
  order_no: string;
  paypal_order_id: string | null;
  capture_id: string | null;
  buyer_name: string | null;
  buyer_email_hash: string | null;
  ship_address: string | null;
  items: string;
  listing_snapshot: string | null;
  current_listing: string | null;
  category: string;
  amount: number;
  currency: string;
  carrier: string | null;
  tracking_number: string | null;
  tracking_sim: string | null;
  shipped_weight_g: number | null;
  batch: string | null;
  paypal_env: PayPalEnv;
  created_at: string;
}

export interface ClaimRow {
  id: string;
  merchant_id: string;
  order_id: string;
  origin: ClaimOrigin;
  claim_type: ClaimType;
  narrative: string | null;
  paypal_dispute_id: string | null;
  status: ClaimStatus;
  confirmed_quality_issue: number;
  due_at: string | null;
  scenario: string | null;
  paypal_updated_at: string | null;
  paypal_status: string | null;
  created_at: string;
}

export interface ScenarioMeta {
  key: string;
  title: string;
  story: string;
  expected: string;
  expectedLevel?: VerdictLevel;
  history?: boolean;
}

export function toOrderView(row: OrderRow): OrderView {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    orderNo: row.order_no,
    buyerEmailHash: row.buyer_email_hash,
    shipAddress: json(row.ship_address, null),
    items: json<OrderItem[]>(row.items, []),
    listingSnapshot: json(row.listing_snapshot, null),
    amount: row.amount,
    carrier: row.carrier,
    trackingNumber: row.tracking_number,
    shippedWeightG: row.shipped_weight_g,
    createdAt: row.created_at,
  };
}

export function getOrder(id: string): OrderRow | undefined {
  return db().prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined;
}

export function getClaim(id: string): ClaimRow | undefined {
  return db().prepare('SELECT * FROM claims WHERE id = ?').get(id) as ClaimRow | undefined;
}

export function getPolicy(merchantId: string, category: string): CategoryPolicy {
  const row = db().prepare('SELECT * FROM category_policies WHERE merchant_id = ? AND category = ?').get(merchantId, category) as
    | { returnable: number; perishable: number; safety_sensitive: number; identity_required: number; required_shots: string }
    | undefined;
  if (!row) return { category, returnable: true, perishable: false, safetySensitive: false, identityRequired: false };
  return {
    category,
    returnable: !!row.returnable,
    perishable: !!row.perishable,
    safetySensitive: !!row.safety_sensitive,
    identityRequired: !!row.identity_required,
    requiredShots: json(row.required_shots, {}),
  };
}

export function getTracking(order: OrderRow): TrackingResult | null {
  return json<TrackingResult | null>(order.tracking_sim, null);
}

export function addTimeline(claimId: string, kind: string, title: string, detail?: string, at?: string): void {
  db()
    .prepare('INSERT INTO timeline_events (id, claim_id, at, kind, title, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(newId(), claimId, at ?? nowIso(), kind, title, detail ?? null);
}

export async function addEvidence(input: {
  claimId: string | null;
  orderId: string;
  source: Exclude<SourceMark, 'paypal_record' | 'carrier_api' | 'listing_snapshot' | 'narrative'>;
  file: Buffer;
  mime: string;
  shot: string | null;
  challengeId?: string | null;
  captureMeta?: unknown;
  at?: string;
}): Promise<{ id: string; sha256: string; layer: Layer }> {
  const hash = saveFile(input.file);
  let dhash: string | null = null;
  try {
    dhash = await perceptualHash(input.file);
  } catch {
    dhash = null; // 解码失败时跳过感知哈希，Origin 不会比对这份文件
  }
  const id = newId();
  const layer = SOURCE_LAYER[input.source];
  db()
    .prepare(
      `INSERT INTO evidence (id, claim_id, order_id, kind, source, sha256, dhash, layer, mime_type, shot_label, challenge_id, capture_meta, created_at)
       VALUES (?, ?, ?, 'image', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.claimId,
      input.orderId,
      input.source,
      hash,
      dhash,
      layer,
      input.mime,
      input.shot,
      input.challengeId ?? null,
      input.captureMeta ? JSON.stringify(input.captureMeta) : null,
      input.at ?? nowIso(),
    );
  return { id, sha256: hash, layer };
}

export function claimEvidence(claimId: string): EvidenceRow[] {
  return db().prepare('SELECT * FROM evidence WHERE claim_id = ? ORDER BY created_at, rowid').all(claimId) as unknown as EvidenceRow[];
}

export function orderReferences(orderId: string): EvidenceRow[] {
  return db().prepare("SELECT * FROM evidence WHERE order_id = ? AND source = 'reference' ORDER BY created_at, rowid").all(orderId) as unknown as EvidenceRow[];
}

interface SignalRow {
  id: string;
  analyzer: AnalyzerName;
  code: string;
  direction: Signal['direction'];
  strength: Signal['strength'];
  confidence: number;
  evidence_ids: string;
  basis_source: SourceMark;
  region: string | null;
  explanation: string;
  raw: string | null;
  provider: string | null;
}

export function claimSignals(claimId: string): Signal[] {
  const rows = db().prepare('SELECT * FROM signals WHERE claim_id = ? ORDER BY rowid').all(claimId) as unknown as SignalRow[];
  return rows.map((r) => ({
    id: r.id,
    analyzer: r.analyzer,
    code: r.code,
    direction: r.direction,
    strength: r.strength,
    confidence: r.confidence,
    evidenceIds: json<string[]>(r.evidence_ids, []),
    basisSource: r.basis_source,
    region: json(r.region, undefined),
    explanation: r.explanation,
    raw: json(r.raw, undefined),
    provider: r.provider ?? undefined,
  }));
}

export function claimRuns(claimId: string): AnalyzerRun[] {
  return db().prepare('SELECT analyzer, status, error, note FROM analysis_runs WHERE claim_id = ? ORDER BY rowid').all(claimId) as unknown as AnalyzerRun[];
}

export interface VerdictRow {
  id: string;
  claim_id: string;
  seq: number;
  level: VerdictLevel;
  score: number;
  data_confidence: number;
  merchant_risk: number;
  incomplete: number;
  suggested_action: string;
  report: string;
  signal_ids: string;
  created_at: string;
}

export function latestVerdict(claimId: string): VerdictRow | undefined {
  return db().prepare('SELECT * FROM verdicts WHERE claim_id = ? ORDER BY seq DESC LIMIT 1').get(claimId) as VerdictRow | undefined;
}

export interface ActionRow {
  id: string;
  claim_id: string;
  verdict_id: string;
  type: string;
  payload: string;
  confirmed_by: string;
  confirmed_at: string;
  paypal_request_id: string | null;
  paypal_response: string | null;
  status: string;
}

export function claimActions(claimId: string): ActionRow[] {
  return db().prepare('SELECT * FROM actions WHERE claim_id = ? ORDER BY confirmed_at DESC').all(claimId) as unknown as ActionRow[];
}

export function claimTimeline(claimId: string) {
  return db().prepare('SELECT at, kind, title, detail FROM timeline_events WHERE claim_id = ? ORDER BY at, rowid').all(claimId) as unknown as {
    at: string;
    kind: string;
    title: string;
    detail: string | null;
  }[];
}

function publicEvidence(row: EvidenceRow) {
  const r = row as EvidenceRow & { capture_meta?: string | null };
  const challenge = row.challenge_id
    ? (db().prepare('SELECT code, action FROM challenges WHERE id = ?').get(row.challenge_id) as { code: string; action: string } | undefined)
    : undefined;
  return {
    id: row.id,
    source: row.source,
    layer: row.layer as Layer,
    shotLabel: row.shot_label,
    sha256: row.sha256,
    createdAt: row.created_at,
    captureMeta: json<Record<string, unknown> | null>(r.capture_meta, null),
    challenge: challenge ?? null,
  };
}
export type PublicEvidence = ReturnType<typeof publicEvidence>;

export function claimDetail(id: string) {
  const claim = getClaim(id);
  if (!claim) return null;
  const order = getOrder(claim.order_id)!;
  const verdict = latestVerdict(id);
  return {
    claim: {
      id: claim.id,
      origin: claim.origin,
      type: claim.claim_type,
      narrative: claim.narrative,
      status: claim.status,
      disputeId: claim.paypal_dispute_id,
      dueAt: claim.due_at,
      createdAt: claim.created_at,
      scenario: json<ScenarioMeta | null>(claim.scenario, null),
    },
    order: {
      id: order.id,
      orderNo: order.order_no,
      paypalEnv: order.paypal_env,
      captureId: order.capture_id,
      buyerName: order.buyer_name,
      amount: order.amount,
      currency: order.currency,
      items: json<OrderItem[]>(order.items, []),
      address: json<{ city?: string; postalCode?: string; line1?: string } | null>(order.ship_address, null),
      carrier: order.carrier,
      trackingNumber: order.tracking_number,
      createdAt: order.created_at,
      shippedWeightG: order.shipped_weight_g,
    },
    evidence: claimEvidence(id).map(publicEvidence),
    references: orderReferences(claim.order_id).map(publicEvidence),
    signals: claimSignals(id),
    runs: claimRuns(id),
    verdict: verdict
      ? { id: verdict.id, createdAt: verdict.created_at, report: JSON.parse(verdict.report) as VerdictReport }
      : null,
    actions: claimActions(id).map((a) => ({
      id: a.id,
      type: a.type,
      status: a.status,
      confirmedBy: a.confirmed_by,
      confirmedAt: a.confirmed_at,
      payload: json<Record<string, unknown>>(a.payload, {}),
      response: json<Record<string, unknown> | null>(a.paypal_response, null),
    })),
    timeline: claimTimeline(id),
  };
}
export type ClaimDetail = NonNullable<ReturnType<typeof claimDetail>>;

export interface ClaimListItem {
  id: string;
  orderNo: string;
  orderId: string;
  product: string;
  type: ClaimType;
  origin: ClaimOrigin;
  status: ClaimStatus;
  dueAt: string | null;
  createdAt: string;
  amount: number;
  currency: string;
  level: VerdictLevel | null;
  score: number | null;
  dataConfidence: number | null;
  merchantRisk: number | null;
  incomplete: boolean;
  scenarioTitle: string | null;
  paypalEnv: PayPalEnv;
}

export function listClaims(): ClaimListItem[] {
  const rows = db()
    .prepare(
      `SELECT c.*, o.order_no, o.items, o.amount, o.currency, o.paypal_env,
         v.level, v.score, v.data_confidence, v.merchant_risk, v.incomplete
       FROM claims c
       JOIN orders o ON o.id = c.order_id
       LEFT JOIN verdicts v ON v.id = (SELECT id FROM verdicts WHERE claim_id = c.id ORDER BY seq DESC LIMIT 1)`,
    )
    .all() as unknown as (ClaimRow & {
    order_no: string;
    items: string;
    amount: number;
    currency: string;
    paypal_env: PayPalEnv;
    level: VerdictLevel | null;
    score: number | null;
    data_confidence: number | null;
    merchant_risk: number | null;
    incomplete: number | null;
  })[];
  return rows
    .map((r) => ({ r, scenario: json<ScenarioMeta | null>(r.scenario, null) }))
    .filter(({ scenario }) => !scenario?.history)
    .map(({ r, scenario }) => ({
      id: r.id,
      orderNo: r.order_no,
      orderId: r.order_id,
      product: json<OrderItem[]>(r.items, [])[0]?.title ?? '',
      type: r.claim_type,
      origin: r.origin,
      status: r.status,
      dueAt: r.due_at,
      createdAt: r.created_at,
      amount: r.amount,
      currency: r.currency,
      level: r.level,
      score: r.score,
      dataConfidence: r.data_confidence,
      merchantRisk: r.merchant_risk,
      incomplete: !!r.incomplete,
      scenarioTitle: scenario?.title ?? null,
      paypalEnv: r.paypal_env,
    }))
    .sort((a, b) => {
      // 文档要求默认按 PayPal 响应截止时间排序；没有截止时间的排后面。
      if (a.dueAt && b.dueAt) return a.dueAt.localeCompare(b.dueAt);
      if (a.dueAt) return -1;
      if (b.dueAt) return 1;
      return b.createdAt.localeCompare(a.createdAt);
    });
}

export function listOrders() {
  const rows = db()
    .prepare(
      `SELECT o.*, (SELECT COUNT(*) FROM claims c WHERE c.order_id = o.id) AS claim_count,
         (SELECT COUNT(*) FROM evidence e WHERE e.order_id = o.id AND e.source = 'reference') AS reference_count
       FROM orders o ORDER BY o.order_no`,
    )
    .all() as unknown as (OrderRow & { claim_count: number; reference_count: number })[];
  return rows
    .filter((r) => !isHistoryOrder(r.id))
    .map((r) => ({
      id: r.id,
      orderNo: r.order_no,
      product: json<OrderItem[]>(r.items, [])[0]?.title ?? '',
      amount: r.amount,
      currency: r.currency,
      buyerName: r.buyer_name,
      trackingNumber: r.tracking_number,
      shippedWeightG: r.shipped_weight_g,
      claimCount: r.claim_count,
      referenceCount: r.reference_count,
      paypalEnv: r.paypal_env,
      paid: !!r.capture_id,
      createdAt: r.created_at,
    }));
}

function isHistoryOrder(orderId: string): boolean {
  const rows = db().prepare('SELECT scenario FROM claims WHERE order_id = ?').all(orderId) as unknown as { scenario: string | null }[];
  return rows.length > 0 && rows.every((r) => json<ScenarioMeta | null>(r.scenario, null)?.history);
}
