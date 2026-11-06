// 判定引擎：纯函数、确定性。分数只由规则计算，LLM 不参与。
// 没有任何代码路径从这里调用 PayPal；这里只产出“建议”，执行要等商家确认（见 server/actions.ts）。

import {
  HARD_RULE_CODES,
  keyAnalyzerGroups,
  MEDIUM_FLOOR_CODES,
  NORMAL_EXPLANATIONS,
  PROPOSITIONS,
  requiredShots,
  RULES_VERSION,
  SHOT_LABEL,
  SIGNAL_TITLE,
  SOURCE_LAYER,
} from './catalog';
import { buildActions } from './recommend';
import type {
  EngineInput,
  Finding,
  Layer,
  MerchantRiskFactors,
  PropositionResult,
  Signal,
  Strength,
  VerdictLevel,
  VerdictReport,
} from './types';

export function merchantRisk(f: MerchantRiskFactors): number {
  const m =
    0.35 * clamp01(f.skuDeviation) +
    0.3 * (f.batchConfirmedIssue ? 1 : 0) +
    0.2 * (f.listingChangedAfterOrder ? 1 : 0) +
    0.15 * (f.missingReferenceOrWeight ? 1 : 0);
  return round(m);
}

export function signalContribution(s: Signal, cfg: EngineInput['config']): number {
  const d = s.direction === 'contradicts_claim' ? 1 : s.direction === 'supports_claim' ? -1 : 0;
  return d * cfg.strengthWeight[s.strength] * s.confidence * cfg.sourceWeight[s.basisSource];
}

/** 文档里写死的强度上限：Behavior、Synthetic 最高为中等。 */
function capStrength(s: Signal): Signal {
  if ((s.analyzer === 'behavior' || s.analyzer === 'synthetic') && s.strength === 'strong') {
    const capped: Strength = 'moderate';
    return { ...s, strength: capped };
  }
  return s;
}

function evaluatePropositions(input: EngineInput, signals: Signal[]): PropositionResult[] {
  const { claim, evidence, runs, policy, hasReference } = input;
  const strongLayers = new Set<Layer>(['A', 'B']);
  const defs = PROPOSITIONS[claim.type];

  return defs.map((def) => {
    const key = typeof def.key === 'function' ? def.key({ policy, hasReference }) : def.key;
    const holding = signals.filter((s) => def.holdsBy?.includes(s.code));
    const refuting = signals.filter((s) => def.refutedBy?.includes(s.code));
    const layersOf = (list: Signal[]) => list.map((s) => SOURCE_LAYER[s.basisSource]);
    const layers = new Set<Layer>([...layersOf(holding), ...layersOf(refuting)]);

    const base = {
      id: def.id,
      label: def.label,
      key,
      supportingSignalIds: holding.map((s) => s.id),
      refutingSignalIds: refuting.map((s) => s.id),
    };
    const done = (status: PropositionResult['status'], note?: string): PropositionResult => ({
      ...base,
      status,
      layers: [...layers].sort(),
      note,
    });

    if (def.policyField === 'returnable') {
      layers.add('A');
      return policy.returnable ? done('holds') : done('refuted', '类目策略：该类商品不要求退货');
    }
    if (refuting.some((s) => strongLayers.has(SOURCE_LAYER[s.basisSource]))) return done('refuted');
    if (holding.some((s) => strongLayers.has(SOURCE_LAYER[s.basisSource]))) return done('holds');

    if (def.requiredShots?.length) {
      // 留底照是商家自己的，不能当作买家已经提交了这个镜头。
      const buyerEvidence = evidence.filter((e) => e.source !== 'reference');
      const allCovered = def.requiredShots.every((shot) =>
        buyerEvidence.some((e) => e.shotLabel === shot && strongLayers.has(e.layer)),
      );
      if (allCovered) {
        def.requiredShots.forEach((shot) =>
          buyerEvidence.filter((e) => e.shotLabel === shot).forEach((e) => layers.add(e.layer)),
        );
        return done('holds');
      }
    }
    if (def.coveredBySources?.length) {
      const hit = evidence.filter((e) => def.coveredBySources!.includes(e.source));
      if (hit.length) {
        hit.forEach((e) => layers.add(e.layer));
        return done('holds');
      }
    }
    if (def.holdsWhenClean) {
      const ran = runs.some((r) => r.analyzer === def.holdsWhenClean && r.status === 'done');
      const strongBasis = evidence.some((e) => strongLayers.has(e.layer));
      if (ran && strongBasis && refuting.length === 0) return done('holds');
    }
    if (holding.length || refuting.length) return done('insufficient', '只有 C、D 层证据，不足以确认');
    return done('insufficient');
  });
}

function buildFindings(signals: Signal[], input: EngineInput): Finding[] {
  return signals
    .map<Finding>((s) => ({
      signalIds: [s.id],
      code: s.code,
      title: SIGNAL_TITLE[s.code] ?? s.code,
      explanation: s.explanation,
      analyzer: s.analyzer,
      direction: s.direction,
      strength: s.strength,
      confidence: s.confidence,
      contribution: round(signalContribution(s, input.config)),
      evidenceIds: s.evidenceIds,
      region: s.region,
      // 文档要求强信号附正常解释；中等强度、目录里写了正常解释的（如视频剪辑）也附上，多一层提醒。
      normalExplanations: s.strength !== 'weak' || MEDIUM_FLOOR_CODES.has(s.code) || s.code === 'DELIVERED_CONFIRMED'
        ? (NORMAL_EXPLANATIONS[s.code] ?? [])
        : [],
      provider: s.provider,
      hardRule: HARD_RULE_CODES.has(s.code) && s.direction === 'contradicts_claim',
    }))
    .sort((a, b) => {
      if (a.hardRule !== b.hardRule) return a.hardRule ? -1 : 1;
      return Math.abs(b.contribution) - Math.abs(a.contribution);
    });
}

export function decide(input: EngineInput): VerdictReport {
  const { config: cfg, claim, policy } = input;
  const trace: string[] = [];

  const M = merchantRisk(input.merchantFactors);
  const merchantRiskHigh = M >= cfg.merchantRiskHigh;

  // 强度上限；M 高时 SKU 聚集不计入，避免把真实质量问题归因于买家。
  let signals = input.signals.map(capStrength);
  if (merchantRiskHigh && signals.some((s) => s.code === 'SKU_CLAIM_CLUSTER')) {
    signals = signals.filter((s) => s.code !== 'SKU_CLAIM_CLUSTER');
    trace.push(`M=${M.toFixed(2)} 偏高：SKU_CLAIM_CLUSTER 不计入 R`);
  }

  // 加权评分。Behavior 单独不能把判定推到高风险。
  const behaviorR = sum(signals.filter((s) => s.analyzer === 'behavior').map((s) => signalContribution(s, cfg)));
  const otherR = sum(signals.filter((s) => s.analyzer !== 'behavior').map((s) => signalContribution(s, cfg)));
  let R = behaviorR + otherR;
  if (otherR < cfg.riskMedium && R >= cfg.riskHigh) {
    R = cfg.riskHigh - 0.01;
    trace.push('Behavior 信号单独不足以判高风险，R 限制在高风险阈值以下');
  }
  R = round(R);

  const propositions = evaluatePropositions(input, signals);
  const keyProps = propositions.filter((p) => p.key);
  const coverage = keyProps.length ? keyProps.filter((p) => p.status !== 'insufficient').length / keyProps.length : 1;
  const finished = input.runs.filter((r) => r.status === 'done').length;
  const completion = input.runs.length ? finished / input.runs.length : 0;
  const Q = round(coverage * completion);

  // 充分性：必需镜头。
  const required = requiredShots(claim.type, policy);
  const buyerEvidence = input.evidence.filter((e) => e.source !== 'reference');
  const missingShots = required.filter((shot) => !buyerEvidence.some((e) => e.shotLabel === shot));
  const lowTierShots = required.filter(
    (shot) =>
      !missingShots.includes(shot) &&
      !buyerEvidence.some((e) => e.shotLabel === shot && (e.layer === 'A' || e.layer === 'B')),
  );

  // 未执行检查。
  const notRun = input.runs
    .filter((r) => r.status !== 'done')
    .map((r) => ({
      analyzer: r.analyzer,
      status: r.status,
      reason:
        r.error ?? r.note ?? (r.status === 'queued' || r.status === 'running' ? '仍在运行' : '未执行'),
    }));
  const incomplete = notRun.length > 0;
  const keyGroupDown = keyAnalyzerGroups(claim.type).some((group) => {
    const runs = group.map((a) => input.runs.find((r) => r.analyzer === a)).filter(Boolean);
    return runs.length > 0 && runs.every((r) => r!.status === 'unavailable' || r!.status === 'failed');
  });

  const hardHits = signals.filter((s) => HARD_RULE_CODES.has(s.code) && s.direction === 'contradicts_claim');
  const floorHits = signals.filter((s) => MEDIUM_FLOOR_CODES.has(s.code) && s.direction === 'contradicts_claim');
  const keyInsufficient = keyProps.filter((p) => p.status === 'insufficient');

  // 判定顺序：硬规则 → 风险分与 Q → 中风险下限 → 充分性 → 关键分析器。
  // 文档把“充分性”写在“加权评分”前，但那样“R 高但 Q 低”和“相册上传的 AI 图判中风险”都走不到；
  // 所以风险证据优先，只有 R 偏低时才看证据是否足够。
  let level: VerdictLevel;
  if (hardHits.length) {
    level = 'high';
    trace.push(`硬规则命中 ${hardHits.map((s) => s.code).join('、')} → 高风险，不被其他信号抵消`);
  } else if (R >= cfg.riskHigh) {
    if (Q >= cfg.minDataConfidence) {
      level = 'high';
      trace.push(`R=${R} ≥ ${cfg.riskHigh} 且 Q=${Q} 充足 → 高风险`);
    } else {
      level = 'medium';
      trace.push(`R=${R} ≥ ${cfg.riskHigh} 但 Q=${Q} 偏低 → 降为中风险，先补证再重判`);
    }
  } else if (R >= cfg.riskMedium) {
    level = 'medium';
    trace.push(`${cfg.riskMedium} ≤ R=${R} < ${cfg.riskHigh} → 中风险`);
  } else if (floorHits.length) {
    level = 'medium';
    trace.push(`R=${R} 偏低，但出现 ${floorHits.map((s) => s.code).join('、')} → 中风险下限`);
  } else if (keyInsufficient.length) {
    level = 'insufficient';
    trace.push(`关键命题证据不足：${keyInsufficient.map((p) => p.label).join('；')}`);
  } else if (keyGroupDown) {
    level = 'medium';
    trace.push('关键分析器全部不可用：核验不完整，不判低风险');
  } else if (Q < cfg.minDataConfidence) {
    level = 'medium';
    trace.push(`R=${R} 偏低但 Q=${Q} 不足：不判低风险`);
  } else {
    level = 'low';
    trace.push(`R=${R} < ${cfg.riskMedium}，Q=${Q} 充足，无强矛盾 → 低风险`);
  }
  if (incomplete) trace.push(`核验不完整：${notRun.map((r) => r.analyzer).join('、')} 未完成`);

  const findings = buildFindings(signals, input);
  const topSignalIds = [...signals]
    .filter((s) => s.direction !== 'neutral')
    .sort((a, b) => Math.abs(signalContribution(b, cfg)) - Math.abs(signalContribution(a, cfg)))
    .slice(0, 3)
    .map((s) => s.id);

  const qualityNotice = merchantRiskHigh;
  const has = (code: string) => signals.some((s) => s.code === code);

  const notices: string[] = [];
  if (policy.safetySensitive) notices.push('该类目涉及食品或人身安全：请先按安全事件处理，不要因风险分延误。');
  if (qualityNotice) notices.push(`疑似商品质量或履约问题（M=${M.toFixed(2)}）：建议优先排查商品与发货环节。`);
  if (has('DELIVERY_ADDRESS_MISMATCH') || has('SHIPPED_BEFORE_ORDER'))
    notices.push('商家自己的物流证据不足以证明送达：系统不建议把这个单号提交给 PayPal。');
  if (!policy.returnable) notices.push('类目策略：该类商品不要求退货。');
  if (policy.perishable) notices.push('类目策略：易腐商品，重点看签收到首次反馈的间隔。');
  if (input.merchantFactors.listingChangedAfterOrder)
    notices.push('下单后商品描述被修改过：本次按下单时的商品快照判定。');
  if (claim.alreadyAgreed) notices.push('时间线显示双方已就退款达成一致：不再建议反驳。');
  if (input.merchantFactors.missingReferenceOrWeight)
    notices.push('本订单缺少留底或发货称重：部分比对无法进行，发货前留底可以提高判定质量。');

  const shotNames = (list: string[]) => list.map((s) => SHOT_LABEL[s] ?? s);
  const { primary, alternatives } = buildActions({
    level,
    claim,
    policy,
    signals,
    findings,
    missingShots: shotNames(missingShots),
    lowTierShots: shotNames(lowTierShots),
    keyInsufficient: keyInsufficient.map((p) => p.label),
    incomplete,
  });

  return {
    level,
    score: R,
    dataConfidence: Q,
    merchantRisk: M,
    incomplete,
    qualityNotice,
    headline: headlineFor(level, findings),
    decisionNeeded: primary.type === 'none' ? '请人工复核后决定下一步' : `是否${primary.label}`,
    notices,
    primaryAction: primary,
    alternatives,
    propositions,
    missingShots,
    lowTierShots,
    findings,
    topSignalIds,
    notRun,
    ruleTrace: trace,
    merchantFactors: input.merchantFactors,
    rulesVersion: RULES_VERSION,
    config: input.config,
  };
}

function headlineFor(level: VerdictLevel, findings: Finding[]): string {
  const top = findings.find((f) => f.direction === 'contradicts_claim');
  switch (level) {
    case 'high':
      return top ? top.title : '存在明确的反驳证据';
    case 'medium':
      return top ? `${top.title}，需要进一步核对` : '现有证据无法下结论，需要进一步核对';
    case 'insufficient':
      return '关键事实缺少可靠证据';
    case 'low':
      return '未发现与索赔矛盾的证据';
  }
}

function sum(xs: number[]) {
  return xs.reduce((a, b) => a + b, 0);
}
function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}
function round(x: number) {
  return Math.round(x * 100) / 100;
}
