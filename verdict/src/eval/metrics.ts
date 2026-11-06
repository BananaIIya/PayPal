// 评估指标（开发文档“标注与指标”）。这里只做计算，不读库，不碰文件。
import { ANALYZERS, type AnalyzerName, type VerdictLevel } from '@/core/types';

/** 标注四类。只有存在可核实的反证或当事人承认时才标“已确认滥用”。 */
export const LABELS = ['legit', 'insufficient', 'suspicious', 'confirmed_abuse'] as const;
export type Label = (typeof LABELS)[number];
export const LABEL_TEXT: Record<Label, string> = {
  legit: '合法售后',
  insufficient: '证据不足',
  suspicious: '疑似异常',
  confirmed_abuse: '已确认滥用',
};

export const LEVELS: VerdictLevel[] = ['high', 'medium', 'low', 'insufficient'];

/** 一个样本跑完管线后的结果。 */
export interface SampleOutcome {
  id: string;
  label: Label;
  level: VerdictLevel;
  /** 买家侧风险 R。 */
  score: number;
  incomplete: boolean;
  /** 给出了“与索赔矛盾”信号的分析器。 */
  flagged: AnalyzerName[];
  /** 正常跑完的分析器。 */
  ran: AnalyzerName[];
  codes: string[];
  /** 有买家提交的图片或视频。形式变换只对这类样本有意义。 */
  hasEvidence: boolean;
  analysisMs: number;
}

export const ratio = (n: number, d: number): number | null => (d > 0 ? n / d : null);

const abnormal = (l: Label) => l === 'suspicious' || l === 'confirmed_abuse';

export interface BinaryStats {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
}

export function binaryStats(pairs: { actual: boolean; predicted: boolean }[]): BinaryStats {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const p of pairs) {
    if (p.predicted && p.actual) tp++;
    else if (p.predicted) fp++;
    else if (p.actual) fn++;
    else tn++;
  }
  return { tp, fp, fn, tn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn) };
}

/**
 * PR 曲线下面积，按平均精确率（AP）计算：分数从高到低，每个不同的分数取一次阈值，
 * 召回率每上升一段，乘上该阈值处的精确率。同分的样本一起计入，不因排序先后得分。
 */
export function averagePrecision(items: { score: number; positive: boolean }[]): number | null {
  const positives = items.filter((i) => i.positive).length;
  if (!positives) return null;
  const sorted = [...items].sort((a, b) => b.score - a.score);
  let tp = 0;
  let fp = 0;
  let prevRecall = 0;
  let ap = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j < sorted.length && sorted[j].score === sorted[i].score) {
      if (sorted[j].positive) tp++;
      else fp++;
      j++;
    }
    const recall = tp / positives;
    ap += (recall - prevRecall) * (tp / (tp + fp));
    prevRecall = recall;
    i = j;
  }
  return ap;
}

/** 开发文档的首要指标：合法售后被判为中、高风险的比例。判“证据不足”不算误判。 */
export function legitFalsePositives(samples: SampleOutcome[]) {
  const legit = samples.filter((s) => s.label === 'legit');
  const wrong = legit.filter((s) => s.level === 'high' || s.level === 'medium');
  return { total: legit.length, count: wrong.length, rate: ratio(wrong.length, legit.length), ids: wrong.map((s) => s.id) };
}

export interface Thresholds {
  medium: number;
  high: number;
}

export interface CalibrationBin {
  /** 区间下界，null 表示负无穷。 */
  lo: number | null;
  /** 区间上界（不含），null 表示正无穷。 */
  hi: number | null;
  n: number;
  meanScore: number | null;
  /** 这一档里“已确认滥用”的比例。 */
  abuseRate: number | null;
  /** 这一档里“疑似异常”加“已确认滥用”的比例。 */
  abnormalRate: number | null;
}

/**
 * 风险分 R 的校准表。R 是信号贡献的加权和，不是概率（负数表示证据支持索赔），
 * 所以按判定阈值分档：R < 0、0 到中风险阈值、中风险到高风险阈值、高风险阈值以上，
 * 看每档里实际滥用的比例是否随 R 上升。
 */
export function calibration(samples: SampleOutcome[], t: Thresholds): CalibrationBin[] {
  const edges: (number | null)[] = [null, 0, t.medium, t.high, null];
  const out: CalibrationBin[] = [];
  for (let b = 0; b < edges.length - 1; b++) {
    const lo = edges[b];
    const hi = edges[b + 1];
    const inBin = samples.filter((s) => (lo === null || s.score >= lo) && (hi === null || s.score < hi));
    const n = inBin.length;
    out.push({
      lo,
      hi,
      n,
      meanScore: n ? inBin.reduce((sum, s) => sum + s.score, 0) / n : null,
      abuseRate: ratio(inBin.filter((s) => s.label === 'confirmed_abuse').length, n),
      abnormalRate: ratio(inBin.filter((s) => abnormal(s.label)).length, n),
    });
  }
  return out;
}

export function confusion(samples: SampleOutcome[]): Record<Label, Record<VerdictLevel, number>> {
  const m = Object.fromEntries(LABELS.map((l) => [l, Object.fromEntries(LEVELS.map((v) => [v, 0]))])) as Record<Label, Record<VerdictLevel, number>>;
  for (const s of samples) m[s.label][s.level]++;
  return m;
}

export interface AnalyzerStats {
  analyzer: AnalyzerName;
  /** 正常跑完的样本数。 */
  ran: number;
  /** 给出矛盾信号的样本数。 */
  flagged: number;
  tp: number;
  precision: number | null;
  recall: number | null;
}

/**
 * 各分析器的精确率与召回率（样本级）：分析器给出“与索赔矛盾”的信号算标记；
 * 疑似异常和已确认滥用算正类。召回率的分母是全部正类样本，单个分析器只覆盖一部分作弊方式，召回率低是正常的。
 */
export function analyzerStats(samples: SampleOutcome[]): AnalyzerStats[] {
  const positives = samples.filter((s) => abnormal(s.label)).length;
  return ANALYZERS.map((analyzer) => {
    const flagged = samples.filter((s) => s.flagged.includes(analyzer));
    const tp = flagged.filter((s) => abnormal(s.label)).length;
    return {
      analyzer,
      ran: samples.filter((s) => s.ran.includes(analyzer)).length,
      flagged: flagged.length,
      tp,
      precision: ratio(tp, flagged.length),
      recall: ratio(tp, positives),
    };
  });
}

export interface RobustnessChange {
  id: string;
  from: VerdictLevel;
  to: VerdictLevel;
  lost: string[];
  gained: string[];
}

/** 同一样本变换前后的判定一致率。只比较有买家图片或视频的样本。 */
export function robustness(base: SampleOutcome[], variant: SampleOutcome[]) {
  const byId = new Map(variant.map((v) => [v.id, v]));
  const changes: RobustnessChange[] = [];
  let applicable = 0;
  let agree = 0;
  for (const b of base) {
    const v = byId.get(b.id);
    if (!b.hasEvidence || !v) continue;
    applicable++;
    if (v.level === b.level) agree++;
    else
      changes.push({
        id: b.id,
        from: b.level,
        to: v.level,
        lost: b.codes.filter((c) => !v.codes.includes(c)),
        gained: v.codes.filter((c) => !b.codes.includes(c)),
      });
  }
  return { applicable, agree, rate: ratio(agree, applicable), changes };
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

export function latency(samples: SampleOutcome[]) {
  const ms = samples.map((s) => s.analysisMs);
  return {
    n: ms.length,
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    max: ms.length ? Math.max(...ms) : null,
  };
}

export interface Summary {
  n: number;
  byLabel: Record<Label, number>;
  legitFalsePositives: ReturnType<typeof legitFalsePositives>;
  /** 已确认滥用：判“高风险”算预测为正。 */
  abuse: BinaryStats & { prAuc: number | null };
  confusion: ReturnType<typeof confusion>;
  incomplete: number;
  calibration: CalibrationBin[];
  /** 判为高风险、但 R 低于高风险阈值的样本（硬规则命中）。PR-AUC 只按 R 排序，会低估这些样本。 */
  hardRuleHigh: string[];
  analyzers: AnalyzerStats[];
  latency: ReturnType<typeof latency>;
}

export function summarize(samples: SampleOutcome[], thresholds: Thresholds): Summary {
  const byLabel = Object.fromEntries(LABELS.map((l) => [l, samples.filter((s) => s.label === l).length])) as Record<Label, number>;
  return {
    n: samples.length,
    byLabel,
    legitFalsePositives: legitFalsePositives(samples),
    abuse: {
      ...binaryStats(samples.map((s) => ({ actual: s.label === 'confirmed_abuse', predicted: s.level === 'high' }))),
      prAuc: averagePrecision(samples.map((s) => ({ score: s.score, positive: s.label === 'confirmed_abuse' }))),
    },
    confusion: confusion(samples),
    incomplete: samples.filter((s) => s.incomplete).length,
    calibration: calibration(samples, thresholds),
    hardRuleHigh: samples.filter((s) => s.level === 'high' && s.score < thresholds.high).map((s) => s.id),
    analyzers: analyzerStats(samples),
    latency: latency(samples),
  };
}
