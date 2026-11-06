// 影子模式：判定照常计算但不显示；动作记下是在影子模式下做的；对照统计和一致率。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-shadow-test-'));
process.env.VERDICT_DATA_DIR = dir;
delete process.env.LLM_API_KEY;
delete process.env.LLM_PROVIDER;

let repo: typeof import('@/server/repo');
let settings: typeof import('@/server/settings');
let views: typeof import('@/server/views');
let actions: typeof import('@/server/actions');
let shadow: typeof import('@/server/shadow');
let db: typeof import('@/server/db');
let merchantId: string;

function claimByScenario(key: string) {
  const item = repo.listClaims().find((c) => repo.claimDetail(c.id)!.claim.scenario?.key === key)!;
  return repo.claimDetail(item.id)!;
}

function act(d: ReturnType<typeof claimByScenario>, type: import('@/core/types').ActionType, payload: Record<string, unknown>) {
  return actions.executeAction({
    claimId: d.claim.id,
    type,
    verdictId: d.verdict!.id,
    confirm: true,
    idempotencyKey: crypto.randomUUID(),
    actor: { id: 'demo-owner', role: 'owner' },
    origin: 'http://localhost:3000',
    payload,
  });
}

beforeAll(async () => {
  const { seedDemo } = await import('@/demo/seed');
  repo = await import('@/server/repo');
  settings = await import('@/server/settings');
  views = await import('@/server/views');
  actions = await import('@/server/actions');
  shadow = await import('@/server/shadow');
  db = await import('@/server/db');
  await seedDemo();
  merchantId = repo.defaultMerchantId()!;
}, 120000);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('影子模式', () => {
  it('开关只有布尔值有效，不触发重新判定', () => {
    expect(settings.updateSettings(merchantId, { shadowMode: 'yes' as unknown as boolean }).ok).toBe(false);
    const res = settings.updateSettings(merchantId, { shadowMode: true });
    expect(res.ok && res.view.shadowMode).toBe(true);
    if (res.ok) expect(res.recomputed).toBe(0);
  });

  it('索赔详情不含判定、信号、演示场景说明；动作选项是中性的，不附报告和自动证据', async () => {
    const d = claimByScenario('ai_watermark');
    const v = (await views.claimView(d.claim.id))!;
    expect(v.shadow).toBe(true);
    expect(v.verdict?.id).toBe(d.verdict!.id);
    expect(v.verdict?.report).toBeNull();
    expect(v.signals).toEqual([]);
    expect(v.claim.scenario).toBeNull();
    expect(v.followUps).toEqual([]);
    expect(v.paypal.attachments).toBe(0);
    expect(v.paypal.reportAvailable).toBe(false);
    expect(v.actionOptions.length).toBeGreaterThan(1);
    for (const o of v.actionOptions) {
      expect(o.reason).toContain('影子模式');
      expect(o.attachReport).toBeFalsy();
      expect(o.attachEvidence).toBeFalsy();
    }
    // 只列 PayPal 允许的动作。
    expect(v.actionOptions.every((o) => o.type !== 'none' && v.allowedActions.includes(o.type))).toBe(true);
    // 序列化后的视图里不能出现判定的痕迹。
    const text = JSON.stringify(v);
    for (const leak of ['AI_PROVENANCE_FOUND', '高风险', 'contradicts_claim', 'primaryAction']) expect(text).not.toContain(leak);
  });

  it('列表不显示等级、分数和演示场景标题', () => {
    const { claims, shadow: on } = shadow.maskClaimList(merchantId, repo.listClaims());
    expect(on).toBe(true);
    expect(claims.every((c) => c.level === null && c.score === null && c.scenarioTitle === null)).toBe(true);
  });

  it('影子模式下动作即使要求附报告和证据也不附，动作记录标为影子模式', async () => {
    const d = claimByScenario('ai_watermark');
    const res = await act(d, 'accept_claim', { notes: '接受买家索赔。', attachReport: true, attachEvidence: true });
    expect(res.status).toBe(200);
    const row = db.db().prepare('SELECT shadow, payload FROM actions WHERE claim_id = ?').get(d.claim.id) as { shadow: number; payload: string };
    expect(row.shadow).toBe(1);
    expect(JSON.parse(row.payload)).toMatchObject({ attachReport: false, attachEvidence: false });
  });

  it('对照：高风险判定建议反驳、人工接受索赔，记为方向相反；建议补证、人工发消息，记为一致', async () => {
    const d = claimByScenario('narrative_conflict');
    const suggested = (JSON.parse(repo.latestVerdict(d.claim.id)!.report) as import('@/core/types').VerdictReport).primaryAction.type;
    expect(suggested).toBe('send_message');
    expect((await act(d, 'send_message', { message: '您好，请补充现场照片。' })).status).toBe(200);

    const c = shadow.shadowComparison(merchantId);
    expect(c.shadowMode).toBe(true);
    expect(c.blindOnly).toBe(true);
    expect(c.blindDecided).toBe(2);
    const byOrder = new Map(c.rows.map((r) => [r.claimId, r]));
    const opposite = byOrder.get(claimByScenario('ai_watermark').claim.id)!;
    expect(opposite).toMatchObject({ level: 'high', system: 'contest', merchant: 'refund', agree: false, opposite: true, shadow: true });
    expect(byOrder.get(d.claim.id)).toMatchObject({ system: 'ask', merchant: 'ask', agree: true, opposite: false });
    expect(c.agree).toBe(1);
    expect(c.agreementRate).toBe(0.5);
    expect(c.opposite).toBe(1);
    expect(c.matrix.high.refund).toBe(1);
    expect(c.byLevel.find((l) => l.level === 'high')).toMatchObject({ total: 1, agree: 0 });
  });

  it('一笔索赔先发消息、后反驳时，取反驳作为决定', async () => {
    const d = claimByScenario('narrative_conflict');
    // 简化：直接补一条成功的反驳动作记录，验证取数规则（模拟器里私下请求不能反驳）。
    db.db()
      .prepare(
        `INSERT INTO actions (id, claim_id, verdict_id, type, payload, confirmed_by, confirmed_at, status, shadow)
         VALUES (?, ?, ?, 'escalate', '{}', 'demo-owner', ?, 'succeeded', 1)`,
      )
      .run(crypto.randomUUID(), d.claim.id, d.verdict!.id, new Date(Date.now() + 60_000).toISOString());
    const row = shadow.shadowComparison(merchantId).rows.find((r) => r.claimId === d.claim.id)!;
    expect(row.merchant).toBe('contest');
    expect(row.actionType).toBe('escalate');
  });

  it('关闭后判定重新显示；影子模式外的决定只在“统计全部”时计入', async () => {
    settings.updateSettings(merchantId, { shadowMode: false });
    const d = claimByScenario('cross_contradiction');
    const v = (await views.claimView(d.claim.id))!;
    expect(v.shadow).toBe(false);
    expect(v.verdict?.report?.level).toBeDefined();
    expect(v.actionOptions[0]).toEqual(v.verdict!.report!.primaryAction);

    expect((await act(d, 'send_message', { message: '您好，请补充照片。' })).status).toBe(200);
    const blind = shadow.shadowComparison(merchantId);
    expect(blind.rows.some((r) => r.claimId === d.claim.id)).toBe(false);
    expect(blind.totalDecided).toBe(3);
    const all = shadow.shadowComparison(merchantId, { blindOnly: false });
    expect(all.rows.find((r) => r.claimId === d.claim.id)?.shadow).toBe(false);
  });
});
