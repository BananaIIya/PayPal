// 动作执行器、token、webhook、来源扫描，以及“只有执行器能调用 PayPal 写接口”的结构性检查。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-server-test-'));
process.env.VERDICT_DATA_DIR = dir;
delete process.env.LLM_API_KEY;
delete process.env.LLM_PROVIDER;

let repo: typeof import('@/server/repo');
let actions: typeof import('@/server/actions');
let tokens: typeof import('@/server/tokens');
let ingest: typeof import('@/server/ingest');
let db: typeof import('@/server/db');
let sim: typeof import('@/paypal/simulator');

function claimByScenario(key: string) {
  const item = repo.listClaims().find((c) => repo.claimDetail(c.id)!.claim.scenario?.key === key)!;
  return repo.claimDetail(item.id)!;
}

function req(d: ReturnType<typeof claimByScenario>, over: Partial<import('@/server/actions').ActionRequest> = {}) {
  return {
    claimId: d.claim.id,
    type: 'send_message' as const,
    verdictId: d.verdict!.id,
    confirm: true,
    idempotencyKey: crypto.randomUUID(),
    confirmedBy: 'demo-owner',
    origin: 'http://localhost:3000',
    payload: { message: '您好，请补充照片。' },
    ...over,
  };
}

beforeAll(async () => {
  const { seedDemo } = await import('@/demo/seed');
  repo = await import('@/server/repo');
  actions = await import('@/server/actions');
  tokens = await import('@/server/tokens');
  ingest = await import('@/server/ingest');
  db = await import('@/server/db');
  sim = await import('@/paypal/simulator');
  await seedDemo();
}, 120000);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('动作执行器', () => {
  it('没有 confirm 不执行，也不落库', async () => {
    const d = claimByScenario('insufficient');
    const res = await actions.executeAction(req(d, { confirm: false }));
    expect(res.status).toBe(400);
    expect(repo.claimActions(d.claim.id)).toHaveLength(0);
  });

  it('verdictId 不是最新判定时拒绝', async () => {
    const d = claimByScenario('insufficient');
    const res = await actions.executeAction(req(d, { verdictId: 'stale' }));
    expect(res.status).toBe(409);
    expect(repo.claimActions(d.claim.id)).toHaveLength(0);
  });

  it('缺少确认人时拒绝', async () => {
    const d = claimByScenario('insufficient');
    expect((await actions.executeAction(req(d, { confirmedBy: '' }))).status).toBe(401);
  });

  it('金额超过订单金额时拒绝', async () => {
    const d = claimByScenario('partial_missing');
    const res = await actions.executeAction(req(d, { type: 'make_offer', payload: { amount: 9999, notes: 'x' } }));
    expect(res.status).toBe(400);
  });

  it('消息里的占位符替换成一次性索赔页链接，token 可以验证', async () => {
    const d = claimByScenario('insufficient');
    const res = await actions.executeAction(req(d, { payload: { message: '请通过此链接拍摄：{{索赔页链接}}。' } }));
    expect(res.status).toBe(200);
    const message = (res.body.response as { message: string }).message;
    expect(message).not.toContain('{{');
    const token = message.match(/\/c\/([^\s。]+)/)![1];
    const check = tokens.checkPortalToken(token);
    expect(check.ok).toBe(true);
  });

  it('幂等键相同只执行一次', async () => {
    const d = claimByScenario('genuine_damage');
    const key = crypto.randomUUID();
    const body = req(d, { type: 'refund', idempotencyKey: key, payload: { amount: 48 } });
    const first = await actions.executeAction(body);
    const second = await actions.executeAction(body);
    expect(first.status).toBe(200);
    expect(second.body.replay).toBe(true);
    const refunds = db.db().prepare('SELECT COUNT(*) AS n FROM sim_refunds').get() as { n: number };
    expect(refunds.n).toBe(1);
    expect(repo.getClaim(d.claim.id)!.status).toBe('closed');
  });

  it('结案后不能再退款，防止重复打款', async () => {
    const d = claimByScenario('genuine_damage');
    const res = await actions.executeAction(req(d, { type: 'refund', payload: { amount: 48 } }));
    expect(res.status).toBe(409);
  });

  it('PayPal 不允许的动作被拒绝：私下请求不能 provide_evidence', async () => {
    const d = claimByScenario('fake_chat');
    const res = await actions.executeAction(
      req(d, { type: 'provide_evidence', payload: { notes: 'x', evidenceType: 'OTHER' } }),
    );
    expect(res.status).toBe(409);
  });

  it('提交证据后争议进入 UNDER_REVIEW，不能再次提交', async () => {
    const d = claimByScenario('ai_watermark');
    const res = await actions.executeAction(
      req(d, { type: 'provide_evidence', payload: { notes: '说明', evidenceType: 'OTHER', attachEvidence: true } }),
    );
    expect(res.status).toBe(200);
    const dispute = await sim.getPayPalClient().getDispute(d.claim.disputeId!);
    expect(dispute!.status).toBe('UNDER_REVIEW');
    const again = await actions.executeAction(
      req(d, { type: 'provide_evidence', payload: { notes: '说明', evidenceType: 'OTHER' } }),
    );
    expect(again.status).toBe(409);
  });

  it('物流证据必须带单号', async () => {
    const d = claimByScenario('delivered_not_received');
    const res = await actions.executeAction(
      req(d, { type: 'provide_evidence', payload: { notes: '说明', evidenceType: 'PROOF_OF_FULFILLMENT' } }),
    );
    expect(res.status).toBe(400);
  });
});

describe('索赔页 token', () => {
  const ids = { merchantId: 'demo-merchant', orderId: 'o', claimId: '' };
  const claimId = () => claimByScenario('detectors_down').claim.id;

  it('篡改后无效', () => {
    const t = tokens.issuePortalToken({ ...ids, claimId: claimId() });
    const [body, mac] = t.split('.');
    const forged = `${Buffer.from(JSON.stringify({ exp: Date.now() + 1e9 })).toString('base64url')}.${mac}`;
    expect(tokens.checkPortalToken(`${body}.AAAA`).ok).toBe(false);
    expect(tokens.checkPortalToken(forged).ok).toBe(false);
  });

  it('过期返回 410', () => {
    const t = tokens.issuePortalToken({ ...ids, claimId: claimId() }, { ttlMs: -1000 });
    const check = tokens.checkPortalToken(t);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.status).toBe(410);
  });

  it('次数用尽返回 410', () => {
    const t = tokens.issuePortalToken({ ...ids, claimId: claimId() }, { maxSubmissions: 1 });
    const first = tokens.checkPortalToken(t);
    expect(first.ok).toBe(true);
    if (first.ok) tokens.consumePortalToken(first.payload.jti);
    const second = tokens.checkPortalToken(t);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.status).toBe(410);
  });
});

describe('PayPal webhook', () => {
  it('验签失败返回 401；同一事件 ID 只处理一次', async () => {
    const order = db.db().prepare('SELECT id FROM orders LIMIT 1').get() as { id: string };
    const disputeId = sim.createSimulatedDispute({
      orderId: order.id,
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      buyerMessage: '没收到',
      dueAt: new Date(Date.now() + 86400000).toISOString(),
    });
    const body = JSON.stringify({ id: 'WH-1', event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { dispute_id: disputeId } });

    expect((await ingest.handleWebhook(body, 'bad')).status).toBe(401);
    const sig = sim.signSimulatedWebhook(body);
    const first = await ingest.handleWebhook(body, sig);
    expect(first.status).toBe(200);
    expect(first.body.claimId).toBeTruthy();
    const replay = await ingest.handleWebhook(body, sig);
    expect(replay.body.duplicate).toBe(true);

    const count = db.db().prepare('SELECT COUNT(*) AS n FROM claims WHERE paypal_dispute_id = ?').get(disputeId) as { n: number };
    expect(count.n).toBe(1);
  });
});

describe('来源扫描', () => {
  it('识别 JPEG 中的 C2PA AI 来源声明，普通 JPEG 不误报', async () => {
    const { scanProvenance } = await import('@/analyzers/provenance-scan');
    const { renderScene, injectSimulatedC2PA } = await import('@/demo/images');
    const plain = await renderScene({ kind: 'mug', seed: 1 });
    const clean = scanProvenance(plain, 'image/jpeg');
    expect(clean.c2paManifest).toBe(false);
    expect(clean.aiSourceType).toBe(false);

    const tagged = scanProvenance(injectSimulatedC2PA(plain), 'image/jpeg');
    expect(tagged.c2paManifest).toBe(true);
    expect(tagged.aiSourceType).toBe(true);
    expect(tagged.generator).toBe('ChatGPT');
  });

  it('识别 PNG 的 caBX 块和 AIGC 隐式标识', async () => {
    const { scanProvenance } = await import('@/analyzers/provenance-scan');
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
    };
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const c2pa = Buffer.concat([sig, chunk('caBX', Buffer.from('jumb c2pa trainedAlgorithmicMedia Gemini')), chunk('IEND', Buffer.alloc(0))]);
    const aigc = Buffer.concat([sig, chunk('tEXt', Buffer.from('AIGC\0{"Label":"1","ContentProducer":"x"}', 'latin1')), chunk('IEND', Buffer.alloc(0))]);
    const none = Buffer.concat([sig, chunk('tEXt', Buffer.from('Comment\0hello AIGC world', 'latin1')), chunk('IEND', Buffer.alloc(0))]);

    expect(scanProvenance(c2pa, 'image/png')).toMatchObject({ c2paManifest: true, aiSourceType: true, generator: 'Gemini' });
    expect(scanProvenance(aigc, 'image/png').aigcLabel).toBe(true);
    expect(scanProvenance(none, 'image/png').aigcLabel).toBe(false);
  });

  it('序列号比较对易混字符宽容，但能区分真正不同的序列号', async () => {
    const { normalizeSerial } = await import('@/analyzers');
    expect(normalizeSerial('M-O48I3')).toBe(normalizeSerial('m 04813'));
    expect(normalizeSerial('APB-7731')).not.toBe(normalizeSerial('APB-2208'));
  });
});

describe('资金动作路径（结构性检查）', () => {
  function walk(d: string): string[] {
    return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) ? [p] : [];
    });
  }
  const src = path.resolve(__dirname, '../src');
  const WRITE_CALL = /\.(sendMessage|provideEvidence|provideSupportingInfo|acknowledgeReturnItem|appealDispute|makeOffer|acceptClaim|escalate|refundCapture)\(/;

  it('PayPal 写接口只在动作执行器和模拟器内部被调用', () => {
    const callers = walk(src)
      .filter((f) => WRITE_CALL.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(src, f))
      .filter((f) => !f.startsWith('paypal/'));
    expect(callers).toEqual(['server/actions.ts']);
  });

  it('沙箱测试接口只在动作执行器里调用，下单和捕获只在测试商店里调用', () => {
    const callersOf = (re: RegExp) =>
      walk(src)
        .filter((f) => re.test(fs.readFileSync(f, 'utf8')))
        .map((f) => path.relative(src, f))
        .filter((f) => !f.startsWith('paypal/'));
    expect(callersOf(/\.(requireEvidence|adjudicate)\(/)).toEqual(['server/actions.ts']);
    expect(callersOf(/\.(createOrder|captureOrder)\(/)).toEqual(['server/sandbox-shop.ts']);
  });

  it('判定引擎、分析器、provider 都不依赖 PayPal 客户端和动作执行器', () => {
    const pure = ['core', 'analyzers', 'providers'].flatMap((d) => walk(path.join(src, d)));
    for (const f of pure) {
      const text = fs.readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/from '@\/paypal|from '@\/server\/actions|getPayPalClient/);
    }
  });

  it('actions 表的确认字段是非空约束', () => {
    const insert = () =>
      db.db()
        .prepare("INSERT INTO actions (id, claim_id, verdict_id, type, payload, confirmed_at, status) VALUES ('x','x','x','refund','{}','now','pending')")
        .run();
    expect(insert).toThrow(/NOT NULL/);
  });
});

describe('图片复用与行为统计的误报保护', () => {
  const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

  async function flatImage(r: number, g: number, b: number) {
    const sharp = (await import('sharp')).default;
    return sharp({ create: { width: 640, height: 480, channels: 3, background: { r, g, b } } }).jpeg().toBuffer();
  }

  async function analyzeWith(orderId: string, file: Buffer, when: string) {
    const pipeline = await import('@/server/pipeline');
    const order = repo.getOrder(orderId)!;
    const claimId = ingest.createClaim({ merchantId: order.merchant_id, orderId, origin: 'portal', type: 'damaged', status: 'analyzing' });
    await repo.addEvidence({ claimId, orderId, source: 'uploaded', file, mime: 'image/jpeg', shot: 'overall', at: when });
    await pipeline.runAnalysis(claimId, { latencyMs: 0 });
    return repo.claimSignals(claimId).map((s) => s.code);
  }

  it('纯色图的哈希不算有效信息', async () => {
    const { isInformativeHash, perceptualHash } = await import('@/server/storage');
    expect(isInformativeHash(await perceptualHash(await flatImage(0, 0, 0)))).toBe(false);
    expect(isInformativeHash(await perceptualHash(await flatImage(250, 250, 250)))).toBe(false);
  });

  it('黑帧不会被判成复用了其他订单的低纹理图（聊天截图等）', async () => {
    const codes = await analyzeWith(claimByScenario('perishable').order.id, await flatImage(3, 3, 3), at(10));
    expect(codes).not.toContain('EVIDENCE_REUSED_ACROSS_CLAIMS');
  });

  it('字节完全相同的文件仍然算复用，不受纹理影响', async () => {
    const file = await flatImage(40, 90, 160);
    await analyzeWith(claimByScenario('listing_changed').order.id, file, at(20));
    const codes = await analyzeWith(claimByScenario('partial_missing').order.id, file, at(30));
    expect(codes).toContain('EVIDENCE_REUSED_ACROSS_CLAIMS');
  });

  it('买家还没提交的索赔不计入买家索赔次数', async () => {
    const pipeline = await import('@/server/pipeline');
    const orderId = claimByScenario('genuine_damage').order.id;
    const order = repo.getOrder(orderId)!;
    for (let i = 0; i < 4; i++) {
      ingest.createClaim({ merchantId: order.merchant_id, orderId, origin: 'portal', type: 'damaged', status: 'collecting' });
    }
    const claimId = ingest.createClaim({ merchantId: order.merchant_id, orderId, origin: 'portal', type: 'damaged', status: 'analyzing' });
    await pipeline.runAnalysis(claimId, { latencyMs: 0 });
    expect(repo.claimSignals(claimId).map((s) => s.code)).not.toContain('HIGH_CLAIM_FREQUENCY');
  });
});

describe('核验报告 PDF', () => {
  it('每个演示场景都能生成商家版和提交版', async () => {
    const reportPdf = await import('@/server/report-pdf');
    if (!reportPdf.findReportFont()) return;
    for (const item of repo.listClaims().filter((c) => c.level)) {
      for (const audience of ['merchant', 'paypal'] as const) {
        const out = await reportPdf.renderReportPdf(item.id, audience);
        expect(out!.data.subarray(0, 5).toString(), `${item.scenarioTitle} ${audience}`).toBe('%PDF-');
      }
    }
  }, 60000);

  it('提交版不含 Behavior 发现', async () => {
    const reportPdf = await import('@/server/report-pdf');
    const base = repo.listClaims().map((c) => repo.claimDetail(c.id)!).find((d) => d.verdict?.report.findings.length)!.verdict!.report;
    const behavior = { ...base.findings[0], analyzer: 'behavior' as const, code: 'HIGH_CLAIM_FREQUENCY', signalIds: ['b1'] };
    const report = { ...base, findings: [...base.findings, behavior] };
    expect(reportPdf.visibleFindings(report, 'merchant')).toContain(behavior);
    expect(reportPdf.visibleFindings(report, 'paypal').some((f) => f.analyzer === 'behavior')).toBe(false);
    expect(reportPdf.visibleFindings(report, 'paypal')).toHaveLength(base.findings.filter((f) => f.analyzer !== 'behavior').length);
  });

  it('没有判定的索赔返回 null', async () => {
    const reportPdf = await import('@/server/report-pdf');
    expect(await reportPdf.renderReportPdf('no-such-claim', 'merchant')).toBeNull();
  });
});
