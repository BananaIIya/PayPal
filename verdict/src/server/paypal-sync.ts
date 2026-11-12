// 把 PayPal 沙箱的争议同步成本地索赔。两个入口：webhook 和定时拉取。
// 本地开发收不到 webhook，所以定时拉取是主路径，webhook 只是让更新来得更快。
import type { DisputeView } from '@/paypal/client';
import { getSandboxClient } from '@/paypal/sandbox';
import { isDeletedDispute } from './data-retention';
import { db, kvGet, kvSet, newId, nowIso } from './db';
import { CLAIM_TYPE_BY_REASON, createClaim, type WebhookOutcome } from './ingest';
import { startAnalysis } from './pipeline';
import { addTimeline, type ClaimRow, type OrderRow } from './repo';

const DISPUTE_EVENTS = new Set(['CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED']);
const REFUND_EVENT = 'PAYMENT.CAPTURE.REFUNDED';

export type UpsertResult =
  | { outcome: 'created' | 'linked' | 'updated' | 'unchanged'; claimId: string }
  | { outcome: 'skipped'; reason: string };

function findSandboxOrder(view: DisputeView): OrderRow | undefined {
  for (const transactionId of view.transactionIds) {
    const row = db().prepare("SELECT * FROM orders WHERE capture_id = ? AND paypal_env = 'sandbox'").get(transactionId) as OrderRow | undefined;
    if (row) return row;
  }
  return undefined;
}

/** 争议对应的交易不是从 Verdict 下的单（比如手工转账）时，建一笔最小订单让它能进入流程。 */
function importOrder(view: DisputeView): OrderRow {
  const merchant = db().prepare('SELECT id FROM merchants ORDER BY rowid LIMIT 1').get() as { id: string };
  const id = newId();
  const item = view.item;
  db()
    .prepare(
      `INSERT INTO orders (id, merchant_id, order_no, capture_id, buyer_name, items, category, amount, currency, paypal_env, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'general', ?, ?, 'sandbox', ?)`,
    )
    .run(
      id,
      merchant.id,
      `SB-${view.id}`,
      view.transactionIds[0] ?? null,
      view.buyerName,
      JSON.stringify([{ sku: item?.id ?? 'UNKNOWN', title: item?.title ?? 'PayPal sandbox transaction', quantity: item?.quantity ?? 1 }]),
      view.amount ?? 0,
      view.currency ?? 'USD',
      nowIso(),
    );
  return db().prepare('SELECT * FROM orders WHERE id = ?').get(id) as unknown as OrderRow;
}

function saveBuyerMessages(orderId: string, view: DisputeView): void {
  const conn = db();
  for (const m of view.messages) {
    if (m.postedBy !== 'BUYER' || !m.content) continue;
    const seen = m.at
      ? conn.prepare("SELECT 1 FROM messages WHERE order_id = ? AND sender = 'buyer' AND text = ? AND created_at = ?").get(orderId, m.content, m.at)
      : conn.prepare("SELECT 1 FROM messages WHERE order_id = ? AND sender = 'buyer' AND text = ?").get(orderId, m.content);
    if (!seen) {
      conn
        .prepare("INSERT INTO messages (id, order_id, sender, text, created_at) VALUES (?, ?, 'buyer', ?, ?)")
        .run(newId(), orderId, m.content, m.at ?? nowIso());
    }
  }
}

function storeDisputeFields(claimId: string, view: DisputeView): void {
  db()
    .prepare('UPDATE claims SET due_at = ?, paypal_updated_at = ?, paypal_status = ? WHERE id = ?')
    .run(view.dueAt, view.updatedAt, view.status, claimId);
}

function updateExisting(claim: ClaimRow, view: DisputeView): UpsertResult {
  const conn = db();
  const statusChanged = claim.paypal_status !== view.status;
  const unchanged = !statusChanged && claim.paypal_updated_at === view.updatedAt && claim.due_at === view.dueAt;
  saveBuyerMessages(claim.order_id, view);
  storeDisputeFields(claim.id, view);

  if (statusChanged && claim.paypal_status) {
    addTimeline(claim.id, 'dispute', 'PayPal dispute status updated', `${claim.paypal_status} → ${view.status} (${view.stage})`);
  }
  if (view.status === 'RESOLVED') {
    if (claim.status !== 'closed') {
      conn.prepare("UPDATE claims SET status = 'closed' WHERE id = ?").run(claim.id);
      addTimeline(claim.id, 'dispute', 'PayPal dispute closed', view.outcome ?? undefined);
    }
  } else if (statusChanged && view.status === 'WAITING_FOR_SELLER_RESPONSE' && claim.status === 'action_sent') {
    // 只在状态真正变回“等商家”时才转回去。刚提交证据时 PayPal 的状态可能还没变，不能算回到商家这边。
    conn.prepare("UPDATE claims SET status = 'awaiting_decision' WHERE id = ?").run(claim.id);
  }
  // 只补空缺，不覆盖买家在索赔页写的描述。
  if (view.buyerMessage && !claim.narrative) {
    conn.prepare('UPDATE claims SET narrative = ? WHERE id = ?').run(view.buyerMessage, claim.id);
    startAnalysis(claim.id);
    return { outcome: 'updated', claimId: claim.id };
  }
  return { outcome: unchanged ? 'unchanged' : 'updated', claimId: claim.id };
}

function skipReason(input: { reason?: string; status?: string }): string | null {
  if (input.status === 'RESOLVED') return 'This dispute is closed';
  if (input.reason && !CLAIM_TYPE_BY_REASON[input.reason]) return `Verdict does not handle ${input.reason} disputes yet. Handle it in the PayPal dashboard`;
  return null;
}

/**
 * 整个函数没有 await：同一笔争议的 webhook 和定时同步交替进来，也只会建一笔索赔。
 * paypal_dispute_id 上还有 UNIQUE 约束兜底。
 */
export function upsertClaimFromDispute(view: DisputeView): UpsertResult {
  const conn = db();
  const existing = conn.prepare('SELECT * FROM claims WHERE paypal_dispute_id = ?').get(view.id) as ClaimRow | undefined;
  if (existing) return updateExisting(existing, view);
  // 商家删除过这笔索赔的数据，争议后来又有更新（比如申诉）时不能悄悄导回来。
  if (isDeletedDispute(view.id)) return { outcome: 'skipped', reason: 'The merchant deleted this dispute\'s data in Verdict' };

  const skip = skipReason(view);
  if (skip) return { outcome: 'skipped', reason: skip };
  const type = CLAIM_TYPE_BY_REASON[view.reason];

  const order = findSandboxOrder(view) ?? importOrder(view);
  saveBuyerMessages(order.id, view);

  // 买家先在索赔页交了证据、后来才开争议时，把争议挂到原来的索赔上，证据不丢。
  const open = conn
    .prepare("SELECT * FROM claims WHERE order_id = ? AND paypal_dispute_id IS NULL AND status != 'closed' ORDER BY created_at DESC LIMIT 1")
    .get(order.id) as ClaimRow | undefined;
  if (open) {
    conn.prepare('UPDATE claims SET paypal_dispute_id = ? WHERE id = ?').run(view.id, open.id);
    storeDisputeFields(open.id, view);
    addTimeline(open.id, 'dispute', 'PayPal dispute linked', `${view.id} (${view.reason})`);
    startAnalysis(open.id);
    return { outcome: 'linked', claimId: open.id };
  }

  const claimId = createClaim({
    merchantId: order.merchant_id,
    orderId: order.id,
    origin: 'paypal_dispute',
    type,
    narrative: view.buyerMessage,
    disputeId: view.id,
    dueAt: view.dueAt,
    status: 'analyzing',
  });
  storeDisputeFields(claimId, view);
  addTimeline(claimId, 'dispute', 'PayPal dispute received', `${view.id} (${view.reason})`);
  startAnalysis(claimId);
  return { outcome: 'created', claimId };
}

// ---------- Webhook ----------

export async function handleSandboxWebhook(raw: string, headers: { get(name: string): string | null }): Promise<WebhookOutcome> {
  const client = getSandboxClient();
  if (!client) return { status: 401, body: { error: 'PayPal sandbox is not configured' } };

  let verified: boolean;
  try {
    verified = await client.verifyWebhook(raw, headers);
  } catch {
    // 验签接口暂时不可用。返回 5xx，让 PayPal 稍后重发。
    return { status: 503, body: { error: 'Cannot verify the signature right now' } };
  }
  if (!verified) return { status: 401, body: { error: 'Signature verification failed' } };

  const event = JSON.parse(raw) as { id: string; event_type: string; resource?: { dispute_id?: string; id?: string; status?: string } };
  const disputeId = event.resource?.dispute_id ?? event.resource?.id ?? null;
  const conn = db();
  const seen = conn.prepare('SELECT processed_at FROM paypal_events WHERE id = ?').get(event.id) as { processed_at: string | null } | undefined;
  if (seen?.processed_at) return { status: 200, body: { duplicate: true } };
  if (!seen) {
    conn
      .prepare('INSERT INTO paypal_events (id, event_type, resource_id, payload, received_at) VALUES (?, ?, ?, ?, ?)')
      .run(event.id, event.event_type, disputeId, raw, nowIso());
  }

  const markProcessed = () => conn.prepare('UPDATE paypal_events SET processed_at = ? WHERE id = ?').run(nowIso(), event.id);
  if (event.event_type === REFUND_EVENT) {
    const refundId = event.resource?.id;
    if (refundId) {
      try {
        const status = event.resource?.status;
        if (status && status !== 'PENDING') applyRefundOutcome(refundId, status);
        else await refreshRefund(refundId);
      } catch {
        return { status: 503, body: { error: 'Cannot confirm the refund result right now' } };
      }
    }
    markProcessed();
    return { status: 200, body: { received: true } };
  }
  if (!DISPUTE_EVENTS.has(event.event_type) || !disputeId) {
    markProcessed();
    return { status: 200, body: { ignored: true } };
  }

  let view: DisputeView | null;
  try {
    view = await client.getDispute(disputeId, { fresh: true });
  } catch {
    // 没有标记为已处理，PayPal 重发时会再处理一次。
    return { status: 503, body: { error: 'Cannot read dispute details right now' } };
  }
  if (!view) {
    markProcessed();
    return { status: 200, body: { ignored: true, reason: 'Dispute not found' } };
  }
  const result = upsertClaimFromDispute(view);
  markProcessed();
  return { status: 200, body: { received: true, ...result } };
}

// ---------- 定时同步 ----------

const SYNC_KEY = 'paypal_sync';
const PAGE_SIZE = 50;
const MAX_PAGES = 5;
// 实测新争议要过约 3 分钟才会出现在列表里。PayPal 没有承诺这个延迟，服务也可能停过一段时间，
// 所以留足 24 小时。没变化的争议不会再拉详情，重复列出的代价很小。
const OVERLAP_MS = 24 * 3600 * 1000;

export interface SyncState {
  cursor: string | null;
  lastRunAt: string;
  ok: boolean;
  created: number;
  updated: number;
  skipped: { id: string; reason: string }[];
  error: string | null;
}

export function lastSync(): SyncState | null {
  return kvGet<SyncState>(SYNC_KEY);
}

async function runSync(): Promise<SyncState> {
  const client = getSandboxClient();
  if (!client) throw new Error('The PayPal sandbox is not configured or is misconfigured');

  const previous = lastSync();
  const startedAt = Date.now();
  const state: SyncState = {
    cursor: previous?.cursor ?? null,
    lastRunAt: new Date(startedAt).toISOString(),
    ok: true,
    created: 0,
    updated: 0,
    skipped: [],
    error: null,
  };
  const updatedAfter = previous?.cursor ? new Date(new Date(previous.cursor).getTime() - OVERLAP_MS).toISOString() : undefined;

  try {
    let complete = false;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { items, hasNext } = await client.listDisputes({ page, pageSize: PAGE_SIZE, updatedAfter });
      for (const summary of items) {
        const known = db().prepare('SELECT paypal_updated_at FROM claims WHERE paypal_dispute_id = ?').get(summary.dispute_id) as
          | { paypal_updated_at: string | null }
          | undefined;
        if (known && summary.update_time && known.paypal_updated_at === summary.update_time) continue;
        // 不会建索赔的争议不用拉详情，否则在重叠窗口内每分钟都要多发一次请求。
        const skip = known ? null : skipReason(summary);
        if (skip) {
          state.skipped.push({ id: summary.dispute_id, reason: skip });
          continue;
        }
        const view = await client.getDispute(summary.dispute_id, { fresh: true });
        if (!view) continue;
        const result = upsertClaimFromDispute(view);
        if (result.outcome === 'created' || result.outcome === 'linked') state.created += 1;
        else if (result.outcome === 'updated') state.updated += 1;
        else if (result.outcome === 'skipped') state.skipped.push({ id: summary.dispute_id, reason: result.reason });
      }
      if (!hasNext) {
        complete = true;
        break;
      }
    }
    if (complete) state.cursor = new Date(startedAt).toISOString();
    else state.error = `Disputes exceed ${MAX_PAGES} pages. This run did not finish; the next run will continue.`;
    await settleProcessingRefunds();
  } catch (e) {
    // 游标不前进，下一轮会重新处理这段时间内的争议。
    state.ok = false;
    state.error = e instanceof Error ? e.message : String(e);
  }
  kvSet(SYNC_KEY, state);
  return state;
}

const g = globalThis as unknown as { __verdictSyncRun?: Promise<SyncState> };

/** 手动点同步和定时同步撞在一起时，共用同一轮。 */
interface ProcessingRefund {
  id: string;
  claim_id: string;
  type: string;
  paypal_response: string | null;
}

function processingRefund(refundId: string): ProcessingRefund | undefined {
  return db()
    .prepare(
      `SELECT id, claim_id, type, paypal_response FROM actions
       WHERE status = 'processing' AND json_extract(paypal_response, '$.refund_id') = ?`,
    )
    .get(refundId) as ProcessingRefund | undefined;
}

/** 把一笔处理中的退款收成最终结果。PENDING 和认不出的状态保持不动。 */
function applyRefundOutcome(refundId: string, status: string): void {
  if (!status || status === 'PENDING') return;
  const action = processingRefund(refundId);
  if (!action) return;
  const stored = action.paypal_response ? (JSON.parse(action.paypal_response) as Record<string, unknown>) : {};
  stored.status = status;
  if (status === 'COMPLETED') {
    const after =
      action.type === 'make_offer'
        ? { status: 'action_sent', title: 'Merchant made an offer' }
        : { status: 'closed', title: 'Merchant confirmed refund' };
    db().prepare("UPDATE actions SET status = 'succeeded', paypal_response = ? WHERE id = ?").run(JSON.stringify(stored), action.id);
    db().prepare('UPDATE claims SET status = ? WHERE id = ?').run(after.status, action.claim_id);
    addTimeline(action.claim_id, 'action', 'Refund completed', after.title);
    return;
  }
  if (status === 'FAILED' || status === 'CANCELLED') {
    db().prepare("UPDATE actions SET status = 'failed', paypal_response = ? WHERE id = ?").run(JSON.stringify(stored), action.id);
    addTimeline(action.claim_id, 'action', 'Refund not completed', `PayPal refund status is ${status}. The claim was not closed`);
  }
}

async function refreshRefund(refundId: string): Promise<void> {
  const client = getSandboxClient();
  if (!client) return;
  const body = await client.getRefund(refundId);
  if (body.status) applyRefundOutcome(refundId, body.status);
}

/** 查询仍在处理中的退款。查询失败时保持处理中，下一轮再确认。 */
export async function settleProcessingRefunds(): Promise<void> {
  const client = getSandboxClient();
  if (!client) return;
  const rows = db().prepare("SELECT paypal_response FROM actions WHERE status = 'processing'").all() as { paypal_response: string | null }[];
  for (const row of rows) {
    let refundId: string | undefined;
    try {
      refundId = (JSON.parse(row.paypal_response ?? '{}') as { refund_id?: string }).refund_id;
    } catch {
      continue;
    }
    if (!refundId) continue;
    try {
      await refreshRefund(refundId);
    } catch {
      /* 保持处理中 */
    }
  }
}

export function syncSandboxDisputes(): Promise<SyncState> {
  g.__verdictSyncRun ??= runSync().finally(() => {
    g.__verdictSyncRun = undefined;
  });
  return g.__verdictSyncRun;
}
