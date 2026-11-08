// 把评估结果写成 Markdown 报告。
import { ANALYZER_LABEL, LEVEL_LABEL } from '@/core/catalog';
import { LABEL_TEXT, LABELS, LEVELS, type Summary, type Thresholds } from './metrics';
import type { EvalResult } from './run';
import { SPLIT_TEXT, SPLITS } from './splits';

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
const num = (v: number | null, digits = 2) => (v === null ? '—' : v.toFixed(digits));
const ms = (v: number | null) => (v === null ? '—' : `${Math.round(v)} ms`);
const row = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`;
const head = (cells: string[], align?: string[]) => [row(cells), row(align ?? cells.map(() => '---'))].join('\n');

function summarySection(s: Summary, t: Thresholds): string {
  const lines: string[] = [];
  const fp = s.legitFalsePositives;
  lines.push('### 首要指标：合法售后被判为中、高风险的比例', '');
  lines.push(`**${pct(fp.rate)}**（${fp.count} / ${fp.total}）。判为“证据不足”不算误判。`);
  if (fp.ids.length) lines.push('', `误判的样本：${fp.ids.join('、')}`);

  lines.push('', '### 已确认滥用', '');
  lines.push('判为高风险算预测为滥用；PR-AUC 按风险分 R 排序计算（平均精确率）。', '');
  lines.push(head(['精确率', '召回率', 'PR-AUC', '命中', '误报', '漏报'], ['---:', '---:', '---:', '---:', '---:', '---:']));
  lines.push(row([pct(s.abuse.precision), pct(s.abuse.recall), num(s.abuse.prAuc), s.abuse.tp, s.abuse.fp, s.abuse.fn]));
  if (s.hardRuleHigh.length) {
    lines.push('', `${s.hardRuleHigh.join('、')} 判为高风险，但 R 低于高风险阈值 ${t.high}；PR-AUC 只按 R 排序，会低估这类样本。`);
  }

  lines.push('', '### 标注 × 判定', '');
  lines.push(head(['标注', ...LEVELS.map((l) => LEVEL_LABEL[l]), '合计'], ['---', ...LEVELS.map(() => '---:'), '---:']));
  for (const l of LABELS) lines.push(row([LABEL_TEXT[l], ...LEVELS.map((v) => s.confusion[l][v]), s.byLabel[l]]));
  lines.push('', `其中 ${s.incomplete} 个判定附“核验不完整”。`);

  lines.push('', '### 风险分校准', '');
  lines.push(`R 是信号贡献的加权和，不是概率，按判定阈值分档（中风险 ${t.medium}，高风险 ${t.high}）。校准良好时，滥用比例应随 R 上升。`, '');
  lines.push(head(['R 区间', '样本', '平均 R', '已确认滥用比例', '异常比例（疑似+已确认）'], ['---', '---:', '---:', '---:', '---:']));
  for (const b of s.calibration) {
    const range = b.lo === null ? `< ${b.hi}` : b.hi === null ? `≥ ${b.lo}` : `${b.lo} – ${b.hi}`;
    lines.push(row([range, b.n, num(b.meanScore), pct(b.abuseRate), pct(b.abnormalRate)]));
  }

  lines.push('', '### 各分析器', '');
  lines.push('给出“与索赔矛盾”的信号算标记，疑似异常和已确认滥用算正类。召回率的分母是全部正类样本，单个分析器只覆盖一部分作弊方式。', '');
  lines.push(head(['分析器', '跑完', '标记', '其中正类', '精确率', '召回率'], ['---', '---:', '---:', '---:', '---:', '---:']));
  for (const a of s.analyzers) lines.push(row([ANALYZER_LABEL[a.analyzer].name, a.ran, a.flagged, a.tp, pct(a.precision), pct(a.recall)]));

  lines.push('', '### 耗时', '');
  lines.push(`单个索赔跑完核验管线：中位数 ${ms(s.latency.p50)}，P95 ${ms(s.latency.p95)}，最长 ${ms(s.latency.max)}（${s.latency.n} 个样本）。`);
  return lines.join('\n');
}

export function renderReport(r: EvalResult): string {
  const lines: string[] = [];
  lines.push(`# Verdict 评估报告：${r.dataset.name}`, '');
  lines.push(`- 时间：${r.startedAt}`);
  lines.push(`- 数据：${r.dataset.source === 'demo' ? '内置验收场景' : r.dataset.source}`);
  lines.push(`- 模式：${r.mode === 'live' ? '调用已配置的 LLM 和检测器' : '离线（录制回放和本地分析器）'}`);
  lines.push(`- 样本：${r.dataset.n} 个，${LABELS.map((l) => `${LABEL_TEXT[l]} ${r.dataset.byLabel[l]}`).join('，')}`);
  lines.push(`- 集合：${SPLITS.filter((s) => r.dataset.bySplit[s]).map((s) => `${SPLIT_TEXT[s]} ${r.dataset.bySplit[s]}`).join('，')}`);
  lines.push(`- 用时：${(r.durationMs / 1000).toFixed(1)} 秒`);

  lines.push('', '## 样本隔离', '');
  if (r.leaks.length === 0) {
    lines.push('同一张图（含近似图）、同一买家、同一 SKU 的样本都在同一个集合里。');
  } else {
    lines.push('**有样本泄漏，下面的分集合指标不可信：**', '');
    for (const leak of r.leaks) lines.push(`- ${leak.ids.join('、')} 属于同一组，却分在 ${leak.splits.map((s) => SPLIT_TEXT[s]).join('和')}`);
  }

  lines.push('', '## 全部样本', '', summarySection(r.summaries.all, r.thresholds));
  for (const sp of SPLITS) {
    const s = r.summaries[sp];
    if (s) lines.push('', `## ${SPLIT_TEXT[sp]}`, '', summarySection(s, r.thresholds));
  }

  lines.push('', '## 稳健性：内容不变、形式变化', '');
  if (!r.robustness.length) {
    lines.push('这次没有跑形式变换。');
  } else {
    lines.push('同一样本变换前后判定等级相同算一致。只统计有买家图片或视频的样本；视频原样导入，不做转码。', '');
    lines.push(head(['变换', '适用样本', '一致', '一致率'], ['---', '---:', '---:', '---:']));
    for (const t of r.robustness) lines.push(row([t.text, t.applicable, t.agree, pct(t.rate)]));
    const changed = r.robustness.flatMap((t) => t.changes.map((c) => ({ ...c, text: t.text })));
    if (changed.length) {
      lines.push('', '判定变化的样本：', '');
      lines.push(head(['变换', '样本', '原判定', '变换后', '消失的信号', '新出现的信号']));
      for (const c of changed) {
        lines.push(row([c.text, c.id, LEVEL_LABEL[c.from], LEVEL_LABEL[c.to], c.lost.join('、') || '—', c.gained.join('、') || '—']));
      }
    }
  }

  lines.push('', '## 逐个样本', '');
  lines.push(head(['样本', '集合', '标注', '判定', 'R', '不完整', '标记的分析器', '耗时'], ['---', '---', '---', '---', '---:', '---', '---', '---:']));
  for (const s of r.samples) {
    lines.push(
      row([
        s.id,
        SPLIT_TEXT[s.split],
        LABEL_TEXT[s.label],
        LEVEL_LABEL[s.level],
        s.score.toFixed(2),
        s.incomplete ? '是' : '',
        s.flagged.map((a) => ANALYZER_LABEL[a].name).join('、') || '—',
        ms(s.analysisMs),
      ]),
    );
  }

  if (r.notes.length) {
    lines.push('', '## 说明', '');
    for (const n of r.notes) lines.push(`- ${n}`);
  }
  return `${lines.join('\n')}\n`;
}
