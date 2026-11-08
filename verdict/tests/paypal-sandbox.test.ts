// PayPal 沙箱对接的测试。fetch 被替换成假的 PayPal，不访问网络。
// 这里验证的是“我们发出的请求符合文档”和“出错时不会重复动用资金”，不能代替对真实沙箱的联调。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-sandbox-test-'));
process.env.VERDICT_DATA_DIR = dir;
process.env.DEMO_ANALYZER_DELAY_MS = '0';
delete process.env.LLM_API_KEY;
delete process.env.LLM_PROVIDER;

const SECRET = 'test-secret-value-never-leak';

function setSandboxEnv() {
  process.env.PAYPAL_ENV = 'sandbox';
  process.env.PAYPAL_CLIENT_ID = 'test-client-id-ABCD';
  process.env.PAYPAL_CLIENT_SECRET = SECRET;
  process.env.PAYPAL_WEBHOOK_ID = 'WH-CONFIG-ID';
}

function clearSandboxEnv() {
  for (const k of ['PAYPAL_ENV', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID']) delete process.env[k];
}

const ALL_SCOPES = [
  'https://uri.paypal.com/services/disputes/read-seller',
  'https://uri.paypal.com/services/disputes/update-seller',
  'https://uri.paypal.com/services/payments/refund',
].join(' ');

interface Call {
  method: string;
  path: string;
  url: URL;
  headers: Headers;
  raw: unknown;
  json: any;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function rawDispute(id: string, over: Record<string, unknown> = {}) {
  return {
    dispute_id: id,
    update_time: '2026-11-01T00:00:00.000Z',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    status: 'WAITING_FOR_SELLER_RESPONSE',
    dispute_life_cycle_stage: 'INQUIRY',
    seller_response_due_date: '2026-11-20T00:00:00.000Z',
    dispute_amount: { currency_code: 'USD', value: '39.00' },
    disputed_transactions: [
      {
        seller_transaction_id: `CAP-${id}`,
        gross_amount: { currency_code: 'USD', value: '39.00' },
        buyer: { name: 'Sandbox Buyer' },
        items: [{ item_id: 'I1', item_name: '青瓷杯', item_quantity: '1' }],
      },
    ],
    messages: [{ posted_by: 'BUYER', time_posted: '2026-11-01T00:00:00.000Z', content: '一直没有收到包裹' }],
    allowed_response_options: { make_offer: { offer_types: ['REFUND'] }, accept_claim: { accept_claim_types: ['REFUND'] } },
    links: ['send-message', 'provide-evidence', 'make-offer', 'accept-claim', 'escalate'].map((s) => ({
      href: `https://api-m.sandbox.paypal.com/v1/customer/disputes/${id}/${s}`,
      rel: s,
      method: 'POST',
    })),
    ...over,
  };
}

class FakePayPal {
  calls: Call[] = [];
  disputes = new Map<string, Record<string, unknown>>();
  tokens = 0;
  verification = 'SUCCESS';
  refundStatus = 'COMPLETED';
  private failures: { match: RegExp; method: string; times: number; respond: () => Response }[] = [];

  /** 接下来 times 次匹配的请求按 respond 响应。respond 抛错相当于网络中断。 */
  failOn(method: string, match: RegExp, respond: () => Response, times = 1) {
    this.failures.push({ method, match, respond, times });
  }

  writes(match: RegExp) {
    return this.calls.filter((c) => c.method === 'POST' && match.test(c.path));
  }

  reads(match: RegExp) {
    return this.calls.filter((c) => c.method === 'GET' && match.test(c.path));
  }

  fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const raw = init.body;
    let parsed: unknown = null;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    }
    this.calls.push({ method, path: url.pathname, url, headers: new Headers(init.headers), raw, json: parsed });
    // 让出事件循环，并发测试里的请求才会真正交错。
    await new Promise((r) => setTimeout(r, 1));

    if (url.hostname !== 'api-m.sandbox.paypal.com') throw new Error(`请求发到了沙箱以外的地址：${url.hostname}`);

    const failure = this.failures.find((f) => f.times > 0 && f.method === method && f.match.test(url.pathname));
    if (failure) {
      failure.times -= 1;
      return failure.respond();
    }

    const p = url.pathname;
    if (p === '/v1/oauth2/token') {
      this.tokens += 1;
      return json({ access_token: `token-${this.tokens}`, expires_in: 3600, scope: ALL_SCOPES });
    }
    if (p === '/v1/notifications/verify-webhook-signature') return json({ verification_status: this.verification });
    if (method === 'GET' && p === '/v1/customer/disputes') {
      const items = [...this.disputes.values()].map((d) => ({ dispute_id: d.dispute_id, update_time: d.update_time, reason: d.reason, status: d.status }));
      return json({ items, links: [] });
    }
    const detail = p.match(/^\/v1\/customer\/disputes\/([^/]+)$/);
    if (detail && method === 'GET') {
      const d = this.disputes.get(detail[1]);
      return d ? json(d) : json({ name: 'RESOURCE_NOT_FOUND', message: 'not found' }, 404);
    }
    if (/^\/v1\/customer\/disputes\/[^/]+\/[a-z-]+$/.test(p) && method === 'POST') return json({ links: [] });
    if (/^\/v2\/payments\/captures\/[^/]+\/refund$/.test(p)) return json({ id: 'REFUND-1', status: 'COMPLETED' }, 201);
    if (method === 'GET' && /^\/v2\/payments\/refunds\/[^/]+$/.test(p)) {
      return json({ id: p.split('/').pop(), status: this.refundStatus });
    }
    if (p === '/v2/checkout/orders') {
      return json({ id: 'PPORDER-1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=PPORDER-1', method: 'GET' }] }, 200);
    }
    if (/^\/v2\/checkout\/orders\/[^/]+\/capture$/.test(p)) {
      return json({
        payer: { email_address: 'buyer@example.test', name: { given_name: 'Sand', surname: 'Box' } },
        purchase_units: [
          {
            shipping: { address: { address_line_1: '1 Main St', admin_area_2: 'San Jose', postal_code: '95131', country_code: 'US' } },
            payments: { captures: [{ id: 'CAPTURE-77', status: 'COMPLETED' }] },
          },
        ],
      });
    }
    return json({ name: 'NOT_FOUND', message: `fake 没有实现 ${method} ${p}` }, 404);
  };
}

let fake: FakePayPal;
let seq = 0;

let repo: typeof import('@/server/repo');
let actions: typeof import('@/server/actions');
let sync: typeof import('@/server/paypal-sync');
let ingest: typeof import('@/server/ingest');
let pipeline: typeof import('@/server/pipeline');
let shop: typeof import('@/server/sandbox-shop');
let attachments: typeof import('@/server/attachments');
let storage: typeof import('@/server/storage');
let dbm: typeof import('@/server/db');
let sandbox: typeof import('@/paypal/sandbox');
let config: typeof import('@/paypal/config');
let clientMod: typeof import('@/paypal/client');
let origin: typeof import('@/server/origin');
let views: typeof import('@/server/views');

const client = () => sandbox.getSandboxClient()!;

async function settled(claimId: string) {
  for (let i = 0; i < 500; i += 1) {
    const runs = repo.claimRuns(claimId);
    const busy = runs.some((r) => r.status === 'queued' || r.status === 'running');
    if (!busy && repo.getClaim(claimId)!.status !== 'analyzing') return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('分析没有结束');
}

/** 建一笔沙箱争议和对应的索赔，并等分析结束，这样判定已经是最新的。 */
async function sandboxClaim(over: Record<string, unknown> = {}) {
  seq += 1;
  const disputeId = `PP-D-${seq}`;
  fake.disputes.set(disputeId, rawDispute(disputeId, over));
  const view = await client().getDispute(disputeId, { fresh: true });
  const result = sync.upsertClaimFromDispute(view!);
  if (result.outcome !== 'created') throw new Error(`没有建出索赔：${JSON.stringify(result)}`);
  await settled(result.claimId);
  fake.calls = [];
  return { disputeId, claimId: result.claimId, verdictId: repo.latestVerdict(result.claimId)!.id };
}

/** 没有争议、已付款的沙箱订单上的索赔，动作会走退款接口。 */
async function paidOrderClaim() {
  seq += 1;
  const orderId = dbm.newId();
  dbm.db()
    .prepare(
      `INSERT INTO orders (id, merchant_id, order_no, capture_id, items, category, amount, currency, paypal_env, created_at)
       VALUES (?, 'demo-merchant', ?, ?, ?, 'general', 39, 'USD', 'sandbox', ?)`,
    )
    .run(orderId, `SB-T-${seq}`, `CAP-T-${seq}`, JSON.stringify([{ sku: 'X', title: '杯子', quantity: 1 }]), dbm.nowIso());
  const claimId = ingest.createClaim({ merchantId: 'demo-merchant', orderId, origin: 'manual_import', type: 'not_received', status: 'analyzing' });
  // 这些用例测的是退款重试和对账，不是判定门。先写下一句已同意的商家消息，判定建议才会是退款。
  dbm.db()
    .prepare('INSERT INTO messages (id, order_id, sender, text, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(dbm.newId(), orderId, 'merchant', '我们同意退款', dbm.nowIso());
  await pipeline.runAnalysis(claimId, { latencyMs: 0 });
  fake.calls = [];
  return { claimId, captureId: `CAP-T-${seq}`, verdictId: repo.latestVerdict(claimId)!.id };
}

function actionReq(c: { claimId: string; verdictId: string }, over: Partial<import('@/server/actions').ActionRequest> = {}) {
  return {
    claimId: c.claimId,
    type: 'send_message' as const,
    verdictId: c.verdictId,
    confirm: true,
    idempotencyKey: crypto.randomUUID(),
    actor: { id: 'demo-owner', role: 'owner' as const },
    origin: 'http://localhost:3000',
    payload: { message: '您好' },
    ...over,
  };
}

const sellerWrites = () => fake.writes(/^\/v1\/customer\/disputes\/.+|^\/v2\/payments\//);

beforeAll(async () => {
  setSandboxEnv();
  fake = new FakePayPal();
  vi.stubGlobal('fetch', (...args: Parameters<FakePayPal['fetch']>) => fake.fetch(...args));
  const { seedDemo } = await import('@/demo/seed');
  repo = await import('@/server/repo');
  actions = await import('@/server/actions');
  sync = await import('@/server/paypal-sync');
  ingest = await import('@/server/ingest');
  pipeline = await import('@/server/pipeline');
  shop = await import('@/server/sandbox-shop');
  attachments = await import('@/server/attachments');
  storage = await import('@/server/storage');
  dbm = await import('@/server/db');
  sandbox = await import('@/paypal/sandbox');
  config = await import('@/paypal/config');
  clientMod = await import('@/paypal/client');
  origin = await import('@/server/origin');
  views = await import('@/server/views');
  await seedDemo();
}, 120000);

beforeEach(() => {
  setSandboxEnv();
  fake = new FakePayPal();
  delete (globalThis as { __verdictPayPalSandbox?: unknown }).__verdictPayPalSandbox;
  dbm.db().prepare("DELETE FROM kv WHERE key = 'paypal_sync'").run();
});

afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('配置', () => {
  it('PAYPAL_ENV=live 被拒绝，也不会发出任何请求', () => {
    process.env.PAYPAL_ENV = 'live';
    const cfg = config.paypalConfig();
    expect(cfg.state).toBe('invalid');
    expect(sandbox.getSandboxClient()).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it('什么都没填时是 off，只填一半时报错', () => {
    clearSandboxEnv();
    expect(config.paypalConfig().state).toBe('off');
    process.env.PAYPAL_ENV = 'sandbox';
    expect(config.paypalConfig().state).toBe('invalid');
  });

  it('给前端的状态不含 secret，Client ID 只露尾号', () => {
    const text = JSON.stringify(config.publicPayPalStatus());
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('test-client-id');
    expect(config.publicPayPalStatus().clientIdTail).toBe('ABCD');
  });
});

describe('令牌', () => {
  it('并发请求只取一次令牌，之后复用', async () => {
    await Promise.all([client().listDisputes({ page: 1, pageSize: 1 }), client().listDisputes({ page: 1, pageSize: 1 })]);
    await client().listDisputes({ page: 1, pageSize: 1 });
    expect(fake.tokens).toBe(1);
    const token = fake.calls.find((c) => c.path === '/v1/oauth2/token')!;
    expect(token.headers.get('authorization')).toBe(`Basic ${Buffer.from(`test-client-id-ABCD:${SECRET}`).toString('base64')}`);
    expect(token.raw).toBe('grant_type=client_credentials');
  });

  it('401 时换一次令牌重发，写接口也不会被当作失败', async () => {
    fake.disputes.set('D1', rawDispute('D1'));
    await client().getDispute('D1');
    fake.failOn('POST', /send-message$/, () => json({ name: 'AUTHENTICATION_FAILURE' }, 401));
    await client().sendMessage('D1', 'hi', 'key-1');
    expect(fake.tokens).toBe(2);
    expect(fake.writes(/send-message$/)).toHaveLength(2);
    expect(fake.writes(/send-message$/)[1].headers.get('authorization')).toBe('Bearer token-2');
  });

  it('凭据错误是明确的失败，不算结果不明', async () => {
    fake.failOn('POST', /oauth2\/token/, () => json({ error: 'invalid_client' }, 401));
    const err = await client().sendMessage('D1', 'hi', 'k').catch((e) => e);
    expect(err).toBeInstanceOf(clientMod.PayPalApiError);
    expect(err.indeterminate).toBe(false);
    expect(fake.writes(/send-message$/)).toHaveLength(0);
  });
});

describe('请求格式', () => {
  it('send-message 是 JSON，带 PayPal-Request-Id', async () => {
    await client().sendMessage('D1', '请补充照片', 'key-1');
    const call = fake.writes(/send-message$/)[0];
    expect(call.path).toBe('/v1/customer/disputes/D1/send-message');
    expect(call.json).toEqual({ message: '请补充照片' });
    expect(call.headers.get('paypal-request-id')).toBe('key-1');
    expect(call.headers.get('content-type')).toBe('application/json');
  });

  it('provide-evidence 是 multipart：input 部分加 file1、file2', async () => {
    const documents = [
      { name: 'evidence-1.jpg', mime: 'image/jpeg', data: Buffer.from('one') },
      { name: 'evidence-2.png', mime: 'image/png', data: Buffer.from('two') },
    ];
    await client().provideEvidence('D1', { evidenceType: 'OTHER', notes: '说明', documents }, 'key-2');
    const form = fake.writes(/provide-evidence$/)[0].raw as FormData;
    expect(form).toBeInstanceOf(FormData);
    const input = form.get('input') as Blob;
    expect(input.type).toBe('application/json');
    expect(JSON.parse(await input.text())).toEqual({
      evidences: [{ evidence_type: 'OTHER', notes: '说明', documents: [{ name: 'evidence-1.jpg' }, { name: 'evidence-2.png' }] }],
    });
    const file1 = form.get('file1') as File;
    expect(file1.name).toBe('evidence-1.jpg');
    expect(file1.type).toBe('image/jpeg');
    expect(await file1.text()).toBe('one');
    expect((form.get('file2') as File).name).toBe('evidence-2.png');
    // multipart 的边界要由 fetch 生成，手写 Content-Type 会让 PayPal 解析失败。
    expect(fake.writes(/provide-evidence$/)[0].headers.get('content-type')).toBeNull();
  });

  it('物流证据带 tracking_info；不认识的承运商用 OTHER', async () => {
    await client().provideEvidence('D1', { evidenceType: 'PROOF_OF_FULFILLMENT', notes: 'n', documents: [], trackingNumber: '1Z', carrier: 'UPS' }, 'a');
    await client().provideEvidence('D1', { evidenceType: 'PROOF_OF_FULFILLMENT', notes: 'n', documents: [], trackingNumber: '9', carrier: '顺丰' }, 'b');
    const inputs = await Promise.all(
      fake.writes(/provide-evidence$/).map(async (c) => JSON.parse(await ((c.raw as FormData).get('input') as Blob).text()).evidences[0].evidence_info.tracking_info[0]),
    );
    expect(inputs[0]).toEqual({ carrier_name: 'UPS', tracking_number: '1Z' });
    expect(inputs[1]).toEqual({ carrier_name: 'OTHER', carrier_name_other: '顺丰', tracking_number: '9' });
  });

  it('非物流证据不带 tracking_info，物流单号写进说明', async () => {
    await client().provideEvidence('D1', { evidenceType: 'OTHER', notes: '已发货', documents: [], trackingNumber: '1Z9', carrier: 'UPS' }, 'o1');
    await client().provideEvidence('D1', { evidenceType: 'OTHER', notes: '单号 1Z9 已签收', documents: [], trackingNumber: '1Z9', carrier: 'UPS' }, 'o2');
    const [first, second] = await Promise.all(
      fake.writes(/provide-evidence$/).map(async (c) => JSON.parse(await ((c.raw as FormData).get('input') as Blob).text()).evidences[0]),
    );
    expect(first).toEqual({ evidence_type: 'OTHER', notes: '已发货\n物流：UPS 1Z9' });
    // 说明里已经有单号时不重复追加。
    expect(second).toEqual({ evidence_type: 'OTHER', notes: '单号 1Z9 已签收' });
  });

  it('EVIDENCE_TYPE_IS_NOT_ALLOWED 换成能看懂的原因', async () => {
    fake.failOn('POST', /provide-evidence$/, () =>
      json({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'EVIDENCE_TYPE_IS_NOT_ALLOWED', description: 'Request is not well-formed' }] }, 422),
    );
    const err = await client()
      .provideEvidence('D1', { evidenceType: 'PROOF_OF_FULFILLMENT', notes: 'n', documents: [], trackingNumber: '1Z' }, 'e1')
      .catch((e) => e);
    expect(err).toBeInstanceOf(clientMod.PayPalApiError);
    expect(err.issue).toBe('EVIDENCE_TYPE_IS_NOT_ALLOWED');
    expect(err.message).toMatch(/同一类型已经提交过/);
    expect(err.message).not.toMatch(/not well-formed/);
  });

  it('争议详情列出商家已经提交过的证据类型', async () => {
    const view = sandbox.toDisputeView(
      rawDispute('D9', {
        evidences: [
          { evidence_type: 'CREATE', source: 'SUBMITTED_BY_BUYER' },
          { evidence_type: 'PROOF_OF_FULFILLMENT', source: 'SUBMITTED_BY_SELLER' },
          { evidence_type: 'OTHER', source: 'SUBMITTED_BY_SELLER' },
          { evidence_type: 'OTHER', source: 'SUBMITTED_BY_SELLER' },
          { evidence_type: 'PROOF_OF_REFUND', source: 'REQUESTED_FROM_SELLER' },
        ],
      }),
    );
    expect(view.submittedEvidenceTypes).toEqual(['PROOF_OF_FULFILLMENT', 'OTHER']);
  });

  it('退款金额是字符串，零小数货币不带小数，带 Prefer 和请求 ID', async () => {
    await client().refundCapture('CAP1', { amount: 12.5, currency: 'USD' }, 'key-r');
    await client().refundCapture('CAP2', { amount: 1000, currency: 'JPY' }, 'key-j');
    const [usd, jpy] = fake.writes(/refund$/);
    expect(usd.path).toBe('/v2/payments/captures/CAP1/refund');
    expect(usd.json).toEqual({ amount: { value: '12.50', currency_code: 'USD' } });
    expect(usd.headers.get('paypal-request-id')).toBe('key-r');
    expect(usd.headers.get('prefer')).toBe('return=representation');
    expect(jpy.json.amount.value).toBe('1000');
  });

  it('退款状态是 FAILED 时算失败', async () => {
    fake.failOn('POST', /refund$/, () => json({ id: 'R', status: 'FAILED' }, 201));
    await expect(client().refundCapture('CAP1', { amount: 1, currency: 'USD' }, 'k')).rejects.toThrow(/FAILED/);
  });

  it('和解默认发 REFUND；PayPal 不接受时明确报错，不发请求', async () => {
    fake.disputes.set('D2', rawDispute('D2'));
    await client().makeOffer('D2', { amount: 10, currency: 'USD', note: '部分退款' }, 'k');
    expect(fake.writes(/make-offer$/)[0].json).toEqual({
      note: '部分退款',
      offer_type: 'REFUND',
      offer_amount: { currency_code: 'USD', value: '10.00' },
    });

    fake.disputes.set('D3', rawDispute('D3', { allowed_response_options: { make_offer: { offer_types: ['REFUND_WITH_RETURN'] } } }));
    await expect(client().makeOffer('D3', { amount: 10, currency: 'USD', note: 'x' }, 'k2')).rejects.toThrow(/REFUND_WITH_RETURN/);
    expect(fake.writes(/D3\/make-offer$/)).toHaveLength(0);
  });

  it('要求退货的和解发 REFUND_WITH_RETURN 和退货地址', async () => {
    fake.disputes.set('D4', rawDispute('D4', { allowed_response_options: { make_offer: { offer_types: ['REFUND', 'REFUND_WITH_RETURN'] } } }));
    const address = { line1: '100 Demo Warehouse Way', line2: 'Dock 3', city: 'San Jose', state: 'CA', postalCode: '95134', countryCode: 'US' };
    const res = await client().makeOffer('D4', { amount: 129, currency: 'USD', note: '请寄回', returnAddress: address }, 'k4');
    expect(fake.writes(/D4\/make-offer$/)[0].json).toEqual({
      note: '请寄回',
      offer_type: 'REFUND_WITH_RETURN',
      offer_amount: { currency_code: 'USD', value: '129.00' },
      return_shipping_address: {
        address_line_1: '100 Demo Warehouse Way',
        address_line_2: 'Dock 3',
        admin_area_2: 'San Jose',
        admin_area_1: 'CA',
        postal_code: '95134',
        country_code: 'US',
      },
    });
    expect(res.offer_type).toBe('REFUND_WITH_RETURN');

    // 只允许直接退款的争议，不能要求退货。
    fake.disputes.set('D5', rawDispute('D5'));
    await expect(client().makeOffer('D5', { amount: 1, currency: 'USD', note: 'x', returnAddress: address }, 'k5')).rejects.toThrow(/只接受 REFUND/);
    expect(fake.writes(/D5\/make-offer$/)).toHaveLength(0);
  });

  it('只接受退货退款时，报错提示勾选要求退货', async () => {
    fake.disputes.set('D6', rawDispute('D6', { allowed_response_options: { make_offer: { offer_types: ['REFUND_WITH_RETURN'] } } }));
    await expect(client().makeOffer('D6', { amount: 1, currency: 'USD', note: 'x' }, 'k6')).rejects.toThrow(/勾选“要求买家先退货”/);
  });

  it('accept-claim 和 escalate 是 JSON', async () => {
    await client().acceptClaim('D1', '接受', 'a');
    await client().escalate('D1', '升级', 'b');
    expect(fake.writes(/accept-claim$/)[0].json).toEqual({ note: '接受' });
    expect(fake.writes(/escalate$/)[0].json).toEqual({ note: '升级' });
  });

  it('沙箱测试接口的字段名符合文档', async () => {
    await client().requireEvidence('D1', 'SELLER_EVIDENCE');
    await client().adjudicate('D1', 'SELLER_FAVOR');
    expect(fake.writes(/require-evidence$/)[0].json).toEqual({ action: 'SELLER_EVIDENCE' });
    expect(fake.writes(/adjudicate$/)[0].json).toEqual({ adjudication_outcome: 'SELLER_FAVOR' });
  });
});

describe('争议解析', () => {
  it('字段映射正确', () => {
    const view = sandbox.toDisputeView(rawDispute('D1'));
    expect(view.transactionIds).toEqual(['CAP-D1']);
    expect(view.amount).toBe(39);
    expect(view.currency).toBe('USD');
    expect(view.buyerName).toBe('Sandbox Buyer');
    expect(view.buyerMessage).toBe('一直没有收到包裹');
    expect(view.item).toEqual({ id: 'I1', title: '青瓷杯', quantity: 1 });
    expect(view.offerTypes).toEqual(['REFUND']);
  });

  it('允许的动作来自链接和 allowed_response_options，缺了就不允许', () => {
    const allowed = (over: Record<string, unknown>) => sandbox.toDisputeView(rawDispute('D1', over)).allowedActions;
    expect(allowed({})).toEqual(['send_message', 'provide_evidence', 'make_offer', 'accept_claim', 'escalate']);
    expect(allowed({ links: [], allowed_response_options: {} })).toEqual([]);
    expect(allowed({ links: [], allowed_response_options: { accept_claim: { accept_claim_types: ['REFUND'] } } })).toEqual(['accept_claim']);
    // rel 在文档里只有占位示例，只看 href 也要能识别。
    expect(allowed({ allowed_response_options: {}, links: [{ href: 'https://x/v1/customer/disputes/D1/escalate', rel: 'whatever' }] })).toEqual(['escalate']);
  });

  it('沙箱实测的 rel 用下划线，href 不带动作名时也能识别', () => {
    const allowed = (over: Record<string, unknown>) => sandbox.toDisputeView(rawDispute('D1', over)).allowedActions;
    const links = (...rels: string[]) => rels.map((rel) => ({ href: 'https://x/v1/customer/disputes/D1', rel, method: 'POST' }));
    expect(allowed({ allowed_response_options: {}, links: links('self', 'make_offer', 'provide_evidence', 'send_message', 'accept_claim', 'escalate') })).toEqual([
      'send_message',
      'provide_evidence',
      'make_offer',
      'accept_claim',
      'escalate',
    ]);
    // 写操作后的约 30 秒里只有 self；拒付阶段进入 PayPal 审核后只剩 provide_supporting_info（沙箱实测）。
    expect(allowed({ allowed_response_options: {}, links: links('self') })).toEqual([]);
    expect(allowed({ allowed_response_options: {}, links: links('self', 'provide_supporting_info') })).toEqual(['provide_supporting_info']);
  });

  it('只有 PayPal 给了链接才开放沙箱测试接口', () => {
    expect(sandbox.toDisputeView(rawDispute('D1')).sandboxTools).toEqual({ requireEvidence: false, adjudicate: false });
    const links = [{ href: 'https://x/v1/customer/disputes/D1/adjudicate', rel: 'adjudicate' }];
    expect(sandbox.toDisputeView(rawDispute('D1', { links })).sandboxTools.adjudicate).toBe(true);
  });
});

describe('错误分类', () => {
  it('4xx 是明确的失败，带上 issue 和 debug_id', async () => {
    fake.failOn('POST', /send-message$/, () => json({ name: 'UNPROCESSABLE_ENTITY', debug_id: 'dbg1', details: [{ issue: 'NOT_ALLOWED', description: '不允许' }] }, 422));
    const err = await client().sendMessage('D1', 'x', 'k').catch((e) => e);
    expect(err.indeterminate).toBe(false);
    expect(err.status).toBe(422);
    expect(err.issue).toBe('NOT_ALLOWED');
    expect(err.debugId).toBe('dbg1');
    expect(fake.writes(/send-message$/)).toHaveLength(1);
  });

  it('争议写接口遇到 5xx 或断网不重试，标记为结果不明', async () => {
    fake.failOn('POST', /send-message$/, () => json({}, 500));
    const server = await client().sendMessage('D1', 'x', 'k').catch((e) => e);
    expect(server.indeterminate).toBe(true);
    expect(fake.writes(/send-message$/)).toHaveLength(1);

    fake.failOn('POST', /accept-claim$/, () => {
      throw new TypeError('fetch failed');
    });
    const network = await client().acceptClaim('D1', 'x', 'k2').catch((e) => e);
    expect(network.indeterminate).toBe(true);
    expect(fake.writes(/accept-claim$/)).toHaveLength(1);
  });

  it('退款带请求 ID，可以用同一个 ID 重试一次', async () => {
    fake.failOn('POST', /refund$/, () => json({}, 503));
    const res = await client().refundCapture('CAP1', { amount: 1, currency: 'USD' }, 'same-key');
    expect(res.status).toBe('COMPLETED');
    const calls = fake.writes(/refund$/);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.headers.get('paypal-request-id'))).toEqual(['same-key', 'same-key']);
  });

  it('读接口遇到 5xx 重试一次，404 返回 null', async () => {
    fake.disputes.set('D1', rawDispute('D1'));
    fake.failOn('GET', /disputes\/D1$/, () => json({}, 500));
    expect((await client().getDispute('D1', { fresh: true }))?.id).toBe('D1');
    expect(fake.reads(/disputes\/D1$/)).toHaveLength(2);
    expect(await client().getDispute('MISSING', { fresh: true })).toBeNull();
  });

  it('读取有短缓存，写操作后失效，fresh 绕过缓存', async () => {
    fake.disputes.set('D1', rawDispute('D1'));
    await client().getDispute('D1');
    await client().getDispute('D1');
    expect(fake.reads(/disputes\/D1$/)).toHaveLength(1);
    await client().getDispute('D1', { fresh: true });
    expect(fake.reads(/disputes\/D1$/)).toHaveLength(2);
    await client().sendMessage('D1', 'x', 'k');
    await client().getDispute('D1');
    expect(fake.reads(/disputes\/D1$/)).toHaveLength(3);
  });
});

describe('Webhook', () => {
  const headers = () =>
    new Headers({
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
      'paypal-transmission-id': 'tid',
      'paypal-transmission-sig': 'sig',
      'paypal-transmission-time': '2026-11-01T00:00:00Z',
    });
  const event = (id: string, disputeId: string, type = 'CUSTOMER.DISPUTE.CREATED') =>
    `{"id":"${id}","amount":1.10,"event_type":"${type}","resource":{"dispute_id":"${disputeId}"}}`;

  it('验签时原样转发事件，不改动数字和字段顺序', async () => {
    const raw = event('WH-A', 'D1');
    expect(await client().verifyWebhook(raw, headers())).toBe(true);
    const call = fake.writes(/verify-webhook-signature$/)[0];
    expect(call.raw).toContain(`"webhook_event":${raw}`);
    expect(call.json).toMatchObject({
      auth_algo: 'SHA256withRSA',
      cert_url: 'https://api.sandbox.paypal.com/cert',
      transmission_id: 'tid',
      transmission_sig: 'sig',
      transmission_time: '2026-11-01T00:00:00Z',
      webhook_id: 'WH-CONFIG-ID',
    });
  });

  it('缺少验签头或不是合法 JSON 时直接拒绝，不调用 PayPal', async () => {
    expect(await client().verifyWebhook(event('X', 'D'), new Headers())).toBe(false);
    expect(await client().verifyWebhook('not json', headers())).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it('没有配置 webhook ID 时一律不通过', async () => {
    delete process.env.PAYPAL_WEBHOOK_ID;
    expect(await client().verifyWebhook(event('X', 'D'), headers())).toBe(false);
  });

  it('验签失败返回 401，不建索赔', async () => {
    seq += 1;
    const id = `PP-D-${seq}`;
    fake.disputes.set(id, rawDispute(id));
    fake.verification = 'FAILURE';
    const out = await sync.handleSandboxWebhook(event(`WH-${id}`, id), headers());
    expect(out.status).toBe(401);
    expect(dbm.db().prepare('SELECT 1 FROM claims WHERE paypal_dispute_id = ?').get(id)).toBeUndefined();
    expect(dbm.db().prepare('SELECT 1 FROM paypal_events WHERE id = ?').get(`WH-${id}`)).toBeUndefined();
  });

  it('验签接口不可用时返回 503，让 PayPal 重发', async () => {
    fake.failOn('POST', /verify-webhook-signature$/, () => json({}, 500), 2);
    expect((await sync.handleSandboxWebhook(event('WH-503', 'D1'), headers())).status).toBe(503);
  });

  it('建索赔；重放不重复；处理失败的事件重发后能补上', async () => {
    seq += 1;
    const id = `PP-D-${seq}`;
    fake.disputes.set(id, rawDispute(id));
    const raw = event(`WH-${id}`, id);
    fake.failOn('GET', new RegExp(`disputes/${id}$`), () => json({}, 500), 2);
    expect((await sync.handleSandboxWebhook(raw, headers())).status).toBe(503);
    expect(dbm.db().prepare('SELECT 1 FROM claims WHERE paypal_dispute_id = ?').get(id)).toBeUndefined();

    const second = await sync.handleSandboxWebhook(raw, headers());
    expect(second.status).toBe(200);
    expect(second.body.outcome).toBe('created');
    await settled(second.body.claimId as string);

    const third = await sync.handleSandboxWebhook(raw, headers());
    expect(third.body.duplicate).toBe(true);
    const count = dbm.db().prepare('SELECT COUNT(*) AS n FROM claims WHERE paypal_dispute_id = ?').get(id) as { n: number };
    expect(count.n).toBe(1);
  });

  it('其他事件类型只记录不处理', async () => {
    const out = await sync.handleSandboxWebhook(event('WH-OTHER', 'D1', 'PAYMENT.CAPTURE.COMPLETED'), headers());
    expect(out.body.ignored).toBe(true);
    expect(fake.reads(/disputes/)).toHaveLength(0);
  });

  it('模拟器的 webhook 还是走原来的 HMAC，不受影响', async () => {
    expect((await ingest.handleWebhook('{}', 'bad')).status).toBe(401);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('定时同步', () => {
  const addDispute = (over: Record<string, unknown> = {}) => {
    seq += 1;
    const id = `PP-D-${seq}`;
    fake.disputes.set(id, rawDispute(id, over));
    return id;
  };

  it('没有本地订单时自动导入一笔；不支持的原因和已结案的跳过', async () => {
    const ok = addDispute();
    const unsupported = addDispute({ reason: 'UNAUTHORISED' });
    const resolved = addDispute({ status: 'RESOLVED' });

    const state = await sync.syncSandboxDisputes();
    expect(state.ok).toBe(true);
    expect(state.created).toBe(1);
    expect(state.skipped.map((s) => s.id).sort()).toEqual([unsupported, resolved].sort());

    const claim = dbm.db().prepare('SELECT * FROM claims WHERE paypal_dispute_id = ?').get(ok) as unknown as import('@/server/repo').ClaimRow;
    await settled(claim.id);
    expect(claim.claim_type).toBe('not_received');
    expect(claim.narrative).toBe('一直没有收到包裹');
    expect(claim.due_at).toBe('2026-11-20T00:00:00.000Z');
    const order = repo.getOrder(claim.order_id)!;
    expect(order.paypal_env).toBe('sandbox');
    expect(order.capture_id).toBe(`CAP-${ok}`);
    expect(order.amount).toBe(39);
    expect(order.buyer_name).toBe('Sandbox Buyer');
    const msg = dbm.db().prepare("SELECT text FROM messages WHERE order_id = ? AND sender = 'buyer'").all(order.id);
    expect(msg).toHaveLength(1);
  });

  it('交易号匹配到本地沙箱订单时不新建订单', async () => {
    seq += 1;
    const orderId = dbm.newId();
    dbm.db()
      .prepare(
        `INSERT INTO orders (id, merchant_id, order_no, capture_id, items, category, amount, currency, paypal_env, created_at)
         VALUES (?, 'demo-merchant', ?, ?, '[]', 'general', 39, 'USD', 'sandbox', ?)`,
      )
      .run(orderId, `SB-M-${seq}`, `CAP-PP-D-${seq + 1}`, dbm.nowIso());
    const id = addDispute();
    await sync.syncSandboxDisputes();
    const claim = dbm.db().prepare('SELECT * FROM claims WHERE paypal_dispute_id = ?').get(id) as unknown as import('@/server/repo').ClaimRow;
    await settled(claim.id);
    expect(claim.order_id).toBe(orderId);
  });

  it('模拟订单的 capture_id 相同也不会被匹配', async () => {
    const id = addDispute();
    dbm.db().prepare("UPDATE orders SET capture_id = ? WHERE id = (SELECT id FROM orders WHERE paypal_env = 'simulator' LIMIT 1)").run(`CAP-${id}`);
    await sync.syncSandboxDisputes();
    const claim = dbm.db().prepare('SELECT * FROM claims WHERE paypal_dispute_id = ?').get(id) as unknown as import('@/server/repo').ClaimRow;
    await settled(claim.id);
    expect(repo.getOrder(claim.order_id)!.paypal_env).toBe('sandbox');
  });

  it('第二轮带时间游标，没变化的争议不再拉详情', async () => {
    const id = addDispute();
    await sync.syncSandboxDisputes();
    const claim = dbm.db().prepare('SELECT id FROM claims WHERE paypal_dispute_id = ?').get(id) as { id: string };
    await settled(claim.id);
    fake.calls = [];
    await sync.syncSandboxDisputes();
    const list = fake.reads(/^\/v1\/customer\/disputes$/)[0];
    expect(list.url.searchParams.get('update_time_after')).toBeTruthy();
    expect(list.url.searchParams.get('page_size')).toBe('50');
    expect(fake.reads(new RegExp(`disputes/${id}$`))).toHaveLength(0);
  });

  it('列表接口失败时不前进游标，错误记下来', async () => {
    fake.failOn('GET', /^\/v1\/customer\/disputes$/, () => json({ name: 'INTERNAL' }, 500), 2);
    const state = await sync.syncSandboxDisputes();
    expect(state.ok).toBe(false);
    expect(state.cursor).toBeNull();
    expect(state.error).toBeTruthy();
    expect(sync.lastSync()?.error).toBeTruthy();
  });

  it('并发同步共用同一轮，同一笔争议只建一笔索赔', async () => {
    const id = addDispute();
    const [a, b] = await Promise.all([sync.syncSandboxDisputes(), sync.syncSandboxDisputes()]);
    expect(a).toBe(b);
    const count = dbm.db().prepare('SELECT id FROM claims WHERE paypal_dispute_id = ?').all(id) as { id: string }[];
    expect(count).toHaveLength(1);
    await settled(count[0].id);
  });

  it('PayPal 结案后本地结案', async () => {
    const c = await sandboxClaim();
    const view = sandbox.toDisputeView(rawDispute(c.disputeId, { status: 'RESOLVED', update_time: '2026-11-02T00:00:00.000Z', dispute_outcome: { outcome_code: 'RESOLVED_SELLER_FAVOUR' } }));
    sync.upsertClaimFromDispute(view);
    expect(repo.getClaim(c.claimId)!.status).toBe('closed');
    expect(repo.claimTimeline(c.claimId).some((t: { title: string }) => t.title === 'PayPal 争议已结案')).toBe(true);
  });

  it('动作发出后，只有状态真的变回“等商家”才回到待决定', async () => {
    const c = await sandboxClaim();
    dbm.db().prepare("UPDATE claims SET status = 'action_sent' WHERE id = ?").run(c.claimId);

    // 状态没变（比如刚提交证据，PayPal 还没更新）：保持已发送。
    sync.upsertClaimFromDispute(sandbox.toDisputeView(rawDispute(c.disputeId, { update_time: '2026-11-02T00:00:00.000Z' })));
    expect(repo.getClaim(c.claimId)!.status).toBe('action_sent');

    sync.upsertClaimFromDispute(sandbox.toDisputeView(rawDispute(c.disputeId, { status: 'UNDER_REVIEW', update_time: '2026-11-03T00:00:00.000Z' })));
    expect(repo.getClaim(c.claimId)!.status).toBe('action_sent');

    sync.upsertClaimFromDispute(sandbox.toDisputeView(rawDispute(c.disputeId, { update_time: '2026-11-04T00:00:00.000Z' })));
    expect(repo.getClaim(c.claimId)!.status).toBe('awaiting_decision');
  });

  it('买家先走索赔页、后开争议时挂到原索赔上，不覆盖买家的描述', async () => {
    const paid = await paidOrderClaim();
    dbm.db().prepare('UPDATE claims SET narrative = ? WHERE id = ?').run('索赔页里写的描述', paid.claimId);
    seq += 1;
    const id = `PP-D-${seq}`;
    const raw = rawDispute(id, {
      disputed_transactions: [{ seller_transaction_id: paid.captureId, gross_amount: { currency_code: 'USD', value: '39.00' } }],
    });
    const result = sync.upsertClaimFromDispute(sandbox.toDisputeView(raw));
    expect(result).toEqual({ outcome: 'linked', claimId: paid.claimId });
    await settled(paid.claimId);
    const claim = repo.getClaim(paid.claimId)!;
    expect(claim.paypal_dispute_id).toBe(id);
    expect(claim.narrative).toBe('索赔页里写的描述');
  });

  it('同一条买家消息不重复保存', async () => {
    const c = await sandboxClaim();
    const order = repo.getClaim(c.claimId)!.order_id;
    sync.upsertClaimFromDispute(sandbox.toDisputeView(rawDispute(c.disputeId)));
    const rows = dbm.db().prepare("SELECT id FROM messages WHERE order_id = ? AND sender = 'buyer'").all(order);
    expect(rows).toHaveLength(1);
  });
});

describe('动作路由', () => {
  it('沙箱索赔真实调用 PayPal，并在动作前重新读取状态', async () => {
    const c = await sandboxClaim();
    const res = await actions.executeAction(actionReq(c));
    expect(res.status).toBe(200);
    expect(res.body.response).toMatchObject({ simulated: false, environment: 'sandbox' });
    expect(fake.reads(new RegExp(`disputes/${c.disputeId}$`))).toHaveLength(1);
    expect(fake.writes(/send-message$/)).toHaveLength(1);
    expect(repo.getClaim(c.claimId)!.status).toBe('action_sent');
  });

  it('PayPal 收回了某个操作时拒绝，不发写请求', async () => {
    const c = await sandboxClaim();
    fake.disputes.set(c.disputeId, rawDispute(c.disputeId, { links: [], allowed_response_options: {} }));
    const res = await actions.executeAction(actionReq(c));
    expect(res.status).toBe(409);
    expect(sellerWrites()).toHaveLength(0);
    expect(repo.claimActions(c.claimId)).toHaveLength(0);
  });

  it('读不到 PayPal 状态时返回 502，什么都不落库', async () => {
    const c = await sandboxClaim();
    fake.failOn('GET', new RegExp(`disputes/${c.disputeId}$`), () => json({}, 500), 2);
    const res = await actions.executeAction(actionReq(c));
    expect(res.status).toBe(502);
    expect(String(res.body.error)).toContain('动作没有执行');
    expect(repo.claimActions(c.claimId)).toHaveLength(0);
  });

  it('沙箱配置被移除后，沙箱索赔不会退回模拟器', async () => {
    const c = await sandboxClaim();
    clearSandboxEnv();
    const res = await actions.executeAction(actionReq(c));
    expect(res.status).toBe(502);
    expect(repo.claimActions(c.claimId)).toHaveLength(0);
    const view = await views.claimView(c.claimId);
    expect(view!.paypal.error).toBeTruthy();
    expect(view!.allowedActions).toEqual([]);
  });

  it('演示索赔走模拟器，不发任何网络请求', async () => {
    const demo = repo.listClaims().find((c) => c.paypalEnv === 'simulator' && c.status === 'awaiting_decision' && repo.claimDetail(c.id)!.claim.disputeId)!;
    const detail = repo.claimDetail(demo.id)!;
    const res = await actions.executeAction(actionReq({ claimId: demo.id, verdictId: detail.verdict!.id }));
    expect(res.status).toBe(200);
    expect(res.body.response).toMatchObject({ simulated: true, environment: 'simulator' });
    expect(fake.calls).toHaveLength(0);
  });

  it('索赔链接替换后超长时拒绝，不发请求', async () => {
    const c = await sandboxClaim();
    const { PORTAL_LINK_PLACEHOLDER } = await import('@/core/recommend');
    const message = `${'字'.repeat(1990)}${PORTAL_LINK_PLACEHOLDER}`;
    expect(message.length).toBeLessThanOrEqual(2000);
    const res = await actions.executeAction(actionReq(c, { payload: { message } }));
    expect(res.status).toBe(400);
    expect(sellerWrites()).toHaveLength(0);
    expect(repo.claimActions(c.claimId)).toHaveLength(0);
  });

  it('说明为空时用默认文字，PayPal 要求至少 1 个字符', async () => {
    const c = await sandboxClaim();
    await actions.executeAction(actionReq(c, { type: 'escalate', payload: {} }));
    expect(fake.writes(/escalate$/)[0].json.note).toBeTruthy();
  });

  it('测试工具：模拟订单拒绝；没有链接拒绝；有链接才调用', async () => {
    const demo = repo.listClaims().find((c) => c.paypalEnv === 'simulator')!;
    expect((await actions.runSandboxTool({ claimId: demo.id, tool: 'adjudicate', value: 'SELLER_FAVOR', confirm: true })).status).toBe(409);

    const c = await sandboxClaim();
    expect((await actions.runSandboxTool({ claimId: c.claimId, tool: 'adjudicate', value: 'SELLER_FAVOR', confirm: false })).status).toBe(400);
    expect((await actions.runSandboxTool({ claimId: c.claimId, tool: 'adjudicate', value: 'SELLER_FAVOR', confirm: true })).status).toBe(409);
    expect(fake.writes(/adjudicate$/)).toHaveLength(0);

    fake.disputes.set(c.disputeId, rawDispute(c.disputeId, { links: [{ href: `https://x/v1/customer/disputes/${c.disputeId}/adjudicate`, rel: 'adjudicate' }] }));
    const ok = await actions.runSandboxTool({ claimId: c.claimId, tool: 'adjudicate', value: 'SELLER_FAVOR', confirm: true });
    expect(ok.status).toBe(200);
    expect(fake.writes(/adjudicate$/)).toHaveLength(1);
  });
});

describe('防止重复动用资金', () => {
  it('结果不明时阻止后续所有动作，新的幂等键也不行', async () => {
    const c = await paidOrderClaim();
    fake.failOn('POST', /refund$/, () => json({}, 500), 2);
    const key = crypto.randomUUID();
    const refund = { type: 'refund' as const, payload: { amount: 39 } };

    const first = await actions.executeAction(actionReq(c, { ...refund, idempotencyKey: key }));
    expect(first.status).toBe(502);
    expect(first.body.status).toBe('unknown');
    expect(fake.writes(/refund$/)).toHaveLength(2);
    expect(repo.getClaim(c.claimId)!.status).not.toBe('closed');
    fake.calls = [];

    const retryNewKey = await actions.executeAction(actionReq(c, refund));
    expect(retryNewKey.status).toBe(409);
    expect(retryNewKey.body.blockedBy).toBe(first.body.actionId);

    const replay = await actions.executeAction(actionReq(c, { ...refund, idempotencyKey: key }));
    expect(replay.status).toBe(502);
    expect(replay.body.replay).toBe(true);
    expect(fake.writes(/refund$/)).toHaveLength(0);
  });

  it('人工标记“已生效”后结案，不再重发', async () => {
    const c = await paidOrderClaim();
    fake.failOn('POST', /refund$/, () => json({}, 500), 2);
    const first = await actions.executeAction(actionReq(c, { type: 'refund', payload: { amount: 39 } }));
    fake.calls = [];

    const noConfirm = actions.resolveAction({ claimId: c.claimId, actionId: first.body.actionId as string, outcome: 'succeeded', confirm: false, actor: { id: 'demo-owner', role: 'owner' as const } });
    expect(noConfirm.status).toBe(400);

    const res = actions.resolveAction({ claimId: c.claimId, actionId: first.body.actionId as string, outcome: 'succeeded', confirm: true, actor: { id: 'demo-owner', role: 'owner' as const } });
    expect(res.status).toBe(200);
    expect(repo.getClaim(c.claimId)!.status).toBe('closed');
    expect(fake.calls).toHaveLength(0);
  });

  it('人工标记“没有生效”后可以用新的键重新执行', async () => {
    const c = await paidOrderClaim();
    fake.failOn('POST', /refund$/, () => json({}, 500), 2);
    const first = await actions.executeAction(actionReq(c, { type: 'refund', payload: { amount: 39 } }));
    actions.resolveAction({ claimId: c.claimId, actionId: first.body.actionId as string, outcome: 'failed', confirm: true, actor: { id: 'demo-owner', role: 'owner' as const } });
    const again = await actions.executeAction(actionReq(c, { type: 'refund', payload: { amount: 39 } }));
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('succeeded');
  });

  it('成功或刚开始执行的动作不能被人工改写', async () => {
    const c = await paidOrderClaim();
    const done = await actions.executeAction(actionReq(c));
    const res = actions.resolveAction({ claimId: c.claimId, actionId: done.body.actionId as string, outcome: 'failed', confirm: true, actor: { id: 'demo-owner', role: 'owner' as const } });
    expect(res.status).toBe(409);
    expect(actions.resolveAction({ claimId: 'other', actionId: done.body.actionId as string, outcome: 'failed', confirm: true, actor: { id: 'x', role: 'owner' as const } }).status).toBe(404);
  });

  it('PayPal 明确拒绝时记为失败，可以用新的键重试', async () => {
    const c = await sandboxClaim();
    fake.failOn('POST', /send-message$/, () => json({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'X', description: 'y' }] }, 422));
    const key = crypto.randomUUID();
    const first = await actions.executeAction(actionReq(c, { idempotencyKey: key }));
    expect(first.status).toBe(502);
    expect(first.body.status).toBe('failed');

    const replay = await actions.executeAction(actionReq(c, { idempotencyKey: key }));
    expect(replay.status).toBe(502);
    expect(replay.body.replay).toBe(true);

    expect((await actions.executeAction(actionReq(c))).status).toBe(200);
  });

  it('同一个幂等键并发两次只发一次', async () => {
    const c = await paidOrderClaim();
    const idempotencyKey = crypto.randomUUID();
    const refund = { type: 'refund' as const, payload: { amount: 39 }, idempotencyKey };
    const results = await Promise.all([actions.executeAction(actionReq(c, refund)), actions.executeAction(actionReq(c, refund))]);
    expect(fake.writes(/refund$/)).toHaveLength(1);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(repo.claimActions(c.claimId)).toHaveLength(1);
  });

  it('退款 PENDING 先记为处理中，不结案；确认完成后再结案', async () => {
    const c = await paidOrderClaim();
    fake.failOn('POST', /refund$/, () => json({ id: 'REFUND-PEND', status: 'PENDING' }, 201));
    const first = await actions.executeAction(actionReq(c, { type: 'refund', payload: { amount: 39 } }));
    expect(first.status).toBe(202);
    expect(first.body.status).toBe('processing');
    expect(repo.getClaim(c.claimId)!.status).not.toBe('closed');

    const again = await actions.executeAction(actionReq(c, { type: 'refund', payload: { amount: 39 } }));
    expect(again.status).toBe(409);
    expect(again.body.error).toContain('仍在处理');
    expect(fake.writes(/refund$/)).toHaveLength(1);

    fake.refundStatus = 'COMPLETED';
    await sync.settleProcessingRefunds();
    expect(repo.getClaim(c.claimId)!.status).toBe('closed');
    expect(repo.claimActions(c.claimId)[0].status).toBe('succeeded');
  });

  it('退款完成事件把处理中的退款结案', async () => {
    const c = await paidOrderClaim();
    fake.failOn('POST', /refund$/, () => json({ id: 'REFUND-WH', status: 'PENDING' }, 201));
    const first = await actions.executeAction(actionReq(c, { type: 'refund', payload: { amount: 39 } }));
    expect(first.body.status).toBe('processing');
    const raw = JSON.stringify({
      id: 'WH-REFUND-1',
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: { id: 'REFUND-WH', status: 'COMPLETED' },
    });
    const headers = new Headers({
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
      'paypal-transmission-id': 'tid',
      'paypal-transmission-sig': 'sig',
      'paypal-transmission-time': '2026-11-01T00:00:00Z',
    });
    const out = await sync.handleSandboxWebhook(raw, headers);
    expect(out.status).toBe(200);
    expect(repo.getClaim(c.claimId)!.status).toBe('closed');
  });

  it('退款已受理但响应正文无法解析时记为结果不明，不记为普通失败', async () => {
    const c = await paidOrderClaim();
    fake.failOn('POST', /refund$/, () => new Response('{', { status: 201, headers: { 'content-type': 'application/json' } }));
    const parsed = await actions.executeAction(actionReq(c, { type: 'refund', payload: { amount: 39 } }));
    expect(parsed.status).toBe(502);
    expect(parsed.body.status).toBe('unknown');
    expect(repo.getClaim(c.claimId)!.status).not.toBe('closed');

    const c2 = await paidOrderClaim();
    fake.failOn('POST', /refund$/, () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.error(new Error('连接中断'));
        },
      });
      return new Response(stream, { status: 201 });
    });
    const unread = await actions.executeAction(actionReq(c2, { type: 'refund', payload: { amount: 39 } }));
    expect(unread.body.status).toBe('unknown');
    expect(repo.getClaim(c2.claimId)!.status).not.toBe('closed');
  });

  it('不同的键并发也只发一次（比如两个标签页同时点退款）', async () => {
    const c = await paidOrderClaim();
    const refund = { type: 'refund' as const, payload: { amount: 39 } };
    const results = await Promise.all([actions.executeAction(actionReq(c, refund)), actions.executeAction(actionReq(c, refund))]);
    expect(fake.writes(/refund$/)).toHaveLength(1);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});

describe('证据附件', () => {
  const addEvidence = (claimId: string, orderId: string, buf: Buffer, mime: string) => {
    const id = dbm.newId();
    dbm.db()
      .prepare(`INSERT INTO evidence (id, claim_id, order_id, kind, source, sha256, layer, mime_type, created_at) VALUES (?, ?, ?, 'photo', 'uploaded', ?, 'C', ?, ?)`)
      .run(id, claimId, orderId, storage.saveFile(buf), mime, dbm.nowIso());
    return id;
  };
  const addSignal = (claimId: string, evidenceIds: string[], direction = 'contradicts_claim') =>
    dbm.db()
      .prepare(
        `INSERT INTO signals (id, claim_id, analyzer, code, direction, strength, confidence, evidence_ids, basis_source, explanation, created_at)
         VALUES (?, ?, 'origin', 'TEST', ?, 'strong', 1, ?, 'uploaded', 'x', ?)`,
      )
      .run(dbm.newId(), claimId, direction, JSON.stringify(evidenceIds), dbm.nowIso());
  const image = (color: string) => sharp({ create: { width: 16, height: 16, channels: 3, background: color } });

  it('只附反驳信号引用的、这笔索赔自己的证据；webp 转成 jpeg', async () => {
    const c = await sandboxClaim();
    const orderId = repo.getClaim(c.claimId)!.order_id;
    const other = await sandboxClaim();
    const otherOrder = repo.getClaim(other.claimId)!.order_id;

    const cited = addEvidence(c.claimId, orderId, await image('#112233').jpeg().toBuffer(), 'image/jpeg');
    const webp = addEvidence(c.claimId, orderId, await image('#445566').webp().toBuffer(), 'image/webp');
    const notCited = addEvidence(c.claimId, orderId, await image('#778899').png().toBuffer(), 'image/png');
    const foreign = addEvidence(other.claimId, otherOrder, await image('#aabbcc').jpeg().toBuffer(), 'image/jpeg');
    addSignal(c.claimId, [cited, webp, foreign]);
    addSignal(c.claimId, [notCited], 'supports_claim');

    const { documents: docs } = await attachments.buildEvidenceDocuments(c.claimId);
    expect(docs.map((d) => d.name)).toEqual(['evidence-1.jpg', 'evidence-2.jpg']);
    expect(docs.map((d) => d.mime)).toEqual(['image/jpeg', 'image/jpeg']);
    expect(await sharp(docs[1].data).metadata().then((m) => m.format)).toBe('jpeg');
    expect((await views.claimView(c.claimId))!.paypal.attachments).toBe(2);
  });

  it('提交证据时真的带上文件；取消勾选就不带', async () => {
    const c = await sandboxClaim();
    const orderId = repo.getClaim(c.claimId)!.order_id;
    addSignal(c.claimId, [addEvidence(c.claimId, orderId, await image('#123123').jpeg().toBuffer(), 'image/jpeg')]);

    const res = await actions.executeAction(actionReq(c, { type: 'provide_evidence', payload: { notes: '说明', evidenceType: 'OTHER', attachEvidence: true } }));
    expect(res.status).toBe(200);
    const form = fake.writes(/provide-evidence$/)[0].raw as FormData;
    expect((form.get('file1') as File).name).toBe('evidence-1.jpg');
    // 动作记录里只留文件名，不把图片内容写进数据库。
    expect(JSON.stringify(res.body.response)).not.toContain('"data"');

    const c2 = await sandboxClaim();
    await actions.executeAction(actionReq(c2, { type: 'provide_evidence', payload: { notes: '说明', evidenceType: 'OTHER', attachEvidence: false } }));
    const form2 = fake.writes(/provide-evidence$/)[0].raw as FormData;
    expect(form2.get('file1')).toBeNull();
  });
});

describe('测试下单', () => {
  it('付款前有未付款订单；捕获后写入交易号和模拟物流；重复回跳不重复扣款', async () => {
    const { orderId, approveUrl } = await shop.createTestOrder('mug', 'http://localhost:3000');
    expect(new URL(approveUrl).hostname).toBe('www.sandbox.paypal.com');
    const created = fake.writes(/^\/v2\/checkout\/orders$/)[0];
    expect(created.json.intent).toBe('CAPTURE');
    expect(created.json.purchase_units[0].amount.value).toBe('39.00');
    expect(created.json.purchase_units[0].items[0].quantity).toBe('1');
    expect(created.json.payment_source.paypal.experience_context.return_url).toBe('http://localhost:3000/api/paypal/return');
    expect(repo.getOrder(orderId)!.capture_id).toBeNull();

    await shop.completeTestOrder('PPORDER-1');
    await shop.completeTestOrder('PPORDER-1');
    expect(fake.writes(/capture$/)).toHaveLength(1);

    const order = repo.getOrder(orderId)!;
    expect(order.capture_id).toBe('CAPTURE-77');
    expect(order.buyer_name).toBe('Sand Box');
    expect(order.buyer_email_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(order)).not.toContain('buyer@example.test');
    const tracking = repo.getTracking(order)!;
    expect(tracking.status).toBe('delivered');
    expect(tracking.deliveredPostalCode).toBe('95131');
    // 物流分析器会把早于下单时间的轨迹判成异常。
    expect(new Date(tracking.events[0].at).getTime()).toBeGreaterThanOrEqual(new Date(order.created_at).getTime());
    dbm.db().prepare('DELETE FROM orders WHERE id = ?').run(orderId);
  });

  it('付款链接不是沙箱地址时拒绝，不落库', async () => {
    fake.failOn('POST', /^\/v2\/checkout\/orders$/, () => json({ id: 'X', links: [{ rel: 'payer-action', href: 'https://www.paypal.com/checkoutnow?token=X' }] }));
    await expect(shop.createTestOrder('mug', 'http://localhost:3000')).rejects.toThrow(/不是沙箱地址/);
    expect(dbm.db().prepare("SELECT 1 FROM orders WHERE paypal_order_id = 'X'").get()).toBeUndefined();
  });

  it('未知商品直接拒绝，不调用 PayPal', async () => {
    await expect(shop.createTestOrder('nope', 'http://localhost:3000')).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });

  it('把付款状态翻译成商家能看懂的话', () => {
    const state = (status: string, reason: string | null, sellerProtection: string | null) => shop.describeCapture({ status, reason, sellerProtection });
    expect(state('COMPLETED', null, 'ELIGIBLE')).toEqual({ summary: '已完成 · 有卖家保护', warning: null });
    const echeck = state('PENDING', 'ECHECK', 'NOT_ELIGIBLE');
    expect(echeck.summary).toBe('待处理 · 没有卖家保护');
    expect(echeck.warning).toMatch(/eCheck/);
    expect(echeck.warning).toMatch(/Visa/);
    expect(state('PENDING', 'BUYER_COMPLAINT', 'ELIGIBLE').warning).toMatch(/暂扣/);
    expect(state('PENDING', 'RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION', null).warning).toMatch(/RECEIVING_PREFERENCE/);
    expect(state('PARTIALLY_REFUNDED', null, null)).toEqual({ summary: '已部分退款', warning: null });
    expect(state('SOMETHING_NEW', null, null).summary).toBe('SOMETHING_NEW');
  });

  it('读取付款状态：读 PayPal 的当前值，读不到也不影响页面', async () => {
    const { orderId } = await shop.createTestOrder('mug', 'http://localhost:3000');
    expect(await shop.captureState(repo.getOrder(orderId)!)).toBeNull(); // 没付款，没有可读的。
    await shop.completeTestOrder('PPORDER-1');
    fake.calls = [];

    fake.failOn('GET', /^\/v2\/payments\/captures\/CAPTURE-77$/, () =>
      json({ status: 'PENDING', status_details: { reason: 'ECHECK' }, seller_protection: { status: 'NOT_ELIGIBLE' } }),
    );
    const read = await shop.captureState(repo.getOrder(orderId)!);
    expect(read).toMatchObject({ summary: '待处理 · 没有卖家保护', error: null });
    expect(read!.warning).toMatch(/Visa/);
    expect(fake.writes(/.*/)).toHaveLength(0);

    fake.failOn('GET', /^\/v2\/payments\/captures\//, () => json({ name: 'INTERNAL', message: '坏了' }, 500), 2);
    const failed = await shop.captureState(repo.getOrder(orderId)!);
    expect(failed).toMatchObject({ summary: '暂时读取不到', warning: null });
    expect(failed!.error).toBeTruthy();
    dbm.db().prepare('DELETE FROM orders WHERE id = ?').run(orderId);
  });

  it('模拟器订单不读 PayPal 的付款状态', async () => {
    const simulated = dbm.db().prepare("SELECT * FROM orders WHERE paypal_env = 'simulator' AND capture_id IS NOT NULL LIMIT 1").get() as unknown as import('@/server/repo').OrderRow;
    fake.calls = [];
    expect(await shop.captureState(simulated)).toBeNull();
    expect(fake.reads(/captures/)).toHaveLength(0);
  });

  it('索赔页只在没有争议时提示付款状态', async () => {
    const pendingCapture = () => json({ status: 'PENDING', status_details: { reason: 'ECHECK' }, seller_protection: { status: 'NOT_ELIGIBLE' } });
    const paid = await paidOrderClaim();
    fake.failOn('GET', /^\/v2\/payments\/captures\//, pendingCapture);
    expect((await views.claimView(paid.claimId))!.paypal.captureWarning).toMatch(/Visa/);

    const disputed = await sandboxClaim();
    fake.calls = [];
    expect((await views.claimView(disputed.claimId))!.paypal.captureWarning).toBeNull();
    expect(fake.reads(/captures/)).toHaveLength(0);
  });

  it('取消只删未付款的订单', async () => {
    const { orderId } = await shop.createTestOrder('buds', 'http://localhost:3000');
    await shop.completeTestOrder('PPORDER-1');
    shop.cancelTestOrder('PPORDER-1');
    expect(repo.getOrder(orderId)).toBeTruthy();
    dbm.db().prepare('DELETE FROM orders WHERE id = ?').run(orderId);

    const unpaid = await shop.createTestOrder('buds', 'http://localhost:3000');
    shop.cancelTestOrder('PPORDER-1');
    expect(repo.getOrder(unpaid.orderId)).toBeUndefined();
  });

  it('捕获响应里没有交易号时报错，不写入', async () => {
    const { orderId } = await shop.createTestOrder('jacket', 'http://localhost:3000');
    fake.failOn('POST', /capture$/, () => json({ purchase_units: [] }));
    await expect(shop.completeTestOrder('PPORDER-1')).rejects.toThrow(/交易 ID/);
    expect(repo.getOrder(orderId)!.capture_id).toBeNull();
    dbm.db().prepare('DELETE FROM orders WHERE id = ?').run(orderId);
  });
});

describe('连接检查', () => {
  it('全部通过，输出不含 secret', async () => {
    fake.failOn('GET', /notifications\/webhooks\/WH-CONFIG-ID$/, () =>
      json({ url: 'https://x/webhooks/paypal', event_types: [{ name: 'CUSTOMER.DISPUTE.CREATED' }, { name: 'CUSTOMER.DISPUTE.UPDATED' }, { name: 'CUSTOMER.DISPUTE.RESOLVED' }] }),
    );
    const checks = await client().checkConnection();
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(JSON.stringify(checks)).not.toContain(SECRET);
    expect(fake.calls.filter((c) => c.method === 'POST' && c.path !== '/v1/oauth2/token')).toHaveLength(0);
  });

  it('没订阅争议事件时指出来', async () => {
    fake.failOn('GET', /notifications\/webhooks\/WH-CONFIG-ID$/, () => json({ url: 'https://x', event_types: [{ name: 'PAYMENT.CAPTURE.COMPLETED' }] }));
    const checks = await client().checkConnection();
    const webhook = checks.find((c) => c.name === 'Webhook')!;
    expect(webhook.ok).toBe(false);
    expect(webhook.detail).toContain('CUSTOMER.DISPUTE.CREATED');
  });
});

describe('跨站请求', () => {
  const req = (h: Record<string, string>) => ({ headers: new Headers(h) }) as unknown as import('next/server').NextRequest;

  it('同源放行，其他网站拒绝', () => {
    expect(origin.isCrossSite(req({ host: 'localhost:3000', origin: 'http://localhost:3000' }))).toBe(false);
    expect(origin.isCrossSite(req({ host: 'localhost:3000' }))).toBe(false);
    expect(origin.isCrossSite(req({ host: 'localhost:3000', origin: 'https://evil.example' }))).toBe(true);
    expect(origin.isCrossSite(req({ host: 'localhost:3000', 'sec-fetch-site': 'cross-site' }))).toBe(true);
    expect(origin.isCrossSite(req({ host: 'localhost:3000', origin: 'null' }))).toBe(true);
  });
});

describe('后续争议操作：补充说明、确认退货、申诉', () => {
  const linksFor = (id: string, segments: string[]) =>
    segments.map((s) => ({ href: `https://api-m.sandbox.paypal.com/v1/customer/disputes/${id}/${s}`, rel: s, method: 'POST' }));

  it('三个操作只在 PayPal 给了链接时才允许', () => {
    const allowed = (links: unknown[]) => sandbox.toDisputeView(rawDispute('D1', { links, allowed_response_options: {} })).allowedActions;
    expect(allowed(linksFor('D1', ['provide-supporting-info', 'acknowledge-return-item', 'appeal']))).toEqual([
      'provide_supporting_info',
      'acknowledge_return_item',
      'appeal',
    ]);
    expect(allowed([])).toEqual([]);
  });

  it('provide-supporting-info 是 multipart，input 只有 notes', async () => {
    const documents = [{ name: 'evidence-1.jpg', mime: 'image/jpeg', data: Buffer.from('one') }];
    await client().provideSupportingInfo('D1', { notes: '补充', documents }, 'k1');
    const call = fake.writes(/provide-supporting-info$/)[0];
    const form = call.raw as FormData;
    expect(JSON.parse(await (form.get('input') as Blob).text())).toEqual({ notes: '补充' });
    expect((form.get('file1') as File).name).toBe('evidence-1.jpg');
    expect(call.headers.get('paypal-request-id')).toBe('k1');
  });

  it('acknowledge-return-item 是 JSON，带 acknowledgement_type', async () => {
    await client().acknowledgeReturnItem('D1', { note: '收到空箱', acknowledgementType: 'EMPTY_PACKAGE_OR_DIFFERENT' }, 'k2');
    expect(fake.writes(/acknowledge-return-item$/)[0].json).toEqual({ note: '收到空箱', acknowledgement_type: 'EMPTY_PACKAGE_OR_DIFFERENT' });
  });

  it('appeal 的请求体与 provide-evidence 相同', async () => {
    await client().appealDispute('D1', { evidenceType: 'PROOF_OF_FULFILLMENT', notes: '申诉', documents: [], trackingNumber: '1Z', carrier: 'UPS' }, 'k3');
    const form = fake.writes(/appeal$/)[0].raw as FormData;
    expect(JSON.parse(await (form.get('input') as Blob).text())).toEqual({
      evidences: [
        { evidence_type: 'PROOF_OF_FULFILLMENT', notes: '申诉', evidence_info: { tracking_info: [{ carrier_name: 'UPS', tracking_number: '1Z' }] } },
      ],
    });
  });

  it('退货验收结果必须是 PayPal 认识的值', async () => {
    const c = await sandboxClaim({ links: linksFor('x', ['acknowledge-return-item']).map((l) => ({ ...l, href: l.href.replace('/x/', '/any/') })) });
    const bad = await actions.executeAction(actionReq(c, { type: 'acknowledge_return_item', payload: { acknowledgementType: 'WHATEVER' as never } }));
    expect(bad.status).toBe(400);
    expect(sellerWrites()).toHaveLength(0);
    const ok = await actions.executeAction(actionReq(c, { type: 'acknowledge_return_item', payload: { acknowledgementType: 'MISSING_ITEMS' } }));
    expect(ok.status).toBe(200);
    expect(fake.writes(/acknowledge-return-item$/)[0].json).toEqual({ note: '商家已处理买家退回的包裹。', acknowledgement_type: 'MISSING_ITEMS' });
  });

  it('补充说明不能为空，并且只在 UNDER_REVIEW 给了链接时可用', async () => {
    const c = await sandboxClaim();
    expect((await actions.executeAction(actionReq(c, { type: 'provide_supporting_info', payload: { notes: 'x' } }))).status).toBe(409);
    fake.disputes.set(c.disputeId, rawDispute(c.disputeId, { status: 'UNDER_REVIEW', links: linksFor(c.disputeId, ['provide-supporting-info']) }));
    expect((await actions.executeAction(actionReq(c, { type: 'provide_supporting_info', payload: { notes: ' ' } }))).status).toBe(400);
    const ok = await actions.executeAction(actionReq(c, { type: 'provide_supporting_info', payload: { notes: '补充事实' } }));
    expect(ok.status).toBe(200);
    expect(fake.writes(/provide-supporting-info$/)).toHaveLength(1);
  });

  it('PayPal 允许退货退款时多出“提出退货退款”选项，执行时带上退货地址', async () => {
    const c = await sandboxClaim({
      reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
      allowed_response_options: { make_offer: { offer_types: ['REFUND', 'REFUND_WITH_RETURN'] } },
    });
    // 这条争议的判定不是和解。请求体才是这里要核对的，先把建议改成和解。
    const stored = dbm.db().prepare('SELECT report FROM verdicts WHERE id = ?').get(c.verdictId) as { report: string };
    const report = JSON.parse(stored.report) as { primaryAction: { type: string } };
    report.primaryAction = { ...report.primaryAction, type: 'make_offer' };
    dbm.db().prepare(`UPDATE verdicts SET suggested_action = 'make_offer', report = ? WHERE id = ?`).run(JSON.stringify(report), c.verdictId);
    const view = await views.claimView(c.claimId);
    const offer = view!.followUps.find((f) => f.type === 'make_offer')!;
    expect(offer).toMatchObject({ withReturn: true, label: '提出退货退款' });
    expect(view!.paypal.offerTypes).toEqual(['REFUND', 'REFUND_WITH_RETURN']);
    expect(view!.paypal.returnAddress).toContain('San Jose');

    const res = await actions.executeAction(actionReq(c, { type: 'make_offer', payload: { amount: offer.offerAmount, notes: offer.notes, withReturn: true } }));
    expect(res.status).toBe(200);
    expect(fake.writes(/make-offer$/)[0].json).toMatchObject({ offer_type: 'REFUND_WITH_RETURN', return_shipping_address: { postal_code: '95134' } });

    // 买家寄回后只剩确认退货，不再提示退货退款。
    fake.disputes.set(
      c.disputeId,
      rawDispute(c.disputeId, {
        reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
        allowed_response_options: { make_offer: { offer_types: ['REFUND', 'REFUND_WITH_RETURN'] } },
        links: linksFor(c.disputeId, ['make-offer', 'acknowledge-return-item', 'send-message']),
      }),
    );
    await client().getDispute(c.disputeId, { fresh: true });
    const shipped = await views.claimView(c.claimId);
    expect(shipped!.followUps.map((f) => f.type)).toEqual(['acknowledge_return_item']);

    // 只允许直接退款的争议不给这个选项。
    const plain = await sandboxClaim();
    expect((await views.claimView(plain.claimId))!.followUps.some((f) => f.type === 'make_offer')).toBe(false);
  });

  it('已结案的索赔只开放申诉；申诉后索赔重新进入处理中', async () => {
    const c = await sandboxClaim();
    fake.disputes.set(
      c.disputeId,
      rawDispute(c.disputeId, {
        status: 'RESOLVED',
        dispute_outcome: { outcome_code: 'RESOLVED_BUYER_FAVOUR' },
        links: linksFor(c.disputeId, ['appeal', 'send-message']),
      }),
    );
    sync.upsertClaimFromDispute((await client().getDispute(c.disputeId, { fresh: true }))!);
    expect(repo.getClaim(c.claimId)!.status).toBe('closed');

    const view = await views.claimView(c.claimId);
    expect(view!.allowedActions).toEqual(['appeal']);
    expect(view!.followUps.map((f) => f.type)).toEqual(['appeal']);

    expect((await actions.executeAction(actionReq(c, { type: 'send_message' }))).status).toBe(409);
    const res = await actions.executeAction(actionReq(c, { type: 'appeal', payload: { evidenceType: 'OTHER', notes: '有新的物流证据' } }));
    expect(res.status).toBe(200);
    expect(fake.writes(/appeal$/)).toHaveLength(1);
    expect(repo.getClaim(c.claimId)!.status).toBe('action_sent');
  });

  it('模拟器：提交证据后进入 UNDER_REVIEW，可以补充说明', async () => {
    const demo = repo
      .listClaims()
      .find((c) => c.paypalEnv === 'simulator' && c.status === 'awaiting_decision' && repo.claimDetail(c.id)!.claim.disputeId)!;
    const verdictId = repo.latestVerdict(demo.id)!.id;
    const first = await actions.executeAction(actionReq({ claimId: demo.id, verdictId }, { type: 'provide_evidence', payload: { evidenceType: 'OTHER', notes: '说明' } }));
    expect(first.status).toBe(200);
    const view = await views.claimView(demo.id);
    expect(view!.allowedActions).toContain('provide_supporting_info');
    expect(view!.followUps.map((f) => f.type)).toEqual(['provide_supporting_info']);
    const res = await actions.executeAction(actionReq({ claimId: demo.id, verdictId }, { type: 'provide_supporting_info', payload: { notes: '补充' } }));
    expect(res.status).toBe(200);
    expect(res.body.response).toMatchObject({ simulated: true });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('核验报告 PDF', () => {
  it('提交证据时附报告 PDF，放在第一个文件', async () => {
    const reportPdf = await import('@/server/report-pdf');
    if (!reportPdf.findReportFont()) return; // 没有中文字体的机器上跳过，下面单独测降级。
    const c = await sandboxClaim();
    const res = await actions.executeAction(
      actionReq(c, { type: 'provide_evidence', payload: { notes: '说明', evidenceType: 'OTHER', attachEvidence: false, attachReport: true } }),
    );
    expect(res.status).toBe(200);
    const form = fake.writes(/provide-evidence$/)[0].raw as FormData;
    const file1 = form.get('file1') as File;
    expect(file1.name).toBe('verdict-report.pdf');
    expect(file1.type).toBe('application/pdf');
    expect(Buffer.from(await file1.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
    const input = JSON.parse(await (form.get('input') as Blob).text());
    expect(input.evidences[0].documents).toEqual([{ name: 'verdict-report.pdf' }]);
    expect(res.body.response).toMatchObject({ documents: ['verdict-report.pdf'] });
  });

  it('提交版时间线不含失败的动作、测试工具和确认人', async () => {
    const reportPdf = await import('@/server/report-pdf');
    const c = await sandboxClaim();
    fake.failOn('POST', /send-message$/, () => json({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'NOT_ALLOWED' }] }, 422));
    expect((await actions.executeAction(actionReq(c))).status).toBe(502);
    expect((await actions.executeAction(actionReq(c))).status).toBe(200);
    fake.disputes.set(c.disputeId, rawDispute(c.disputeId, { links: [{ href: `https://x/v1/customer/disputes/${c.disputeId}/adjudicate`, rel: 'adjudicate' }] }));
    expect((await actions.runSandboxTool({ claimId: c.claimId, tool: 'adjudicate', value: 'SELLER_FAVOR', confirm: true })).status).toBe(200);

    const timeline = repo.claimTimeline(c.claimId);
    const merchant = reportPdf.visibleTimeline(timeline, 'merchant');
    const paypal = reportPdf.visibleTimeline(timeline, 'paypal');
    expect(merchant.map((t) => t.title)).toEqual(expect.arrayContaining(['动作执行失败', '沙箱测试工具', '商家发送消息']));
    expect(paypal.map((t) => t.title)).toContain('商家发送消息');
    expect(paypal.map((t) => t.title)).not.toContain('动作执行失败');
    expect(paypal.map((t) => t.title)).not.toContain('沙箱测试工具');
    expect(JSON.stringify(paypal)).not.toContain('确认人');
    expect(JSON.stringify(paypal)).not.toContain('/v1/customer/disputes');
  });

  it('找不到字体时照常提交，只在结果里注明没附上报告', async () => {
    process.env.VERDICT_REPORT_FONT = path.join(dir, 'no-such-font.ttf');
    try {
      const c = await sandboxClaim();
      const res = await actions.executeAction(
        actionReq(c, { type: 'provide_evidence', payload: { notes: '说明', evidenceType: 'OTHER', attachEvidence: false, attachReport: true } }),
      );
      expect(res.status).toBe(200);
      expect(String((res.body.response as Record<string, unknown>).reportSkipped)).toContain('字体');
      expect((fake.writes(/provide-evidence$/)[0].raw as FormData).get('file1')).toBeNull();
      expect((await views.claimView(c.claimId))!.paypal.reportAvailable).toBe(false);
    } finally {
      delete process.env.VERDICT_REPORT_FONT;
    }
  });
});
