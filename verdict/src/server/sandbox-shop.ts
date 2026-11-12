// 沙箱测试下单，相当于文档里的 demo-shop：买家用沙箱个人账户真实付款，得到一笔能开争议的交易。
// 物流仍是模拟的：Verdict 没有接真实承运商，付款成功后生成一条已签收的轨迹。
import crypto from 'node:crypto';
import { requireSandbox } from '@/paypal';
import type { PayPalCaptureState } from '@/paypal/sandbox';
import type { TrackingResult } from '@/providers/types';
import { db, newId, nowIso } from './db';
import type { OrderRow } from './repo';

export interface TestProduct {
  key: string;
  sku: string;
  title: string;
  material: string;
  color: string;
  model: string;
  weightG: number;
  category: string;
  amount: number;
}

export const TEST_PRODUCTS: TestProduct[] = [
  { key: 'mug', sku: 'SB-MUG', title: 'Handmade celadon mug', material: 'Ceramic', color: 'Celadon green', model: 'Celadon mug 350ml', weightG: 420, category: 'ceramics', amount: 39 },
  { key: 'buds', sku: 'SB-BUDS', title: 'AirBuds Pro wireless earbuds', material: 'Plastic and electronics', color: 'White', model: 'AirBuds Pro 2', weightG: 90, category: 'electronics', amount: 129 },
  { key: 'jacket', sku: 'SB-JACKET', title: 'Short wool jacket', material: 'Wool', color: 'Navy', model: 'Short, size M', weightG: 900, category: 'apparel', amount: 189 },
];

export async function createTestOrder(productKey: string, origin: string): Promise<{ orderId: string; approveUrl: string }> {
  const product = TEST_PRODUCTS.find((p) => p.key === productKey);
  if (!product) throw new Error('Unknown test product');
  const client = requireSandbox();
  const merchant = db().prepare('SELECT id FROM merchants ORDER BY rowid LIMIT 1').get() as { id: string };
  const id = newId();
  const orderNo = `SB-${Date.now().toString(36).toUpperCase()}`;
  const created = await client.createOrder({
    invoiceId: orderNo,
    localId: id,
    title: product.title,
    sku: product.sku,
    amount: product.amount,
    currency: 'USD',
    returnUrl: `${origin}/api/paypal/return`,
    cancelUrl: `${origin}/api/paypal/cancel`,
  });
  const snapshot = { title: product.title, description: `${product.title}, ${product.color}. Description at time of order.`, color: product.color, model: product.model };
  db()
    .prepare(
      `INSERT INTO orders (id, merchant_id, order_no, paypal_order_id, items, listing_snapshot, current_listing, category, amount, currency, paypal_env, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', 'sandbox', ?)`,
    )
    .run(
      id,
      merchant.id,
      orderNo,
      created.id,
      JSON.stringify([{ sku: product.sku, title: product.title, quantity: 1, material: product.material, color: product.color, model: product.model, weightG: product.weightG }]),
      JSON.stringify(snapshot),
      JSON.stringify(snapshot),
      product.category,
      product.amount,
      nowIso(),
    );
  return { orderId: id, approveUrl: created.approveUrl };
}

function findByPayPalOrder(token: string): OrderRow | undefined {
  return db().prepare("SELECT * FROM orders WHERE paypal_order_id = ? AND paypal_env = 'sandbox'").get(token) as OrderRow | undefined;
}

/** 买家付款后回到这里。捕获请求带固定的请求 ID，重复访问不会重复扣款。 */
export async function completeTestOrder(token: string): Promise<{ orderId: string }> {
  const order = findByPayPalOrder(token);
  if (!order) throw new Error('Test order not found. It may have been reset');
  if (order.capture_id) return { orderId: order.id };

  const captured = await requireSandbox().captureOrder(token, `capture-${order.id}`);
  const items = JSON.parse(order.items) as { weightG?: number }[];
  const weightG = items[0]?.weightG;
  // 轨迹不能早于订单行。两边各取一次时钟时，后写的下单时间会比先取的揽收时间晚几毫秒。
  const createdMs = new Date(order.created_at).getTime();
  const paidAt = Math.max(Date.now(), Number.isNaN(createdMs) ? 0 : createdMs);
  const postalCode = captured.address?.postalCode;
  const tracking: TrackingResult = {
    status: 'delivered',
    events: [
      { at: new Date(paidAt).toISOString(), description: 'Picked up (simulated)' },
      { at: new Date(paidAt + 1000).toISOString(), description: 'Delivered (simulated)' },
    ],
    deliveredAt: new Date(paidAt + 1000).toISOString(),
    deliveredPostalCode: postalCode,
    deliveredCity: captured.address?.city,
    weightG,
  };
  db()
    .prepare(
      `UPDATE orders SET capture_id = ?, buyer_name = ?, buyer_email_hash = ?, ship_address = ?,
         carrier = 'UPS', tracking_number = ?, tracking_sim = ?, shipped_weight_g = ? WHERE id = ?`,
    )
    .run(
      captured.captureId,
      captured.buyerName,
      captured.buyerEmail ? crypto.createHash('sha256').update(captured.buyerEmail.toLowerCase()).digest('hex') : null,
      captured.address ? JSON.stringify(captured.address) : null,
      `1ZSB${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
      JSON.stringify(tracking),
      weightG ?? null,
      order.id,
    );
  return { orderId: order.id };
}

const CAPTURE_LABEL: Record<string, string> = {
  COMPLETED: 'Completed',
  PENDING: 'Pending',
  REFUNDED: 'Fully refunded',
  PARTIALLY_REFUNDED: 'Partially refunded',
  DECLINED: 'Declined',
  FAILED: 'Failed',
};

const PROTECTION_LABEL: Record<string, string> = {
  ELIGIBLE: 'Seller protection',
  PARTIALLY_ELIGIBLE: 'Partial seller protection',
  NOT_ELIGIBLE: 'No seller protection',
};

export interface CaptureStateView {
  /** 给订单页看的一行字，比如“待处理 · 没有卖家保护”。 */
  summary: string;
  /** 这笔付款的状态会影响后续操作时才有。 */
  warning: string | null;
  /** 读不到状态时的原因，此时其他字段不可信。 */
  error: string | null;
}

export function describeCapture(state: PayPalCaptureState): Pick<CaptureStateView, 'summary' | 'warning'> {
  const summary = [CAPTURE_LABEL[state.status] ?? state.status, state.sellerProtection ? (PROTECTION_LABEL[state.sellerProtection] ?? state.sellerProtection) : null]
    .filter(Boolean)
    .join(' · ');
  if (state.status !== 'PENDING') return { summary, warning: null };
  if (state.reason === 'ECHECK') {
    return {
      summary,
      warning:
        'The buyer paid from a bank account (eCheck). The funds have not cleared and there is no seller protection. This payment cannot be partially refunded, and the buyer has far fewer options when opening a dispute. To test the full flow, place a new order and choose Visa on the PayPal payment page.',
    };
  }
  if (state.reason === 'BUYER_COMPLAINT') {
    return { summary, warning: 'The buyer opened a dispute and PayPal is holding these funds. The status changes only after the dispute ends.' };
  }
  return { summary, warning: `PayPal has not completed this payment (reason: ${state.reason ?? 'not given'}). Refunds and other actions may be declined.` };
}

/** 只有已付款的沙箱订单才有状态可读。读不到时不影响页面其他内容。 */
export async function captureState(order: OrderRow): Promise<CaptureStateView | null> {
  if (order.paypal_env !== 'sandbox' || !order.capture_id) return null;
  try {
    return { ...describeCapture(await requireSandbox().getCapture(order.capture_id)), error: null };
  } catch (e) {
    return { summary: 'Unavailable right now', warning: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 买家取消付款：删掉还没付款的本地订单。已付款的订单不受影响。 */
export function cancelTestOrder(token: string): void {
  db().prepare("DELETE FROM orders WHERE paypal_order_id = ? AND paypal_env = 'sandbox' AND capture_id IS NULL").run(token);
}
