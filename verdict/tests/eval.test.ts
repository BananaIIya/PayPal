// 评估集：指标计算、样本隔离、外部 manifest 导入，以及在内置场景上跑一遍。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  averagePrecision,
  binaryStats,
  calibration,
  legitFalsePositives,
  percentile,
  robustness,
  type SampleOutcome,
} from '@/eval/metrics';
import { assignSplits, findLeaks, groupComponents } from '@/eval/splits';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-eval-test-'));
process.env.VERDICT_DATA_DIR = path.join(dir, 'data');
delete process.env.LLM_API_KEY;
delete process.env.LLM_PROVIDER;

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function sample(over: Partial<SampleOutcome> & Pick<SampleOutcome, 'id' | 'label' | 'level'>): SampleOutcome {
  return { score: 0, incomplete: false, flagged: [], ran: [], codes: [], hasEvidence: true, analysisMs: 1, ...over };
}

describe('指标', () => {
  it('精确率和召回率；没有分母时是 null 而不是 0', () => {
    const s = binaryStats([
      { actual: true, predicted: true },
      { actual: false, predicted: true },
      { actual: true, predicted: false },
      { actual: false, predicted: false },
    ]);
    expect(s).toMatchObject({ tp: 1, fp: 1, fn: 1, tn: 1, precision: 0.5, recall: 0.5 });
    expect(binaryStats([{ actual: false, predicted: false }])).toMatchObject({ precision: null, recall: null });
  });

  it('PR-AUC 按平均精确率计算，同分的样本一起计入', () => {
    // 正、负、正、负：AP = 1×0.5 + (2/3)×0.5
    expect(
      averagePrecision([
        { score: 0.9, positive: true },
        { score: 0.8, positive: false },
        { score: 0.7, positive: true },
        { score: 0.6, positive: false },
      ]),
    ).toBeCloseTo(5 / 6);
    // 一正一负同分：只有一个阈值，精确率 0.5，和排序先后无关。
    const tie = [
      { score: 1, positive: false },
      { score: 1, positive: true },
    ];
    expect(averagePrecision(tie)).toBeCloseTo(0.5);
    expect(averagePrecision([...tie].reverse())).toBeCloseTo(0.5);
    expect(averagePrecision([{ score: 1, positive: false }])).toBeNull();
  });

  it('首要指标只把中、高风险算作误判，证据不足不算', () => {
    const fp = legitFalsePositives([
      sample({ id: 'a', label: 'legit', level: 'low' }),
      sample({ id: 'b', label: 'legit', level: 'insufficient' }),
      sample({ id: 'c', label: 'legit', level: 'medium' }),
      sample({ id: 'd', label: 'legit', level: 'high' }),
      sample({ id: 'e', label: 'confirmed_abuse', level: 'high' }),
    ]);
    expect(fp).toEqual({ total: 4, count: 2, rate: 0.5, ids: ['c', 'd'] });
  });

  it('校准按判定阈值分档，边界值落在上一档', () => {
    const bins = calibration(
      [
        sample({ id: 'a', label: 'legit', level: 'low', score: -2 }),
        sample({ id: 'b', label: 'suspicious', level: 'low', score: 0 }),
        sample({ id: 'c', label: 'confirmed_abuse', level: 'medium', score: 1 }),
        sample({ id: 'd', label: 'legit', level: 'medium', score: 2.5 }),
        sample({ id: 'e', label: 'confirmed_abuse', level: 'high', score: 3 }),
      ],
      { medium: 1, high: 3 },
    );
    expect(bins.map((b) => b.n)).toEqual([1, 1, 2, 1]);
    expect(bins[0]).toMatchObject({ lo: null, hi: 0, abuseRate: 0 });
    expect(bins[2]).toMatchObject({ lo: 1, hi: 3, abuseRate: 0.5, abnormalRate: 0.5, meanScore: 1.75 });
    expect(bins[3]).toMatchObject({ lo: 3, hi: null, abuseRate: 1 });
  });

  it('稳健性只比较有图片的样本，并列出消失和新出现的信号', () => {
    const base = [
      sample({ id: 'a', label: 'suspicious', level: 'high', codes: ['AI_PROVENANCE_FOUND', 'NO_EXIF'] }),
      sample({ id: 'b', label: 'legit', level: 'low' }),
      sample({ id: 'c', label: 'suspicious', level: 'medium', hasEvidence: false }),
    ];
    const variant = [
      sample({ id: 'a', label: 'suspicious', level: 'insufficient', codes: ['NO_EXIF', 'NO_PROVENANCE'] }),
      sample({ id: 'b', label: 'legit', level: 'low' }),
      sample({ id: 'c', label: 'suspicious', level: 'low', hasEvidence: false }),
    ];
    const r = robustness(base, variant);
    expect(r).toMatchObject({ applicable: 2, agree: 1, rate: 0.5 });
    expect(r.changes).toEqual([{ id: 'a', from: 'high', to: 'insufficient', lost: ['AI_PROVENANCE_FOUND'], gained: ['NO_PROVENANCE'] }]);
  });

  it('分位数', () => {
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
    expect(percentile([5, 1, 4, 2, 3], 95)).toBe(5);
    expect(percentile([], 50)).toBeNull();
  });
});

describe('样本隔离', () => {
  const samples = [
    { id: 'a', groups: { images: ['img1'], buyer: 'b1', sku: 's1' } },
    { id: 'b', groups: { images: ['img2'], buyer: 'b1', sku: 's2' } }, // 和 a 同一买家
    { id: 'c', groups: { images: ['img3'], buyer: 'b3', sku: 's2' } }, // 和 b 同一 SKU，于是和 a 也连上
    { id: 'd', groups: { images: ['img1'], buyer: 'b4', sku: 's4' } }, // 和 a 同一张图
    { id: 'e', groups: { images: ['img5'], buyer: 'b5', sku: 's5' } },
  ];

  it('共享图片、买家或 SKU 的样本连成一组，可以传递', () => {
    expect(groupComponents(samples)).toEqual([['a', 'b', 'c', 'd'], ['e']]);
  });

  it('同组样本分到不同集合时报告泄漏', () => {
    const leaks = findLeaks(samples.map((s) => ({ ...s, split: s.id === 'c' ? ('test' as const) : ('tune' as const) })));
    expect(leaks).toEqual([{ ids: ['a', 'b', 'c', 'd'], splits: ['test', 'tune'] }]);
    expect(findLeaks(samples.map((s) => ({ ...s, split: s.id === 'e' ? ('test' as const) : ('tune' as const) })))).toEqual([]);
  });

  it('自动分配整组同去同留，结果和样本顺序无关', () => {
    const a = assignSplits(samples);
    const b = assignSplits([...samples].reverse());
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
    expect(new Set(['a', 'b', 'c', 'd'].map((id) => a.get(id))).size).toBe(1);
  });
});

describe('跑评估', () => {
  let run: typeof import('@/eval/run');
  let report: typeof import('@/eval/report');
  let manifest: typeof import('@/eval/manifest-dataset');

  beforeAll(async () => {
    run = await import('@/eval/run');
    report = await import('@/eval/report');
    manifest = await import('@/eval/manifest-dataset');
  });

  it('内置场景：误判率、已确认滥用的指标、压缩后 C2PA 丢失', async () => {
    const r = await run.runEvaluation({ transforms: ['recompress'], live: false });
    expect(r.dataset.n).toBe(18);
    expect(r.leaks).toEqual([]);
    const s = r.summaries.all;
    expect(s.legitFalsePositives).toMatchObject({ total: 7, count: 0 });
    // 三个已确认滥用都判了高风险；另有两个疑似异常也判了高风险。
    expect(s.abuse).toMatchObject({ tp: 3, fn: 0, fp: 2, recall: 1, precision: 0.6 });
    expect(s.confusion.legit.insufficient).toBe(1); // 检测服务不可用的那笔
    // 重新压缩会去掉图片里的 C2PA 清单：这是形式变化下唯一改变判定的样本。
    const t = r.robustness[0];
    expect(t.applicable).toBe(16);
    expect(t.changes.map((c) => c.id)).toEqual(['ai_watermark']);
    expect(t.changes[0].lost).toContain('AI_PROVENANCE_FOUND');

    const md = report.renderReport(r);
    expect(md).toContain('合法售后被判为中、高风险的比例');
    expect(md).toContain('| 重新压缩（JPEG 质量 55） | 16 | 15 | 93.8% |');
  });

  it('外部 manifest：导入订单和证据、近似图归为同组并报告泄漏、跨订单套图被检出', async () => {
    const { renderScene, recompress } = await import('@/demo/images');
    const data = path.join(dir, 'dataset');
    fs.mkdirSync(path.join(data, 'img'), { recursive: true });
    const original = await renderScene({ kind: 'mug', seed: 9001, crack: true });
    fs.writeFileSync(path.join(data, 'img/a.jpg'), original);
    fs.writeFileSync(path.join(data, 'img/b.jpg'), await recompress(original));
    fs.writeFileSync(path.join(data, 'img/c.jpg'), await renderScene({ kind: 'box', seed: 9002, open: true }));
    const order = (sku: string) => ({ category: 'ceramics', amount: 40, items: [{ sku, title: '测试杯', quantity: 1 }] });
    const file = path.join(data, 'manifest.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        name: '小样本',
        samples: [
          { id: 'orig', label: 'legit', split: 'test', claim: { type: 'damaged', narrative: '杯子裂了' }, order: order('A'), evidence: [{ file: 'img/a.jpg', shot: 'overall' }] },
          { id: 'copy', label: 'confirmed_abuse', split: 'tune', claim: { type: 'damaged' }, order: order('B'), evidence: [{ file: 'img/b.jpg', shot: 'overall' }] },
          { id: 'other', label: 'insufficient', claim: { type: 'damaged' }, order: order('C'), evidence: [{ file: 'img/c.jpg', shot: 'package' }] },
        ],
      }),
    );

    const r = await run.runEvaluation({ dataset: file, transforms: [], live: false });
    expect(r.dataset).toMatchObject({ name: '小样本', n: 3 });
    expect(r.leaks).toEqual([{ ids: ['copy', 'orig'], splits: ['test', 'tune'] }]);
    const copy = r.samples.find((s) => s.id === 'copy')!;
    expect(copy.codes).toContain('EVIDENCE_REUSED_ACROSS_CLAIMS');
    expect(copy.flagged).toContain('origin');
    // 没有录制结果、也不调用模型：依赖模型的分析器没跑。
    expect(r.samples.find((s) => s.id === 'orig')!.ran).not.toContain('consistency');
    // 两个集合都有样本时分别统计。
    expect(r.summaries.tune?.n).toBeGreaterThan(0);
    expect(r.summaries.test?.n).toBeGreaterThan(0);
    expect(report.renderReport(r)).toContain('有样本泄漏');
  });

  it('manifest 写错时指出是哪个样本、哪个字段', () => {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, JSON.stringify({ samples: [{ id: 'x1', label: 'fraud', claim: { type: 'damaged' }, order: {} }] }));
    expect(() => manifest.parseManifest(file)).toThrow(/样本 x1.*label/);
    fs.writeFileSync(file, JSON.stringify({ samples: [{ id: 'x2', label: 'legit', claim: { type: 'damaged' }, order: { category: 'ceramics', amount: 1, items: [{ sku: 'A', title: 't' }] }, evidence: [{ file: 'nope.jpg' }] }] }));
    expect(() => manifest.parseManifest(file)).toThrow(/样本 x2.*找不到文件 nope\.jpg/);
  });
});
