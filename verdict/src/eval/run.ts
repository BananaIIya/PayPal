// 跑一遍评估：原样跑一次，每种形式变换再各跑一次，收集判定并计算指标。
// 调用方负责先把 VERDICT_DATA_DIR 指到一个临时目录，这里会清空其中的业务数据。
import { DEFAULT_CONFIG } from '@/core/catalog';
import type { VerdictReport } from '@/core/types';
import { claimEvidence, claimRuns, claimSignals, latestVerdict } from '@/server/repo';
import type { Dataset, DatasetSample } from './dataset';
import { demoDataset } from './demo-dataset';
import { manifestDataset } from './manifest-dataset';
import { LABELS, robustness, summarize, type Label, type SampleOutcome, type Summary, type Thresholds } from './metrics';
import { findLeaks, SPLITS, type Split } from './splits';
import { transform, TRANSFORM_TEXT, type TransformName } from './transforms';

export interface EvalOptions {
  /** manifest.json 的路径；不填用内置验收场景。 */
  dataset?: string;
  transforms: TransformName[];
  live: boolean;
  onProgress?: (message: string) => void;
}

export type SampleResult = SampleOutcome & { split: Split; note?: string };

export interface RobustnessResult extends ReturnType<typeof robustness> {
  transform: TransformName;
  text: string;
}

export interface EvalResult {
  dataset: { name: string; source: string; n: number; byLabel: Record<Label, number>; bySplit: Record<Split, number> };
  mode: 'offline' | 'live';
  thresholds: Thresholds;
  startedAt: string;
  durationMs: number;
  leaks: { ids: string[]; splits: Split[] }[];
  summaries: { all: Summary } & Partial<Record<Split, Summary>>;
  robustness: RobustnessResult[];
  samples: SampleResult[];
  notes: string[];
}

function outcome(sample: DatasetSample, claimId: string, analysisMs: number): SampleOutcome {
  const verdict = latestVerdict(claimId);
  if (!verdict) throw new Error(`样本 ${sample.id} 没有生成判定`);
  const report = JSON.parse(verdict.report) as VerdictReport;
  const signals = claimSignals(claimId);
  return {
    id: sample.id,
    label: sample.label,
    level: report.level,
    score: report.score,
    incomplete: report.incomplete,
    flagged: [...new Set(signals.filter((s) => s.direction === 'contradicts_claim').map((s) => s.analyzer))],
    ran: claimRuns(claimId)
      .filter((r) => r.status === 'done')
      .map((r) => r.analyzer),
    codes: [...new Set(signals.map((s) => s.code))].sort(),
    hasEvidence: claimEvidence(claimId).some((e) => e.kind !== 'frame'),
    analysisMs,
  };
}

async function runOnce(dataset: Dataset, live: boolean, name?: TransformName): Promise<SampleOutcome[]> {
  const claims = await dataset.run({ live, transform: name ? transform(name) : undefined });
  return dataset.samples.map((s) => {
    const c = claims.get(s.id);
    if (!c) throw new Error(`样本 ${s.id} 没有导入`);
    return outcome(s, c.claimId, c.analysisMs);
  });
}

export async function loadDataset(manifest?: string): Promise<Dataset> {
  return manifest ? manifestDataset(manifest) : demoDataset();
}

export async function runEvaluation(opts: EvalOptions): Promise<EvalResult> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const log = opts.onProgress ?? (() => undefined);
  const dataset = await loadDataset(opts.dataset);

  log(`原样跑 ${dataset.samples.length} 个样本…`);
  const base = await runOnce(dataset, opts.live);
  const robust: RobustnessResult[] = [];
  for (const name of opts.transforms) {
    log(`变换：${TRANSFORM_TEXT[name]}…`);
    robust.push({ transform: name, text: TRANSFORM_TEXT[name], ...robustness(base, await runOnce(dataset, opts.live, name)) });
  }

  const meta = new Map(dataset.samples.map((s) => [s.id, s]));
  const samples: SampleResult[] = base.map((o) => ({ ...o, split: meta.get(o.id)!.split, note: meta.get(o.id)!.note }));
  // 评估库里的商家没有自定义配置，判定用的就是默认阈值。
  const thresholds: Thresholds = { medium: DEFAULT_CONFIG.riskMedium, high: DEFAULT_CONFIG.riskHigh };
  const summaries: EvalResult['summaries'] = { all: summarize(base, thresholds) };
  const present = SPLITS.filter((sp) => samples.some((s) => s.split === sp));
  if (present.length > 1) for (const sp of present) summaries[sp] = summarize(samples.filter((s) => s.split === sp), thresholds);

  const notes = [...dataset.notes];
  if (!opts.live) {
    notes.push(
      '离线模式：LLM 和检测器不会被调用，只用录制回放和本地分析器（Provenance、Origin、Logistics、Records、Behavior 等）。没有录制结果的图片，依赖模型的分析器会标为未执行。',
    );
    if (dataset.source === 'demo' && opts.transforms.length) {
      notes.push('内置样本做形式变换时，录制回放按变换后的文件重新登记（假设模型对同样内容给出同样结果），所以一致率反映的是本地分析器和判定规则的稳健性，不是模型本身。');
    }
  }
  if (samples.length < 30) notes.push(`样本只有 ${samples.length} 个，比例类指标波动很大，适合发现回归，不适合下结论。`);

  return {
    dataset: {
      name: dataset.name,
      source: dataset.source,
      n: samples.length,
      byLabel: Object.fromEntries(LABELS.map((l) => [l, samples.filter((s) => s.label === l).length])) as Record<Label, number>,
      bySplit: Object.fromEntries(SPLITS.map((sp) => [sp, samples.filter((s) => s.split === sp).length])) as Record<Split, number>,
    },
    mode: opts.live ? 'live' : 'offline',
    thresholds,
    startedAt,
    durationMs: performance.now() - started,
    leaks: findLeaks(dataset.samples),
    summaries,
    robustness: robust,
    samples,
    notes,
  };
}
