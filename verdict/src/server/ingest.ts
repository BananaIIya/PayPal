// 证据入口：模拟器 webhook、买家索赔页、商家手动导入。沙箱争议的入口在 paypal-sync.ts。
import type { ClaimType } from '@/core/types';
import { createSimulatedDispute, getPayPalClient, signSimulatedWebhook, verifySimulatedWebhook } from '@/paypal/simulator';
import { db, newId, nowIso } from './db';
import { startAnalysis } from './pipeline';
import { addTimeline, getOrder } from './repo';

export const CLAIM_TYPE_BY_REASON: Record<string, ClaimType> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'not_received',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'not_as_described',
};

export function createClaim(input: {
  merchantId: string;
  orderId: string;
  origin: 'paypal_dispute' | 'portal' | 'manual_import';
  type: ClaimType;
  narrative?: string | null;
  disputeId?: string | null;
  dueAt?: string | null;
  status: string;
  scenario?: unknown;
  createdAt?: string;
  confirmedQualityIssue?: boolean;
}): string {
  const id = newId();
  db()
    .prepare(
      `INSERT INTO claims (id, merchant_id, order_id, origin, claim_type, narrative, paypal_dispute_id, status, confirmed_quality_issue, due_at, scenario, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.merchantId,
      input.orderId,
      input.origin,
      input.type,
      input.narrative ?? null,
      input.disputeId ?? null,
      input.status,
      input.confirmedQualityIssue ? 1 : 0,
      input.dueAt ?? null,
      input.scenario ? JSON.stringify(input.scenario) : null,
      input.createdAt ?? nowIso(),
    );
  return id;
}

export type WebhookOutcome = { status: number; body: Record<string, unknown> };

/** 验签 → 按事件 ID 去重 → 写库 → 拉详情 → 建索赔 → 入队。重放的事件不会重复建索赔。 */
export async function handleWebhook(rawBody: string, signature: string | null): Promise<WebhookOutcome> {
  if (!verifySimulatedWebhook(rawBody, signature)) return { status: 401, body: { error: '验签失败' } };

  const event = JSON.parse(rawBody) as { id: string; event_type: string; resource: { dispute_id: string } };
  const conn = db();
  const inserted = conn
    .prepare('INSERT OR IGNORE INTO paypal_events (id, event_type, resource_id, payload, received_at) VALUES (?, ?, ?, ?, ?)')
    .run(event.id, event.event_type, event.resource.dispute_id, rawBody, nowIso());
  if (inserted.changes === 0) return { status: 200, body: { duplicate: true } };

  const disputeId = event.resource.dispute_id;
  const dispute = await getPayPalClient().getDispute(disputeId);
  if (!dispute) return { status: 404, body: { error: '争议不存在' } };

  let claimId: string | undefined;
  if (event.event_type === 'CUSTOMER.DISPUTE.CREATED') {
    const order = dispute.orderId ? getOrder(dispute.orderId) : undefined;
    if (!order) return { status: 404, body: { error: '找不到对应订单' } };
    claimId = createClaim({
      merchantId: order.merchant_id,
      orderId: order.id,
      origin: 'paypal_dispute',
      type: CLAIM_TYPE_BY_REASON[dispute.reason] ?? 'not_as_described',
      narrative: dispute.buyerMessage,
      disputeId,
      dueAt: dispute.dueAt,
      status: 'analyzing',
    });
    addTimeline(claimId, 'dispute', 'PayPal 推送争议', `${disputeId}（${dispute.reason}）`);
    startAnalysis(claimId);
  } else if (event.event_type === 'CUSTOMER.DISPUTE.RESOLVED') {
    conn.prepare("UPDATE claims SET status = 'closed' WHERE paypal_dispute_id = ?").run(disputeId);
  }
  conn.prepare('UPDATE paypal_events SET processed_at = ? WHERE id = ?').run(nowIso(), event.id);
  return { status: 200, body: { received: true, claimId } };
}

/** 演示入口：让模拟器发起一笔争议，再走一遍真实的 webhook 处理流程。 */
export async function simulateDispute(orderId: string, reason: keyof typeof CLAIM_TYPE_BY_REASON, buyerMessage: string) {
  const dueAt = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString();
  const disputeId = createSimulatedDispute({
    orderId,
    reason: reason as 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    buyerMessage,
    dueAt,
  });
  const body = JSON.stringify({
    id: `WH-SIM-${newId()}`,
    event_type: 'CUSTOMER.DISPUTE.CREATED',
    resource: { dispute_id: disputeId },
  });
  return handleWebhook(body, signSimulatedWebhook(body));
}
