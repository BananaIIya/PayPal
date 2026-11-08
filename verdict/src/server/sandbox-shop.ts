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
  { key: 'mug', sku: 'SB-MUG', title: '手工青瓷马克杯', material: '陶瓷', color: '青瓷绿', model: '青瓷马克杯 350ml', weightG: 420, category: 'ceramics', amount: 39 },
  { key: 'buds', sku: 'SB-BUDS', title: 'AirBuds Pro 无线耳机', material: '塑料与电子元件', color: '白色', model: 'AirBuds Pro 2', weightG: 90, category: 'electronics', amount: 129 },
  { key: 'jacket', sku: 'SB-JACKET', title: '羊毛短外套', material: '羊毛', color: '藏青色', model: '短款 M 码', weightG: 900, category: 'apparel', amount: 189 },
];

export async function createTestOrder(productKey: string, origin: string): Promise<{ orderId: string; approveUrl: string }> {
  const product = TEST_PRODUCTS.find((p) => p.key === productKey);
  if (!product) throw new Error('未知的测试商品');
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
  const snapshot = { title: product.title, description: `${product.title}，${product.color}，下单时描述。`, color: product.color, model: product.model };
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
  if (!order) throw new Error('找不到这笔测试订单，可能已经被重置');
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
      { at: new Date(paidAt).toISOString(), description: '揽收（模拟）' },
      { at: new Date(paidAt + 1000).toISOString(), description: '已签收（模拟）' },
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
  COMPLETED: '已完成',
  PENDING: '待处理',
  REFUNDED: '已全额退款',
  PARTIALLY_REFUNDED: '已部分退款',
  DECLINED: '被拒绝',
  FAILED: '失败',
};

const PROTECTION_LABEL: Record<string, string> = {
  ELIGIBLE: '有卖家保护',
  PARTIALLY_ELIGIBLE: '有部分卖家保护',
  NOT_ELIGIBLE: '没有卖家保护',
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
        '买家用银行账户付款（eCheck），款项还没到账，也没有卖家保护。这种付款不能部分退款，买家发起争议时的选项也会少很多。要测试完整流程，请重新下单，并在 PayPal 付款页选 Visa。',
    };
  }
  if (state.reason === 'BUYER_COMPLAINT') {
    return { summary, warning: '买家发起了争议，PayPal 暂扣了这笔款，争议结束后状态才会变。' };
  }
  return { summary, warning: `PayPal 还没有完成这笔付款（原因：${state.reason ?? '未说明'}），退款等操作可能会被拒绝。` };
}

/** 只有已付款的沙箱订单才有状态可读。读不到时不影响页面其他内容。 */
export async function captureState(order: OrderRow): Promise<CaptureStateView | null> {
  if (order.paypal_env !== 'sandbox' || !order.capture_id) return null;
  try {
    return { ...describeCapture(await requireSandbox().getCapture(order.capture_id)), error: null };
  } catch (e) {
    return { summary: '暂时读取不到', warning: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 买家取消付款：删掉还没付款的本地订单。已付款的订单不受影响。 */
export function cancelTestOrder(token: string): void {
  db().prepare("DELETE FROM orders WHERE paypal_order_id = ? AND paypal_env = 'sandbox' AND capture_id IS NULL").run(token);
}
