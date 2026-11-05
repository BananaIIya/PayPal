// PayPal 接口的抽象。有两个实现：simulator（演示数据）和 sandbox（真实沙箱）。
// 一笔订单走哪个实现由 orders.paypal_env 决定，模拟数据不会发往沙箱，沙箱数据也不会落到模拟器。
// 写接口只有动作执行器（server/actions.ts）可以调用。
import type { ActionType } from '@/core/types';

export type PayPalEnv = 'simulator' | 'sandbox';

export interface DisputeMessage {
  postedBy: string;
  at: string | null;
  content: string;
}

export interface DisputeView {
  id: string;
  /** 本地订单 ID。只有模拟器知道；沙箱争议靠 transactionIds 匹配订单。 */
  orderId: string | null;
  transactionIds: string[];
  reason: string;
  status: string;
  stage: string;
  dueAt: string | null;
  updatedAt: string | null;
  buyerMessage: string | null;
  messages: DisputeMessage[];
  amount: number | null;
  currency: string | null;
  buyerName: string | null;
  item: { id: string | null; title: string | null; quantity: number } | null;
  /** 由 HATEOAS 链接和 allowed_response_options 得出。 */
  allowedActions: ActionType[];
  offerTypes: string[];
  outcome: string | null;
  /** 只有沙箱才有的测试接口，PayPal 给了链接才可用。 */
  sandboxTools: { requireEvidence: boolean; adjudicate: boolean };
  log: { at: string; op: string; detail: unknown }[];
}

export interface PayPalDocument {
  name: string;
  mime: string;
  data: Buffer;
}

export interface PayPalWriteResult {
  simulated: boolean;
  environment: PayPalEnv;
  operation: string;
  [k: string]: unknown;
}

export class PayPalApiError extends Error {
  readonly status: number | null;
  readonly issue: string | null;
  readonly debugId: string | null;
  /**
   * 请求可能已经生效（超时、连接中断、5xx）。
   * 这种情况不能当作失败让商家重试，否则可能重复退款。
   */
  readonly indeterminate: boolean;

  constructor(
    message: string,
    opts: { status?: number | null; issue?: string | null; debugId?: string | null; indeterminate?: boolean } = {},
  ) {
    super(message);
    this.name = 'PayPalApiError';
    this.status = opts.status ?? null;
    this.issue = opts.issue ?? null;
    this.debugId = opts.debugId ?? null;
    this.indeterminate = opts.indeterminate ?? false;
  }
}

export interface PayPalClient {
  readonly name: string;
  getDispute(id: string, opts?: { fresh?: boolean }): Promise<DisputeView | null>;
  sendMessage(disputeId: string, message: string, requestId: string): Promise<PayPalWriteResult>;
  provideEvidence(
    disputeId: string,
    input: { evidenceType: string; notes: string; documents: PayPalDocument[]; trackingNumber?: string; carrier?: string },
    requestId: string,
  ): Promise<PayPalWriteResult>;
  makeOffer(disputeId: string, input: { amount: number; currency: string; note: string }, requestId: string): Promise<PayPalWriteResult>;
  acceptClaim(disputeId: string, note: string, requestId: string): Promise<PayPalWriteResult>;
  escalate(disputeId: string, note: string, requestId: string): Promise<PayPalWriteResult>;
  refundCapture(captureId: string, input: { amount: number; currency: string }, requestId: string): Promise<PayPalWriteResult>;
}
