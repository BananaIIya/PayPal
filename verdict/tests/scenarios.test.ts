// 端到端：跑一遍真实管线生成 18 个演示场景，逐个核对开发文档的期望判定。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VerdictReport } from '@/core/types';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-test-'));
process.env.VERDICT_DATA_DIR = dir;
delete process.env.LLM_API_KEY;
delete process.env.LLM_PROVIDER;

type Repo = typeof import('@/server/repo');
let repo: Repo;
const byKey = new Map<string, { id: string; report: VerdictReport; codes: string[] }>();

beforeAll(async () => {
  const { seedDemo } = await import('@/demo/seed');
  repo = await import('@/server/repo');
  await seedDemo();
  for (const item of repo.listClaims()) {
    const d = repo.claimDetail(item.id)!;
    byKey.set(d.claim.scenario!.key, {
      id: item.id,
      report: d.verdict!.report,
      codes: d.verdict!.report.findings.map((f) => f.code),
    });
  }
}, 120000);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const expectations: [string, string, string[], string[]][] = [
  // 场景、期望判定、必须出现的信号、不能出现的信号
  ['genuine_damage', 'low', ['IDENTITY_MATCH'], ['AI_PROVENANCE_FOUND', 'EVIDENCE_REUSED_ACROSS_CLAIMS']],
  ['ai_watermark', 'high', ['AI_PROVENANCE_FOUND'], []],
  ['reused_image', 'high', ['EVIDENCE_REUSED_ACROSS_CLAIMS'], ['AI_PROVENANCE_FOUND']],
  ['identity_mismatch', 'high', ['IDENTITY_MISMATCH'], ['EVIDENCE_REUSED_ACROSS_CLAIMS']],
  ['cross_contradiction', 'high', ['CROSS_EVIDENCE_CONTRADICTION'], []],
  ['fake_chat', 'high', ['SCREENSHOT_CONTENT_MISMATCH'], []],
  ['synthetic_no_watermark', 'medium', ['SYNTHETIC_LIKELY', 'NO_PROVENANCE'], ['AI_PROVENANCE_FOUND']],
  ['narrative_conflict', 'medium', ['NARRATIVE_EVIDENCE_CONFLICT'], []],
  ['screen_recapture', 'medium', ['SCREEN_RECAPTURE'], []],
  ['delivered_not_received', 'medium', ['DELIVERED_CONFIRMED'], []],
  ['partial_missing', 'medium', ['WEIGHT_MISMATCH'], []],
  ['insufficient', 'insufficient', [], []],
  ['seller_bad_tracking', 'low', ['DELIVERY_ADDRESS_MISMATCH'], ['DELIVERED_CONFIRMED']],
  ['batch_quality', 'low', ['IDENTITY_MATCH'], ['SKU_CLAIM_CLUSTER']],
  ['listing_changed', 'low', ['SNAPSHOT_DIFFERENCE'], []],
  ['perishable', 'low', [], []],
  ['prompt_injection', 'low', ['IDENTITY_MATCH'], []],
  ['detectors_down', 'insufficient', ['NO_PROVENANCE'], ['IDENTITY_MATCH']],
];

describe('验收场景', () => {
  it('18 个场景都生成了判定', () => {
    expect(byKey.size).toBe(18);
  });

  it.each(expectations)('%s → %s', (key, level, mustHave, mustNot) => {
    const s = byKey.get(key)!;
    expect(s, key).toBeDefined();
    expect(s.report.level, `${key}: ${s.report.ruleTrace.join(' | ')}`).toBe(level);
    for (const code of mustHave) expect(s.codes, key).toContain(code);
    for (const code of mustNot) expect(s.codes, key).not.toContain(code);
  });

  it('没有场景被误判为图片复用（感知哈希不误报）', () => {
    for (const [key, s] of byKey) {
      if (key === 'reused_image') continue;
      expect(s.codes, key).not.toContain('EVIDENCE_REUSED_ACROSS_CLAIMS');
    }
  });

  it('带 AI 标识时列出正常解释，并给出“请买家提供原图”的备选动作', () => {
    const r = byKey.get('ai_watermark')!.report;
    const finding = r.findings.find((f) => f.code === 'AI_PROVENANCE_FOUND')!;
    expect(finding.normalExplanations.join()).toContain('圈出了瑕疵');
    expect(r.alternatives.map((a) => a.label)).toContain('请买家提供原图');
  });

  it('已签收的未收到货争议建议提交物流证据', () => {
    const a = byKey.get('delivered_not_received')!.report.primaryAction;
    expect(a.type).toBe('provide_evidence');
    expect(a.evidenceType).toBe('PROOF_OF_FULFILLMENT');
    expect(a.trackingNumber).toBeTruthy();
  });

  it('卖家单号不符时提示商家，不代为提交', () => {
    const r = byKey.get('seller_bad_tracking')!.report;
    expect(r.notices.join()).toContain('物流证据不足');
    expect([r.primaryAction, ...r.alternatives].map((a) => a.type)).not.toContain('provide_evidence');
  });

  it('少件场景建议部分退款和解', () => {
    expect(byKey.get('partial_missing')!.report.primaryAction.type).toBe('make_offer');
  });

  it('证据不足场景一次性列出缺失镜头', () => {
    const r = byKey.get('insufficient')!.report;
    expect(r.missingShots).toEqual(['overall', 'package', 'label']);
  });

  it('同批次质量问题：M 高且附质量提示', () => {
    const r = byKey.get('batch_quality')!.report;
    expect(r.merchantRisk).toBeGreaterThanOrEqual(0.5);
    expect(r.qualityNotice).toBe(true);
  });

  it('详情页被修改：M 上升并提示按快照判定', () => {
    const r = byKey.get('listing_changed')!.report;
    expect(r.merchantRisk).toBeGreaterThan(0);
    expect(r.notices.join()).toContain('下单时的商品快照');
  });

  it('易腐商品不要求退货，且先提示安全事件', () => {
    const r = byKey.get('perishable')!.report;
    expect(r.notices[0]).toContain('安全事件');
    expect(r.notices.join()).toContain('不要求退货');
  });

  it('提示注入：判定与不含注入文字的同类场景一致', () => {
    const injected = byKey.get('prompt_injection')!.report;
    const clean = byKey.get('genuine_damage')!.report;
    expect(injected.level).toBe(clean.level);
    expect(injected.score).toBe(clean.score);
    expect(injected.dataConfidence).toBe(clean.dataConfidence);
    expect(injected.findings.map((f) => f.code).sort()).toEqual(clean.findings.map((f) => f.code).sort());
    expect(injected.primaryAction.type).toBe(clean.primaryAction.type);
  });

  it('检测服务不可用：标记核验不完整并列出未执行项', () => {
    const r = byKey.get('detectors_down')!.report;
    expect(r.incomplete).toBe(true);
    const missing = r.notRun.map((x) => x.analyzer);
    expect(missing).toEqual(expect.arrayContaining(['synthetic', 'consistency', 'plausibility', 'reference']));
    expect(r.primaryAction.type).toBe('none');
  });

  it('真实损坏场景所有适用的分析器都完成', () => {
    expect(byKey.get('genuine_damage')!.report.notRun).toEqual([]);
  });
});
