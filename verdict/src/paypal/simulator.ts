// PayPal 模拟器：行为对齐开发文档列出的争议接口，状态存在本地 SQLite，不产生任何真实资金流动。
import crypto from 'node:crypto';
import type { ActionType } from '@/core/types';
import { db, json, newId, nowIso } from '@/server/db';
import type { DisputeView, PayPalClient, PayPalDocument, PayPalWriteResult } from './client';

interface DisputeRow {
  id: string;
  order_id: string;
  reason: string;
  status: string;
  stage: string;
  due_at: string | null;
  buyer_message: string | null;
  log: string;
}

export function signSimulatedWebhook(body: string): string {
  return crypto.createHmac('sha256', webhookSecret()).update(body).digest('hex');
}

export function verifySimulatedWebhook(body: string, signature: string | null): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signSimulatedWebhook(body));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function webhookSecret(): string {
  const g = globalThis as unknown as { __verdictSimWebhookSecret?: string };
  g.__verdictSimWebhookSecret ??= crypto.randomBytes(32).toString('hex');
  return g.__verdictSimWebhookSecret;
}

function allowed(row: DisputeRow): ActionType[] {
  if (row.status === 'WAITING_FOR_SELLER_RESPONSE') {
    return ['send_message', 'provide_evidence', 'make_offer', 'accept_claim', 'escalate'];
  }
  if (row.status === 'WAITING_FOR_BUYER_RESPONSE') return ['send_message', 'accept_claim', 'escalate'];
  if (row.status === 'UNDER_REVIEW') return ['accept_claim'];
  return [];
}

function load(id: string): DisputeRow | undefined {
  return db().prepare('SELECT * FROM sim_disputes WHERE id = ?').get(id) as DisputeRow | undefined;
}

function toView(row: DisputeRow): DisputeView {
  return {
    id: row.id,
    orderId: row.order_id,
    transactionIds: [],
    reason: row.reason,
    status: row.status,
    stage: row.stage,
    dueAt: row.due_at,
    updatedAt: null,
    buyerMessage: row.buyer_message,
    messages: [],
    amount: null,
    currency: null,
    buyerName: null,
    item: null,
    allowedActions: allowed(row),
    offerTypes: ['REFUND'],
    outcome: null,
    sandboxTools: { requireEvidence: false, adjudicate: false },
    log: json(row.log, []),
  };
}

class SimulatorError extends Error {}

export class PayPalSimulator implements PayPalClient {
  readonly name = 'PayPal 模拟器';

  async getDispute(id: string): Promise<DisputeView | null> {
    const row = load(id);
    return row ? toView(row) : null;
  }

  /** PayPal-Request-Id 幂等：同一个请求 ID 只生效一次，重复调用返回第一次的结果。 */
  private idempotent(requestId: string, op: () => PayPalWriteResult): PayPalWriteResult {
    const seen = db().prepare('SELECT response FROM sim_requests WHERE request_id = ?').get(requestId) as
      | { response: string }
      | undefined;
    if (seen) return { ...JSON.parse(seen.response), idempotentReplay: true };
    const res = op();
    db().prepare('INSERT INTO sim_requests (request_id, response) VALUES (?, ?)').run(requestId, JSON.stringify(res));
    return res;
  }

  private mutate(
    disputeId: string,
    action: ActionType,
    requestId: string,
    operation: string,
    detail: unknown,
    next?: { status?: string; stage?: string },
  ): PayPalWriteResult {
    return this.idempotent(requestId, () => {
      const row = load(disputeId);
      if (!row) throw new SimulatorError(`争议不存在：${disputeId}`);
      if (!allowed(row).includes(action)) throw new SimulatorError(`争议状态 ${row.status} 不允许 ${action}`);
      const log = json<unknown[]>(row.log, []);
      log.push({ at: nowIso(), op: operation, detail });
      db()
        .prepare('UPDATE sim_disputes SET status = ?, stage = ?, log = ? WHERE id = ?')
        .run(next?.status ?? row.status, next?.stage ?? row.stage, JSON.stringify(log), disputeId);
      return {
        simulated: true,
        environment: 'simulator',
        operation,
        dispute_id: disputeId,
        status: next?.status ?? row.status,
        request_id: requestId,
      };
    });
  }

  async sendMessage(disputeId: string, message: string, requestId: string) {
    return this.mutate(disputeId, 'send_message', requestId, `POST /v1/customer/disputes/${disputeId}/send-message`, { message });
  }

  async provideEvidence(
    disputeId: string,
    input: { evidenceType: string; notes: string; documents: PayPalDocument[]; trackingNumber?: string; carrier?: string },
    requestId: string,
  ) {
    const detail = { ...input, documents: input.documents.map((d) => d.name) };
    return this.mutate(disputeId, 'provide_evidence', requestId, `POST /v1/customer/disputes/${disputeId}/provide-evidence`, detail, {
      status: 'UNDER_REVIEW',
    });
  }

  async makeOffer(disputeId: string, input: { amount: number; currency: string; note: string }, requestId: string) {
    return this.mutate(disputeId, 'make_offer', requestId, `POST /v1/customer/disputes/${disputeId}/make-offer`, input, {
      status: 'WAITING_FOR_BUYER_RESPONSE',
    });
  }

  async acceptClaim(disputeId: string, note: string, requestId: string) {
    return this.mutate(disputeId, 'accept_claim', requestId, `POST /v1/customer/disputes/${disputeId}/accept-claim`, { note }, {
      status: 'RESOLVED',
    });
  }

  async escalate(disputeId: string, note: string, requestId: string) {
    return this.mutate(disputeId, 'escalate', requestId, `POST /v1/customer/disputes/${disputeId}/escalate`, { note }, {
      status: 'UNDER_REVIEW',
      stage: 'CHARGEBACK',
    });
  }

  async refundCapture(captureId: string, input: { amount: number; currency: string }, requestId: string) {
    return this.idempotent(requestId, () => {
      const order = db().prepare('SELECT amount FROM orders WHERE capture_id = ?').get(captureId) as { amount: number } | undefined;
      if (!order) throw new SimulatorError(`捕获记录不存在：${captureId}`);
      const refunded = db().prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM sim_refunds WHERE capture_id = ?').get(captureId) as {
        total: number;
      };
      if (input.amount <= 0 || input.amount + refunded.total > order.amount + 0.001) {
        throw new SimulatorError(`退款金额超出可退余额（可退 ${(order.amount - refunded.total).toFixed(2)}）`);
      }
      const id = `SIM-REFUND-${newId().slice(0, 8)}`;
      db().prepare('INSERT INTO sim_refunds (id, capture_id, amount, created_at) VALUES (?, ?, ?, ?)').run(id, captureId, input.amount, nowIso());
      return {
        simulated: true,
        environment: 'simulator',
        operation: `POST /v2/payments/captures/${captureId}/refund`,
        refund_id: id,
        status: 'COMPLETED',
        amount: input,
        request_id: requestId,
      };
    });
  }
}

export function createSimulatedDispute(input: {
  orderId: string;
  reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' | 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED';
  buyerMessage: string;
  dueAt: string;
}): string {
  const id = `PP-D-SIM-${newId().slice(0, 8).toUpperCase()}`;
  db()
    .prepare(
      `INSERT INTO sim_disputes (id, order_id, reason, status, stage, due_at, buyer_message, log)
       VALUES (?, ?, ?, 'WAITING_FOR_SELLER_RESPONSE', 'INQUIRY', ?, ?, '[]')`,
    )
    .run(id, input.orderId, input.reason, input.dueAt, input.buyerMessage);
  return id;
}

export function getPayPalClient(): PayPalClient {
  return new PayPalSimulator();
}
