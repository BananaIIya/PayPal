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

/** 指向证据本身可能是伪造或翻拍的反证。出现任何一条，序列号不符都不能用来放行退款。 */
const FABRICATION_CODES = new Set([
  'SYNTHETIC_LIKELY',
  'SCREEN_RECAPTURE',
  'PROVENANCE_CLAIM_UNVERIFIED',
  'CHALLENGE_MISMATCH',
  'CHALLENGE_MISSING',
  'PHYSICALLY_IMPLAUSIBLE',
  'CROSS_EVIDENCE_CONTRADICTION',
  'NARRATIVE_EVIDENCE_CONFLICT',
  'VIDEO_EDITED',
  'VIDEO_DISCONTINUITY',
]);

/** 带有 AI 来源声明的文件（修图或从零生成），不能再当作 A、B 层覆盖。 */
function taintedEvidenceIds(signals: Signal[]): Set<string> {
  return new Set(
    signals.filter((s) => s.code === 'PROVENANCE_CLAIM_UNVERIFIED' || s.code === 'AI_PROVENANCE_FOUND').flatMap((s) => s.evidenceIds),
  );
}

function evaluatePropositions(input: EngineInput, signals: Signal[]): PropositionResult[] {
  const { claim, evidence, runs, policy, hasReference } = input;
  const strongLayers = new Set<Layer>(['A', 'B']);
  const tainted = taintedEvidenceIds(signals);
  const countsAsStrong = (e: { id: string; layer: Layer }) => strongLayers.has(e.layer) && !tainted.has(e.id);
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
      return policy.returnable ? done('holds') : done('refuted', 'Category policy: returns not required for this category');
    }
    const strongRefutes = refuting.filter((s) => strongLayers.has(SOURCE_LAYER[s.basisSource]));
    if (strongRefutes.length) {
      // 序列号不符也可能是仓库错发，不能把它当成“索赔事实已被否定”。
      if (strongRefutes.every((s) => s.code === 'IDENTITY_MISMATCH')) {
        return done('insufficient', 'Serial number does not match the shipment reference, but the warehouse may have shipped the wrong unit; this cannot refute the claim');
      }
      return done('refuted');
    }
    const untaintedHold = (s: Signal) =>
      strongLayers.has(SOURCE_LAYER[s.basisSource]) && !(s.evidenceIds.length > 0 && s.evidenceIds.every((id) => tainted.has(id)));
    if (holding.some(untaintedHold)) return done('holds');

    if (def.requiredShots?.length) {
      // 留底照是商家自己的，不能当作买家已经提交了这个镜头。
      // 带未核验来源声明的照片也不算这个镜头已经有了可靠覆盖。
      const buyerEvidence = evidence.filter((e) => e.source !== 'reference');
      const allCovered = def.requiredShots.every((shot) => buyerEvidence.some((e) => e.shotLabel === shot && countsAsStrong(e)));
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
      const strongBasis = evidence.some((e) => countsAsStrong(e));
      if (ran && strongBasis && refuting.length === 0) return done('holds');
    }
    if (holding.length || refuting.length) return done('insufficient', 'Only tier C and D evidence; not enough to confirm');
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
    trace.push(`M=${M.toFixed(2)} is high: SKU_CLAIM_CLUSTER excluded from R`);
  }

  // 加权评分。Behavior 单独不能把判定推到高风险。
  const behaviorR = sum(signals.filter((s) => s.analyzer === 'behavior').map((s) => signalContribution(s, cfg)));
  const otherR = sum(signals.filter((s) => s.analyzer !== 'behavior').map((s) => signalContribution(s, cfg)));
  let R = behaviorR + otherR;
  if (otherR < cfg.riskMedium && R >= cfg.riskHigh) {
    R = cfg.riskHigh - 0.01;
    trace.push('Behavior signals alone cannot make it high risk; R capped below the high-risk threshold');
  }
  const provenanceR = sum(signals.filter((s) => s.code === 'PROVENANCE_CLAIM_UNVERIFIED').map((s) => signalContribution(s, cfg)));
  if (provenanceR > 0 && R - provenanceR < cfg.riskHigh && R >= cfg.riskHigh) {
    R = cfg.riskHigh - 0.01;
    trace.push('An unverified provenance claim alone cannot make it high risk; R capped below the high-risk threshold');
  }
  R = round(R);

  const propositions = evaluatePropositions(input, signals);
  const keyProps = propositions.filter((p) => p.key);
  const coverage = keyProps.length ? keyProps.filter((p) => p.status !== 'insufficient').length / keyProps.length : 1;
  const finished = input.runs.filter((r) => r.status === 'done').length;
  const completion = input.runs.length ? finished / input.runs.length : 0;
  const Q = round(coverage * completion);

  // 充分性：必需镜头。带未核验来源声明的文件不算 A、B 层覆盖。
  const required = requiredShots(claim.type, policy);
  const tainted = taintedEvidenceIds(signals);
  const buyerEvidence = input.evidence.filter((e) => e.source !== 'reference');
  const missingShots = required.filter((shot) => !buyerEvidence.some((e) => e.shotLabel === shot));
  const lowTierShots = required.filter(
    (shot) =>
      !missingShots.includes(shot) &&
      !buyerEvidence.some((e) => e.shotLabel === shot && (e.layer === 'A' || e.layer === 'B') && !tainted.has(e.id)),
  );

  // 未执行检查。
  const notRun = input.runs
    .filter((r) => r.status !== 'done')
    .map((r) => ({
      analyzer: r.analyzer,
      status: r.status,
      reason:
        r.error ?? r.note ?? (r.status === 'queued' || r.status === 'running' ? 'Still running' : 'Not run'),
    }));
  const incomplete = notRun.length > 0;
  const keyAnalyzerDown = keyAnalyzerGroups(claim.type).some((group) =>
    group.some((name) => {
      const run = input.runs.find((r) => r.analyzer === name);
      return run != null && (run.status === 'unavailable' || run.status === 'failed');
    }),
  );

  const hardHits = signals.filter((s) => HARD_RULE_CODES.has(s.code) && s.direction === 'contradicts_claim');
  const floorHits = signals.filter((s) => MEDIUM_FLOOR_CODES.has(s.code) && s.direction === 'contradicts_claim');
  const keyInsufficient = keyProps.filter((p) => p.status === 'insufficient');

  // 判定顺序：硬规则 → 风险分与 Q → 中风险下限 → 充分性 → 关键分析器。
  // 文档把“充分性”写在“加权评分”前，但那样“R 高但 Q 低”和“相册上传的 AI 图判中风险”都走不到；
  // 所以风险证据优先，只有 R 偏低时才看证据是否足够。
  let level: VerdictLevel;
  if (hardHits.length) {
    level = 'high';
    trace.push(`Hard rule hit: ${hardHits.map((s) => s.code).join(', ')} → High risk, not offset by other signals`);
  } else if (R >= cfg.riskHigh) {
    if (Q >= cfg.minDataConfidence) {
      level = 'high';
      trace.push(`R=${R} ≥ ${cfg.riskHigh} and Q=${Q} sufficient → High risk`);
    } else {
      level = 'medium';
      trace.push(`R=${R} ≥ ${cfg.riskHigh} but Q=${Q} is low → lowered to Medium risk; collect more evidence, then re-run`);
    }
  } else if (R >= cfg.riskMedium) {
    level = 'medium';
    trace.push(`${cfg.riskMedium} ≤ R=${R} < ${cfg.riskHigh} → Medium risk`);
  } else if (floorHits.length) {
    level = 'medium';
    trace.push(`R=${R} is low, but ${floorHits.map((s) => s.code).join(', ')} present → Medium risk floor`);
  } else if (keyInsufficient.length) {
    level = 'insufficient';
    trace.push(`Insufficient evidence for key checks: ${keyInsufficient.map((p) => p.label).join('; ')}`);
  } else if (keyAnalyzerDown) {
    level = 'medium';
    trace.push('Key analyzer unavailable: verification incomplete, not judged low risk');
  } else if (Q < cfg.minDataConfidence) {
    level = 'medium';
    trace.push(`R=${R} is low but Q=${Q} is insufficient: not judged low risk`);
  } else {
    level = 'low';
    trace.push(`R=${R} < ${cfg.riskMedium}, Q=${Q} sufficient, no strong contradiction → Low risk`);
  }
  if (level === 'low' && signals.some((s) => s.code === 'IDENTITY_MISMATCH' && s.direction === 'contradicts_claim')) {
    level = 'medium';
    trace.push('Serial number does not match the shipment reference; this may be a merchant fulfillment error, so not lowered to low risk');
  }
  // 留底对得上的序列号是可核实的反证，现场或系统记录里读清楚了就应算高风险。
  // 不放进硬规则：相册上传仍按分数停留在中风险；强支持把 R 压到阈值以下时也只保留中风险下限。
  // 推荐动作不在这里改，仍然是先排查错发，而不是提交反驳。
  const clearIdentity = signals.some(
    (s) =>
      s.code === 'IDENTITY_MISMATCH' &&
      s.direction === 'contradicts_claim' &&
      s.strength === 'strong' &&
      s.confidence >= 0.9 &&
      (SOURCE_LAYER[s.basisSource] === 'A' || SOURCE_LAYER[s.basisSource] === 'B'),
  );
  if (clearIdentity && level === 'medium' && R >= cfg.riskMedium && Q >= cfg.minDataConfidence) {
    level = 'high';
    trace.push('Serial number in live capture or system records clearly does not match the shipment reference, and confidence is sufficient → High risk; still check for a wrong shipment first, do not contest directly');
  }
  if (incomplete) trace.push(`Verification incomplete: ${notRun.map((r) => r.analyzer).join(', ')} not finished`);

  const findings = buildFindings(signals, input);
  const topSignalIds = [...signals]
    .filter((s) => s.direction !== 'neutral')
    .sort((a, b) => Math.abs(signalContribution(b, cfg)) - Math.abs(signalContribution(a, cfg)))
    .slice(0, 3)
    .map((s) => s.id);

  const qualityNotice = merchantRiskHigh;
  const has = (code: string) => signals.some((s) => s.code === code);

  const notices: string[] = [];
  if (policy.safetySensitive) notices.push('This category involves food or personal safety: handle it as a safety incident first, and do not let the risk score delay you.');
  if (qualityNotice) notices.push(`Possible quality or fulfillment issue (M=${M.toFixed(2)}): check the product and shipping process first.`);
  if (has('DELIVERY_ADDRESS_MISMATCH') || has('SHIPPED_BEFORE_ORDER'))
    notices.push("The merchant's own tracking evidence does not prove delivery: do not submit this tracking number to PayPal.");
  if (has('TRACKING_NOT_DELIVERED') || has('TRACKING_STATUS_UNKNOWN'))
    notices.push('There is no verifiable delivery record yet, so this cannot justify a refund.');
  if (has('AI_PROVENANCE_FOUND'))
    notices.push('A file declares in its content credentials that it was fully generated by AI. It cannot count as photographic evidence and has been treated as high risk. To give the buyer a chance, ask for live photos.');
  if (has('PROVENANCE_CLAIM_UNVERIFIED'))
    notices.push('The provenance claim in the file has not been verified for signature, signer, or content binding, so it cannot be used to refute the claim. An unedited original photo or other independent evidence is needed.');
  if (has('IDENTITY_MISMATCH'))
    notices.push('The serial number does not match the shipment reference, which may be a warehouse shipping error. Check the shipping records first; do not treat it as buyer fraud.');
  if (!policy.returnable) notices.push('Category policy: returns not required for this category.');
  if (policy.perishable) notices.push('Category policy: perishable item; focus on the time between delivery and the first report.');
  if (input.merchantFactors.listingChangedAfterOrder)
    notices.push('The listing was edited after the order: this verdict uses the listing snapshot at order time.');
  if (claim.alreadyAgreed && hardHits.length === 0) notices.push('The timeline shows both parties agreed on a refund: contesting is no longer recommended.');
  if (claim.alreadyAgreed && hardHits.length > 0)
    notices.push('The merchant previously agreed to a refund in messages, but the evidence hit a hard rule. This is not treated as agreed; confirm manually before refunding.');
  if (input.merchantFactors.missingReferenceOrWeight)
    notices.push('This order has no shipment reference or shipping weight: some comparisons cannot run. Reference photos before shipping improve verdict quality.');

  // 序列号不符时允许退款，是为了让商家处理自己的错发。买家能伪造的照片不能打开这个口子：
  // 序列号必须来自现场拍摄或系统记录，那张图不能带 AI 来源声明，分析要跑完，也不能有伪造类的反证。
  const taintedIds = taintedEvidenceIds(signals);
  const identityRefund =
    hardHits.length === 0 &&
    !incomplete &&
    !signals.some((s) => s.direction === 'contradicts_claim' && FABRICATION_CODES.has(s.code)) &&
    signals.some(
      (s) =>
        s.code === 'IDENTITY_MISMATCH' &&
        s.direction === 'contradicts_claim' &&
        (SOURCE_LAYER[s.basisSource] === 'A' || SOURCE_LAYER[s.basisSource] === 'B') &&
        !s.evidenceIds.some((id) => taintedIds.has(id)),
    );

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
    identityRefund,
  });
  const payoutSuggested = primary.type === 'refund' || primary.type === 'accept_claim' || primary.type === 'make_offer';
  if (!payoutSuggested && !identityRefund) {
    notices.push('This verdict does not recommend a refund. Refund, accept claim, and offer will not run.');
  }

  return {
    level,
    score: R,
    dataConfidence: Q,
    merchantRisk: M,
    incomplete,
    qualityNotice,
    headline: headlineFor(level, findings, {
      provenanceUnverified: has('PROVENANCE_CLAIM_UNVERIFIED'),
      materialContradiction: signals.some(
        (s) => s.direction === 'contradicts_claim' && (s.strength === 'moderate' || s.strength === 'strong'),
      ),
      identityReview: level === 'high' && has('IDENTITY_MISMATCH') && hardHits.length === 0,
    }),
    decisionNeeded: primary.type === 'none' ? 'Review manually and decide the next step' : primary.label,
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
    identityRefund,
    rulesVersion: RULES_VERSION,
    config: input.config,
  };
}

function headlineFor(
  level: VerdictLevel,
  findings: Finding[],
  opts: { provenanceUnverified: boolean; materialContradiction: boolean; identityReview: boolean },
): string {
  const top = findings.find((f) => f.direction === 'contradicts_claim');
  switch (level) {
    case 'high':
      if (opts.identityReview) return 'Item identifiers do not match the shipment reference; check for a wrong shipment first';
      return top ? top.title : 'Clear contradicting evidence';
    case 'medium':
      return top ? `${top.title}; needs further review` : 'Current evidence is inconclusive; needs further review';
    case 'insufficient':
      if (opts.provenanceUnverified && !opts.materialContradiction) return 'Unverified provenance claim; original photo or more evidence needed';
      return 'Key facts lack reliable evidence';
    case 'low':
      return 'No evidence contradicts the claim';
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
