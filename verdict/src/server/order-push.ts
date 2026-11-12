// 商家系统推送订单与发货信息（开发文档 POST /api/orders）。
// 下单时的商品快照只在第一次推送时保存，之后不会被覆盖：“与描述不符”只和下单时的快照比对。
import crypto from 'node:crypto';
import type { OrderItem } from '@/analyzers';
import { paypalConfig } from '@/paypal/config';
import { db, newId, nowIso } from './db';
import { startAnalysis } from './pipeline';
import { addTimeline, defaultMerchantId, type OrderRow } from './repo';

export interface OrderPushInput {
  orderNo: string;
  category: string;
  amount: number;
  currency: string;
  items: OrderItem[];
  listingSnapshot?: { title?: string; description?: string; color?: string; model?: string };
  buyer?: { name?: string; email?: string };
  shipAddress?: { line1?: string; line2?: string; city?: string; state?: string; postalCode?: string; countryCode?: string };
  shipping?: { carrier?: string; trackingNumber?: string; weightG?: number };
  paypal?: { orderId?: string; captureId?: string };
  createdAt?: string;
}

export type OrderPushResult =
  | { ok: true; status: 200 | 201; body: { orderId: string; orderNo: string; created: boolean; updated: string[]; ignored: string[] } }
  | { ok: false; status: number; body: { error: string } };

class Invalid extends Error {}

function str(value: unknown, label: string, max: number, opts: { required?: boolean; pattern?: RegExp } = {}): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (opts.required) throw new Invalid(`Missing ${label}`);
    return undefined;
  }
  if (typeof value !== 'string') throw new Invalid(`${label} must be a string`);
  const s = value.trim();
  if (opts.required && !s) throw new Invalid(`Missing ${label}`);
  if (s.length > max) throw new Invalid(`${label} must be at most ${max} characters`);
  if (s && opts.pattern && !opts.pattern.test(s)) throw new Invalid(`${label} has an invalid format`);
  return s || undefined;
}

function positive(value: unknown, label: string, max: number, opts: { integer?: boolean; required?: boolean } = {}): number | undefined {
  if (value === undefined || value === null) {
    if (opts.required) throw new Invalid(`Missing ${label}`);
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max) throw new Invalid(`${label} must be a number between 0 and ${max}`);
  if (opts.integer && !Number.isInteger(value)) throw new Invalid(`${label} must be an integer`);
  return value;
}

function obj(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export function parseOrderPush(raw: unknown): OrderPushInput {
  const body = obj(raw, 'Request body');
  if (!body) throw new Invalid('Request body must be a JSON object');
  const itemsRaw = body.items;
  if (!Array.isArray(itemsRaw) || itemsRaw.length === 0 || itemsRaw.length > 50) throw new Invalid('items must have 1 to 50 entries');
  const items = itemsRaw.map((it, i) => {
    const o = obj(it, `items[${i}]`)!;
    return compact({
      sku: str(o.sku, `items[${i}].sku`, 64, { required: true })!,
      title: str(o.title, `items[${i}].title`, 200, { required: true })!,
      quantity: positive(o.quantity ?? 1, `items[${i}].quantity`, 10_000, { integer: true })!,
      material: str(o.material, `items[${i}].material`, 80),
      color: str(o.color, `items[${i}].color`, 80),
      model: str(o.model, `items[${i}].model`, 120),
      weightG: positive(o.weightG, `items[${i}].weightG`, 1_000_000, { integer: true }),
    }) as OrderItem;
  });
  const snap = obj(body.listingSnapshot, 'listingSnapshot');
  const buyer = obj(body.buyer, 'buyer');
  const address = obj(body.shipAddress, 'shipAddress');
  const shipping = obj(body.shipping, 'shipping');
  const paypal = obj(body.paypal, 'paypal');
  const createdAt = str(body.createdAt, 'createdAt', 40);
  if (createdAt) {
    const t = Date.parse(createdAt);
    if (Number.isNaN(t)) throw new Invalid('createdAt must be an ISO 8601 time');
    if (t > Date.now() + 5 * 60 * 1000) throw new Invalid('createdAt cannot be in the future');
  }
  const email = str(buyer?.email, 'buyer.email', 254);
  if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) throw new Invalid('buyer.email has an invalid format');
  return {
    orderNo: str(body.orderNo, 'orderNo', 64, { required: true, pattern: /^[A-Za-z0-9._-]+$/ })!,
    category: str(body.category, 'category', 40, { required: true, pattern: /^[a-z0-9_-]+$/ })!,
    amount: positive(body.amount, 'amount', 1_000_000, { required: true })!,
    currency: str(body.currency, 'currency', 3, { required: true, pattern: /^[A-Z]{3}$/ })!,
    items,
    listingSnapshot: snap
      ? compact({
          title: str(snap.title, 'listingSnapshot.title', 200),
          description: str(snap.description, 'listingSnapshot.description', 5000),
          color: str(snap.color, 'listingSnapshot.color', 80),
          model: str(snap.model, 'listingSnapshot.model', 120),
        })
      : undefined,
    buyer: buyer ? compact({ name: str(buyer.name, 'buyer.name', 120), email }) : undefined,
    shipAddress: address
      ? compact({
          line1: str(address.line1, 'shipAddress.line1', 300),
          line2: str(address.line2, 'shipAddress.line2', 300),
          city: str(address.city, 'shipAddress.city', 120),
          state: str(address.state, 'shipAddress.state', 120),
          postalCode: str(address.postalCode, 'shipAddress.postalCode', 60),
          countryCode: str(address.countryCode, 'shipAddress.countryCode', 2, { pattern: /^[A-Z]{2}$/ }),
        })
      : undefined,
    shipping: shipping
      ? compact({
          carrier: str(shipping.carrier, 'shipping.carrier', 60),
          trackingNumber: str(shipping.trackingNumber, 'shipping.trackingNumber', 60, { pattern: /^[A-Za-z0-9-]+$/ }),
          weightG: positive(shipping.weightG, 'shipping.weightG', 1_000_000, { integer: true }),
        })
      : undefined,
    paypal: paypal
      ? compact({
          orderId: str(paypal.orderId, 'paypal.orderId', 64, { pattern: /^[A-Za-z0-9-]+$/ }),
          captureId: str(paypal.captureId, 'paypal.captureId', 64, { pattern: /^[A-Za-z0-9-]+$/ }),
        })
      : undefined,
    createdAt,
  };
}

function hashEmail(email: string): string {
  return crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');
}

/** 已有订单只更新物流信息；快照、金额、商品等字段和已存的不同时列在 ignored 里告诉调用方。 */
function updateShipping(existing: OrderRow, input: OrderPushInput): OrderPushResult {
  const s = input.shipping ?? {};
  const changes: [string, string, string | number][] = [];
  if (s.carrier !== undefined && s.carrier !== existing.carrier) changes.push(['carrier', 'carrier', s.carrier]);
  if (s.trackingNumber !== undefined && s.trackingNumber !== existing.tracking_number) changes.push(['trackingNumber', 'tracking_number', s.trackingNumber]);
  if (s.weightG !== undefined && s.weightG !== existing.shipped_weight_g) changes.push(['weightG', 'shipped_weight_g', s.weightG]);
  for (const [, column, value] of changes) db().prepare(`UPDATE orders SET ${column} = ? WHERE id = ?`).run(value, existing.id);

  const ignored: string[] = [];
  if (input.amount !== existing.amount) ignored.push('amount');
  if (input.currency !== existing.currency) ignored.push('currency');
  if (input.category !== existing.category) ignored.push('category');
  if (JSON.stringify(input.items) !== existing.items) ignored.push('items');
  if (input.listingSnapshot && JSON.stringify(input.listingSnapshot) !== existing.listing_snapshot) ignored.push('listingSnapshot');

  if (changes.length > 0) {
    // 物流信息变了，Logistics 要按新的单号和重量重跑；已结案的索赔不动。
    const open = db().prepare("SELECT id FROM claims WHERE order_id = ? AND status != 'closed'").all(existing.id) as unknown as { id: string }[];
    for (const c of open) {
      addTimeline(c.id, 'shipping', 'Merchant system updated shipping info', changes.map(([field]) => field).join(', '));
      startAnalysis(c.id, { only: ['logistics'] });
    }
  }
  return {
    ok: true,
    status: 200,
    body: { orderId: existing.id, orderNo: existing.order_no, created: false, updated: changes.map(([field]) => field), ignored },
  };
}

export function pushOrder(raw: unknown): OrderPushResult {
  let input: OrderPushInput;
  try {
    input = parseOrderPush(raw);
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, status: 400, body: { error: e.message } };
    throw e;
  }
  const merchantId = defaultMerchantId();
  if (!merchantId) return { ok: false, status: 503, body: { error: 'No merchant data' } };

  const existing = db().prepare('SELECT * FROM orders WHERE order_no = ?').get(input.orderNo) as OrderRow | undefined;
  if (existing) {
    if (existing.merchant_id !== merchantId) return { ok: false, status: 409, body: { error: 'Order number is already in use' } };
    return updateShipping(existing, input);
  }

  // 带 PayPal 捕获 ID、并且配好了沙箱时，按沙箱订单处理：争议同步按捕获 ID 匹配，退款走沙箱。
  // 其他情况走模拟器，退款不会动真实或沙箱资金。
  const sandbox = !!input.paypal?.captureId && paypalConfig().state === 'ready';
  const first = input.items[0];
  const snapshot = input.listingSnapshot ?? compact({ title: first.title, color: first.color, model: first.model });
  const id = newId();
  db()
    .prepare(
      `INSERT INTO orders (id, merchant_id, order_no, paypal_order_id, capture_id, buyer_name, buyer_email_hash, ship_address, items,
         listing_snapshot, current_listing, category, amount, currency, carrier, tracking_number, shipped_weight_g, paypal_env, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      merchantId,
      input.orderNo,
      input.paypal?.orderId ?? null,
      input.paypal?.captureId ?? `SIM-CAP-${id.slice(0, 8).toUpperCase()}`,
      input.buyer?.name ?? null,
      input.buyer?.email ? hashEmail(input.buyer.email) : null,
      input.shipAddress ? JSON.stringify(input.shipAddress) : null,
      JSON.stringify(input.items),
      JSON.stringify(snapshot),
      JSON.stringify(snapshot),
      input.category,
      input.amount,
      input.currency,
      input.shipping?.carrier ?? null,
      input.shipping?.trackingNumber ?? null,
      input.shipping?.weightG ?? null,
      sandbox ? 'sandbox' : 'simulator',
      input.createdAt ? new Date(input.createdAt).toISOString() : nowIso(),
    );
  return { ok: true, status: 201, body: { orderId: id, orderNo: input.orderNo, created: true, updated: [], ignored: [] } };
}

/** 订单推送接口的 Bearer 密钥。没配置时接口不启用，避免无鉴权写入。 */
export function checkApiKey(header: string | null): { ok: true } | { ok: false; status: number; error: string } {
  const expected = process.env.VERDICT_API_KEY?.trim();
  if (!expected) return { ok: false, status: 503, error: 'VERDICT_API_KEY is not set; the order push API is disabled' };
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  const given = Buffer.from(match?.[1]?.trim() ?? '');
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return { ok: false, status: 401, error: 'Invalid API key' };
  return { ok: true };
}
