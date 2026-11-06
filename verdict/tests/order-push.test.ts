// 商家系统推送订单（POST /api/orders）：鉴权、校验、快照不可覆盖、只存邮箱哈希。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-orders-test-'));
process.env.VERDICT_DATA_DIR = dir;
process.env.DEMO_ANALYZER_DELAY_MS = '0';
for (const k of ['LLM_API_KEY', 'LLM_PROVIDER', 'PAYPAL_ENV', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'VERDICT_API_KEY']) delete process.env[k];

let push: typeof import('@/server/order-push');
let repo: typeof import('@/server/repo');
let ingest: typeof import('@/server/ingest');
let db: typeof import('@/server/db');

beforeAll(async () => {
  const { seedDemo } = await import('@/demo/seed');
  push = await import('@/server/order-push');
  repo = await import('@/server/repo');
  ingest = await import('@/server/ingest');
  db = await import('@/server/db');
  await seedDemo();
}, 120000);

afterAll(() => {
  delete process.env.VERDICT_API_KEY;
  fs.rmSync(dir, { recursive: true, force: true });
});

const order = (over: Record<string, unknown> = {}) => ({
  orderNo: 'SHOP-10001',
  category: 'ceramics',
  amount: 59,
  currency: 'USD',
  items: [{ sku: 'MUG-01', title: '粗陶马克杯', quantity: 1, color: '米白', weightG: 410 }],
  listingSnapshot: { title: '粗陶马克杯', description: '米白色，350ml', color: '米白' },
  buyer: { name: 'Test Buyer', email: 'Buyer@Example.com' },
  shipAddress: { line1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '73301', countryCode: 'US' },
  createdAt: new Date(Date.now() - 3600_000).toISOString(),
  ...over,
});

describe('订单推送鉴权', () => {
  it('没有配置密钥时接口不启用', () => {
    expect(push.checkApiKey('Bearer anything')).toMatchObject({ ok: false, status: 503 });
  });

  it('密钥不对返回 401，对了才放行', () => {
    process.env.VERDICT_API_KEY = 'k'.repeat(32);
    expect(push.checkApiKey(null)).toMatchObject({ ok: false, status: 401 });
    expect(push.checkApiKey('Bearer wrong')).toMatchObject({ ok: false, status: 401 });
    expect(push.checkApiKey(`Bearer ${'k'.repeat(32)}`)).toEqual({ ok: true });
  });
});

describe('订单推送', () => {
  it('新订单：保存快照，买家邮箱只存哈希；没配沙箱时走模拟器', () => {
    const res = push.pushOrder(order());
    expect(res).toMatchObject({ ok: true, status: 201, body: { created: true } });
    if (!res.ok) return;
    const row = repo.getOrder(res.body.orderId)!;
    expect(JSON.parse(row.listing_snapshot!)).toEqual({ title: '粗陶马克杯', description: '米白色，350ml', color: '米白' });
    expect(row.paypal_env).toBe('simulator');
    expect(row.capture_id).toMatch(/^SIM-CAP-/);
    expect(row.buyer_email_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row).toLowerCase()).not.toContain('buyer@example.com');
  });

  it('同一订单再推：只更新物流，快照不被覆盖，并告诉调用方哪些字段被忽略', () => {
    const res = push.pushOrder(
      order({
        listingSnapshot: { title: '粗陶马克杯（新版描述）', color: '灰色' },
        shipping: { carrier: 'UPS', trackingNumber: '1Z999AA10123456784', weightG: 455 },
      }),
    );
    expect(res).toMatchObject({ ok: true, status: 200, body: { created: false } });
    if (!res.ok) return;
    expect(res.body.updated).toEqual(['carrier', 'trackingNumber', 'weightG']);
    expect(res.body.ignored).toEqual(['listingSnapshot']);
    const row = repo.getOrder(res.body.orderId)!;
    expect(JSON.parse(row.listing_snapshot!).color).toBe('米白');
    expect(row.tracking_number).toBe('1Z999AA10123456784');
    expect(row.shipped_weight_g).toBe(455);

    // 重复推送相同内容不再有更新。
    const again = push.pushOrder(order({ listingSnapshot: { title: '粗陶马克杯', description: '米白色，350ml', color: '米白' }, shipping: { carrier: 'UPS', trackingNumber: '1Z999AA10123456784', weightG: 455 } }));
    expect(again.ok && again.body.updated).toEqual([]);
    expect(again.ok && again.body.ignored).toEqual([]);
  });

  it('物流更新时，这笔订单未结案的索赔会记进时间线并重跑物流核验', () => {
    const row = db.db().prepare("SELECT * FROM orders WHERE order_no = 'SHOP-10001'").get() as { id: string; merchant_id: string };
    const claimId = ingest.createClaim({ merchantId: row.merchant_id, orderId: row.id, origin: 'manual_import', type: 'not_received', status: 'analyzing' });
    const res = push.pushOrder(order({ shipping: { carrier: 'UPS', trackingNumber: '1Z999AA10123456785' } }));
    expect(res.ok && res.body.updated).toEqual(['trackingNumber']);
    expect(repo.claimTimeline(claimId).some((t) => t.title === '商家系统更新了物流信息')).toBe(true);
  });

  it.each([
    ['缺订单号', { orderNo: '' }, 'orderNo'],
    ['订单号有非法字符', { orderNo: '../x' }, 'orderNo'],
    ['币种不是三位大写字母', { currency: 'usd' }, 'currency'],
    ['没有商品', { items: [] }, 'items'],
    ['金额为负', { amount: -1 }, 'amount'],
    ['下单时间在未来', { createdAt: new Date(Date.now() + 86400_000).toISOString() }, 'createdAt'],
    ['邮箱格式不对', { buyer: { email: 'not-an-email' } }, 'buyer.email'],
    ['类目名称无效', { category: 'Ceramics!' }, 'category'],
  ])('%s时返回 400', (_name, over, field) => {
    const res = push.pushOrder(order({ orderNo: 'SHOP-BAD', ...over }));
    expect(res).toMatchObject({ ok: false, status: 400 });
    if (!res.ok) expect(res.body.error).toContain(field);
    expect(db.db().prepare("SELECT 1 FROM orders WHERE order_no = 'SHOP-BAD'").get()).toBeUndefined();
  });
});
