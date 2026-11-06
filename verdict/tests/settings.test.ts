// 商家设置：校验、保存、保存后重新判定未结案索赔、已结案的判定保持不变。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-settings-test-'));
process.env.VERDICT_DATA_DIR = dir;
delete process.env.LLM_API_KEY;
delete process.env.LLM_PROVIDER;

let repo: typeof import('@/server/repo');
let settings: typeof import('@/server/settings');
let db: typeof import('@/server/db');
let merchantId: string;

beforeAll(async () => {
  const { seedDemo } = await import('@/demo/seed');
  repo = await import('@/server/repo');
  settings = await import('@/server/settings');
  db = await import('@/server/db');
  await seedDemo();
  merchantId = repo.defaultMerchantId()!;
}, 120000);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function engine(over: Partial<import('@/server/settings').EngineSettings> = {}): import('@/server/settings').EngineSettings {
  return { ...settings.settingsView(merchantId).defaults, ...over };
}

function latestByClaim(): Map<string, { id: string; level: string; status: string }> {
  const rows = db.db().prepare('SELECT id, status FROM claims').all() as unknown as { id: string; status: string }[];
  // 历史场景的索赔只用于复用检测和行为统计，没有判定。
  return new Map(
    rows.flatMap((r) => {
      const v = repo.latestVerdict(r.id);
      return v ? [[r.id, { id: v.id, level: v.level, status: r.status }] as const] : [];
    }),
  );
}

describe('设置校验', () => {
  it('默认没有自定义，类目来自种子数据，退货地址为空', () => {
    const v = settings.settingsView(merchantId);
    expect(v.customized).toBe(false);
    expect(v.engine).toEqual(v.defaults);
    expect(v.policies.map((p) => p.category)).toEqual(expect.arrayContaining(['apparel', 'ceramics', 'electronics', 'fresh']));
    expect(v.returnAddress).toBeNull();
    expect(v.retentionDays).toBeNull();
  });

  it.each([
    ['高风险阈值不大于中风险阈值', { riskMedium: 2, riskHigh: 2 }, '高风险阈值要大于中风险阈值'],
    ['强度顺序颠倒', { strengthWeight: { strong: 1, moderate: 2, weak: 0.5 } }, '强 ≥ 中 ≥ 弱'],
    ['低层证据比高层更可信', { layerWeight: { ab: 0.5, cPaypal: 0.8, cUploaded: 0.4, d: 0.3 } }, 'A、B ≥ C ≥ D'],
    ['层级权重超过 1', { layerWeight: { ab: 1.5, cPaypal: 0.8, cUploaded: 0.6, d: 0.3 } }, '0 到 1'],
    ['Q 阈值为 0', { minDataConfidence: 0 }, '不能等于 0'],
    ['不是数字', { riskMedium: null as unknown as number }, '中风险阈值'],
  ])('%s时拒绝，设置不变', (_name, over, message) => {
    const res = settings.updateSettings(merchantId, { engine: engine(over as never) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(message);
    expect(settings.settingsView(merchantId).customized).toBe(false);
  });

  it('退货地址缺城市、国家代码不是两位字母、美国地址缺州时拒绝', () => {
    const base = { line1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '73301', countryCode: 'US' };
    for (const [bad, msg] of [
      [{ ...base, city: ' ' }, '城市'],
      [{ ...base, countryCode: 'USA' }, '国家代码'],
      [{ ...base, state: '' }, '州/省'],
    ] as const) {
      const res = settings.updateSettings(merchantId, { returnAddress: bad });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain(msg);
    }
  });

  it('保留天数必须是 1 到 3650 的整数', () => {
    for (const bad of [0, 1.5, 4000]) {
      expect(settings.updateSettings(merchantId, { retentionDays: bad }).ok).toBe(false);
    }
  });
});

describe('保存设置', () => {
  it('退货地址保存后用于和解，清空后回到演示地址', () => {
    const address = { line1: '88 Harbor Rd', line2: '', city: 'Oakland', state: 'CA', postalCode: '94607', countryCode: 'us' };
    const res = settings.updateSettings(merchantId, { returnAddress: address });
    expect(res.ok).toBe(true);
    expect(repo.merchantReturnAddress(merchantId)).toEqual({ line1: '88 Harbor Rd', city: 'Oakland', state: 'CA', postalCode: '94607', countryCode: 'US' });
    // 地址不影响判定，不触发重新判定。
    if (res.ok) expect(res.recomputed).toBe(0);
    settings.updateSettings(merchantId, { returnAddress: null });
    expect(repo.merchantReturnAddress(merchantId)).toEqual(repo.DEMO_RETURN_ADDRESS);
  });

  it('改权重后未结案的索赔重新判定，已结案的判定不变；恢复默认后等级回到原样', () => {
    const before = latestByClaim();
    const res = settings.updateSettings(merchantId, { engine: engine({ riskMedium: 0.2, riskHigh: 0.4 }) });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.view.customized).toBe(true);
    const open = db.db().prepare("SELECT COUNT(*) AS n FROM claims WHERE status != 'closed'").get() as { n: number };
    expect(res.recomputed).toBe(open.n);
    expect(res.changed.length).toBeGreaterThan(0);

    const after = latestByClaim();
    for (const [id, b] of before) {
      const a = after.get(id)!;
      if (b.status === 'closed') expect(a.id).toBe(b.id);
    }
    // 审计记录里能看到这次判定用的配置。
    const changedClaim = res.changed[0].claimId;
    const report = JSON.parse(repo.latestVerdict(changedClaim)!.report);
    expect(report.config.riskHigh).toBe(0.4);
    expect(repo.claimTimeline(changedClaim).some((t) => t.title === '判定设置修改后重新判定')).toBe(true);

    const reset = settings.updateSettings(merchantId, { engine: null });
    expect(reset.ok && reset.view.customized).toBe(false);
    const restored = latestByClaim();
    for (const [id, b] of before) expect(restored.get(id)!.level).toBe(b.level);
  });

  it('类目策略只改四个开关，保留必需镜头配置；新类目可以保存', () => {
    const fresh = repo.getPolicy(merchantId, 'fresh');
    expect(fresh.requiredShots?.damaged).toBeDefined();
    const res = settings.updateSettings(merchantId, {
      policies: [
        { category: 'fresh', returnable: false, perishable: true, safetySensitive: false, identityRequired: false },
        { category: 'books', returnable: true, perishable: false, safetySensitive: false, identityRequired: false },
      ],
    });
    expect(res.ok).toBe(true);
    const updated = repo.getPolicy(merchantId, 'fresh');
    expect(updated.safetySensitive).toBe(false);
    expect(updated.requiredShots).toEqual(fresh.requiredShots);
    expect(settings.settingsView(merchantId).policies.some((p) => p.category === 'books')).toBe(true);
    // 恢复，免得影响后面的断言。
    settings.updateSettings(merchantId, { policies: [{ category: 'fresh', returnable: false, perishable: true, safetySensitive: true, identityRequired: false }] });
  });

  it('类目名称无效时拒绝', () => {
    const res = settings.updateSettings(merchantId, {
      policies: [{ category: '../x', returnable: true, perishable: false, safetySensitive: false, identityRequired: false }],
    });
    expect(res.ok).toBe(false);
  });

  it('设置没有实质变化时不重新判定', () => {
    const res = settings.updateSettings(merchantId, { engine: engine() });
    expect(res.ok && res.recomputed).toBe(0);
  });
});
