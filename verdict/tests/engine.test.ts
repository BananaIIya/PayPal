import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, applicableAnalyzers } from '@/core/catalog';
import { decide, merchantRisk } from '@/core/engine';
import type {
  AnalyzerName,
  CategoryPolicy,
  ClaimType,
  EngineInput,
  EvidenceRef,
  Signal,
  SourceMark,
} from '@/core/types';

const POLICY: CategoryPolicy = {
  category: 'ceramics',
  returnable: true,
  perishable: false,
  safetySensitive: false,
  identityRequired: false,
};

const LIVE_SHOTS: EvidenceRef[] = ['overall', 'damage_closeup', 'package', 'label'].map((shot, i) => ({
  id: `e${i}`,
  source: 'live_capture',
  layer: 'B',
  shotLabel: shot,
}));
const REF: EvidenceRef = { id: 'ref', source: 'reference', layer: 'A', shotLabel: 'serial_closeup' };

function sig(code: string, over: Partial<Signal> = {}): Signal {
  return {
    id: over.id ?? code,
    analyzer: 'reference',
    code,
    direction: 'contradicts_claim',
    strength: 'moderate',
    confidence: 0.9,
    evidenceIds: ['e0'],
    basisSource: 'live_capture',
    explanation: code,
    ...over,
  };
}

function input(type: ClaimType, signals: Signal[], over: Partial<EngineInput> = {}): EngineInput {
  const analyzers = applicableAnalyzers(type, { hasImages: true, hasScreenshots: false });
  return {
    claim: { type, hasDispute: true, amount: 100, currency: 'USD', alreadyAgreed: false, trackingNumber: '1Z999', carrier: 'UPS' },
    policy: POLICY,
    signals,
    evidence: type === 'not_received' ? [] : [...LIVE_SHOTS, REF],
    runs: analyzers.map((analyzer) => ({ analyzer, status: 'done' as const })),
    hasReference: type !== 'not_received',
    merchantFactors: { skuDeviation: 0, batchConfirmedIssue: false, listingChangedAfterOrder: false, missingReferenceOrWeight: false },
    config: DEFAULT_CONFIG,
    ...over,
  };
}

const identityMatch = sig('IDENTITY_MATCH', { direction: 'supports_claim', strength: 'strong', confidence: 0.95 });

describe('公式', () => {
  it('S = d·w·c·r，r 取证据层级', () => {
    const live = decide(input('damaged', [identityMatch, sig('X', { strength: 'moderate', confidence: 1 })]));
    // -3*0.95*1 + 1.5*1*1 = -1.35
    expect(live.score).toBeCloseTo(-1.35, 2);

    const weights: [SourceMark, number][] = [
      ['live_capture', 1.5],
      ['paypal_dispute', 1.2],
      ['uploaded', 0.9],
      ['narrative', 0.45],
    ];
    for (const [source, expected] of weights) {
      const r = decide(input('damaged', [identityMatch, sig('X', { confidence: 1, basisSource: source })]));
      expect(r.score).toBeCloseTo(-2.85 + expected, 2);
    }
  });

  it('M 由四项组成，且范围在 0–1', () => {
    expect(merchantRisk({ skuDeviation: 1, batchConfirmedIssue: true, listingChangedAfterOrder: true, missingReferenceOrWeight: true })).toBe(1);
    expect(merchantRisk({ skuDeviation: 0, batchConfirmedIssue: false, listingChangedAfterOrder: false, missingReferenceOrWeight: false })).toBe(0);
  });
});

describe('验收场景（开发文档“测试与验收场景”）', () => {
  it('真实损坏 → 低风险', () => {
    const r = decide(input('damaged', [identityMatch]));
    expect(r.level).toBe('low');
    expect(r.primaryAction.type).toBe('accept_claim');
  });

  it.each([
    'AI_PROVENANCE_FOUND',
    'IDENTITY_MISMATCH',
    'IMAGE_FOUND_ONLINE',
    'EVIDENCE_REUSED_ACROSS_CLAIMS',
    'RECORD_NOT_FOUND',
    'SCREENSHOT_CONTENT_MISMATCH',
    'CROSS_EVIDENCE_CONTRADICTION',
  ])('硬规则 %s → 高风险，不被支持信号抵消，且在 Q 低时也不降级', (code) => {
    const hard = sig(code, { strength: 'strong', basisSource: 'uploaded' });
    const offset = sig('Y', { direction: 'supports_claim', strength: 'strong', confidence: 1 });
    const r = decide(input('damaged', [hard, offset, identityMatch], { evidence: [] }));
    expect(r.score).toBeLessThan(1);
    expect(r.level).toBe('high');
    expect(r.findings[0].code).toBe(code);
    expect(r.findings[0].hardRule).toBe(true);
  });

  it('无水印 AI 生成 + 相册上传 → 中风险，建议现场补拍', () => {
    const evidence: EvidenceRef[] = [{ id: 'e0', source: 'uploaded', layer: 'C', shotLabel: 'damage_closeup' }];
    const r = decide(
      input(
        'damaged',
        [
          sig('NO_PROVENANCE', { analyzer: 'provenance', direction: 'neutral', basisSource: 'uploaded' }),
          sig('SYNTHETIC_LIKELY', { analyzer: 'synthetic', confidence: 1, basisSource: 'uploaded' }),
        ],
        { evidence, hasReference: false },
      ),
    );
    expect(r.score).toBeLessThan(1); // 公式到不了中风险，靠下限规则
    expect(r.level).toBe('medium');
    expect(r.primaryAction.label).toBe('请买家现场补拍');
  });

  it('陈述与画面冲突 → 中风险，建议澄清', () => {
    const r = decide(input('damaged', [sig('NARRATIVE_EVIDENCE_CONFLICT', { analyzer: 'consistency', basisSource: 'uploaded' }), identityMatch]));
    expect(r.level).toBe('medium');
    expect(r.primaryAction.label).toBe('请买家澄清');
  });

  it('翻拍屏幕 → 至少中风险', () => {
    const r = decide(input('damaged', [sig('SCREEN_RECAPTURE', { analyzer: 'plausibility' })]));
    expect(['medium', 'high']).toContain(r.level);
  });

  it('未收到货但已签收 → 中风险，提交 PROOF_OF_FULFILLMENT，而不是要求补拍', () => {
    const r = decide(
      input('not_received', [
        sig('DELIVERED_CONFIRMED', { analyzer: 'logistics', confidence: 0.95, basisSource: 'carrier_api' }),
      ], { hasReference: false }),
    );
    expect(r.level).toBe('medium');
    expect(r.primaryAction.type).toBe('provide_evidence');
    expect(r.primaryAction.evidenceType).toBe('PROOF_OF_FULFILLMENT');
  });

  it('卖家单号不符 → 提示商家物流证据不足，不代为提交', () => {
    const r = decide(
      input('not_received', [
        sig('DELIVERY_ADDRESS_MISMATCH', { analyzer: 'logistics', direction: 'supports_claim', strength: 'strong', basisSource: 'carrier_api' }),
      ], { hasReference: false }),
    );
    expect(r.primaryAction.type).not.toBe('provide_evidence');
    expect(r.alternatives.map((a) => a.type)).not.toContain('provide_evidence');
    expect(r.notices.join()).toContain('物流证据不足');
  });

  it('同批次真实质量问题 → 低风险 + 质量提示，SKU 聚集不计入 R', () => {
    const cluster = sig('SKU_CLAIM_CLUSTER', { analyzer: 'behavior', confidence: 1, basisSource: 'paypal_record' });
    const r = decide(
      input('damaged', [identityMatch, cluster], {
        merchantFactors: { skuDeviation: 1, batchConfirmedIssue: true, listingChangedAfterOrder: false, missingReferenceOrWeight: false },
      }),
    );
    expect(r.level).toBe('low');
    expect(r.qualityNotice).toBe(true);
    expect(r.findings.map((f) => f.code)).not.toContain('SKU_CLAIM_CLUSTER');
    expect(r.score).toBeCloseTo(-2.85, 2);
  });

  it('下单后详情页被修改 → M 上升', () => {
    const r = decide(
      input('not_as_described', [sig('SNAPSHOT_DIFFERENCE', { direction: 'supports_claim', basisSource: 'listing_snapshot' })], {
        merchantFactors: { skuDeviation: 0, batchConfirmedIssue: false, listingChangedAfterOrder: true, missingReferenceOrWeight: false },
        evidence: [
          { id: 'e0', source: 'live_capture', layer: 'B', shotLabel: 'overall' },
          { id: 'e1', source: 'live_capture', layer: 'B', shotLabel: 'difference_closeup' },
          { id: 'e2', source: 'live_capture', layer: 'B', shotLabel: 'label' },
        ],
      }),
    );
    expect(r.merchantRisk).toBeGreaterThan(0);
    expect(r.level).toBe('low');
  });

  it('易腐商品 → 不建议退货', () => {
    const r = decide(input('damaged', [identityMatch], { policy: { ...POLICY, returnable: false, perishable: true } }));
    expect(r.notices.join()).toContain('不要求退货');
    expect(r.notices.join()).toContain('签收到首次反馈');
    expect(r.primaryAction.reason).toContain('不要求退货');
  });

  it('可退货的易腐商品也提示看签收到首次反馈的间隔', () => {
    const r = decide(input('damaged', [identityMatch], { policy: { ...POLICY, returnable: true, perishable: true } }));
    expect(r.notices.join()).toContain('签收到首次反馈');
    expect(r.notices.join()).not.toContain('不要求退货');
  });

  it('安全敏感类目 → 先提示按安全事件处理', () => {
    const r = decide(input('damaged', [identityMatch], { policy: { ...POLICY, safetySensitive: true } }));
    expect(r.notices[0]).toContain('安全事件');
  });

  it('检测服务不可用 → 附核验不完整，并列出未执行项', () => {
    const analyzers = applicableAnalyzers('damaged', { hasImages: true, hasScreenshots: false });
    const r = decide(
      input('damaged', [identityMatch], {
        runs: analyzers.map((analyzer) => ({
          analyzer,
          status: analyzer === 'synthetic' ? ('unavailable' as const) : ('done' as const),
          error: analyzer === 'synthetic' ? '未配置检测器' : null,
        })),
      }),
    );
    expect(r.incomplete).toBe(true);
    expect(r.notRun.map((x) => x.analyzer)).toEqual(['synthetic']);
  });

  it('Provenance 和 Synthetic 都不可用 → 不判低风险', () => {
    const analyzers = applicableAnalyzers('damaged', { hasImages: true, hasScreenshots: false });
    const down: AnalyzerName[] = ['provenance', 'synthetic'];
    const r = decide(
      input('damaged', [identityMatch], {
        runs: analyzers.map((analyzer) => ({
          analyzer,
          status: down.includes(analyzer) ? ('unavailable' as const) : ('done' as const),
        })),
      }),
    );
    expect(r.level).not.toBe('low');
    expect(r.incomplete).toBe(true);
  });
});

describe('Q 与充分性', () => {
  it('缺镜头 → 证据不足，一次性列出', () => {
    const r = decide(
      input('damaged', [], {
        evidence: [{ id: 'e0', source: 'uploaded', layer: 'C', shotLabel: 'damage_closeup' }],
        hasReference: false,
      }),
    );
    expect(r.level).toBe('insufficient');
    expect(r.missingShots).toEqual(['overall', 'package', 'label']);
    expect(r.primaryAction.message).toContain('商品整体照');
  });

  it('只有 C、D 层证据的关键命题 → 证据不足', () => {
    const evidence: EvidenceRef[] = ['overall', 'damage_closeup', 'package', 'label'].map((shot, i) => ({
      id: `e${i}`,
      source: 'uploaded',
      layer: 'C',
      shotLabel: shot,
    }));
    const r = decide(input('damaged', [], { evidence, hasReference: false }));
    expect(r.level).toBe('insufficient');
    expect(r.propositions.find((p) => p.id === 'damage_exists')?.status).toBe('insufficient');
    expect(r.lowTierShots).toHaveLength(4);
    expect(r.dataConfidence).toBe(0);
  });

  it('R 高但 Q 低 → 降为中风险，先补证', () => {
    const big = sig('Z', { analyzer: 'plausibility', strength: 'strong', confidence: 1, basisSource: 'carrier_api' });
    const r = decide(
      input('damaged', [big, { ...big, id: 'Z2' }], {
        evidence: [{ id: 'e0', source: 'uploaded', layer: 'C', shotLabel: 'damage_closeup' }],
      }),
    );
    expect(r.score).toBeGreaterThanOrEqual(3);
    expect(r.dataConfidence).toBeLessThan(0.5);
    expect(r.level).toBe('medium');
  });

  it('R 高且 Q 充足 → 高风险，提交反驳证据', () => {
    const big = sig('Z', { analyzer: 'plausibility', strength: 'strong', confidence: 1 });
    const r = decide(input('damaged', [big, { ...big, id: 'Z2' }, sig('IDENTITY_MATCH', { direction: 'supports_claim', strength: 'weak', confidence: 0.1 })]));
    expect(r.level).toBe('high');
    expect(r.primaryAction.type).toBe('provide_evidence');
    expect(r.primaryAction.evidenceType).toBe('OTHER');
  });
});

describe('处置约束与公平性', () => {
  it('Behavior 单独不能推到高风险，强度上限为中等', () => {
    const behavior = ['A', 'B', 'C'].map((code) =>
      sig(code, { analyzer: 'behavior', strength: 'strong', confidence: 1, basisSource: 'paypal_record', id: code }),
    );
    const r = decide(input('damaged', [identityMatch, ...behavior, ...behavior.map((b) => ({ ...b, id: `${b.id}2` }))]));
    expect(r.level).not.toBe('high');
    expect(r.findings.filter((f) => f.analyzer === 'behavior').every((f) => f.strength === 'moderate')).toBe(true);

    const onlyBehavior = decide(input('damaged', behavior.flatMap((b) => [b, { ...b, id: `${b.id}2` }, { ...b, id: `${b.id}3` }])));
    expect(onlyBehavior.score).toBeLessThan(3);
    expect(onlyBehavior.level).not.toBe('high');
  });

  it('已达成合意 → 不再建议反驳', () => {
    const r = decide(
      input('damaged', [sig('IDENTITY_MISMATCH', { strength: 'strong' })], {
        claim: { type: 'damaged', hasDispute: true, amount: 100, currency: 'USD', alreadyAgreed: true },
      }),
    );
    expect(r.primaryAction.type).toBe('accept_claim');
    expect(r.alternatives.map((a) => a.type)).not.toContain('provide_evidence');
  });

  it('私下退款请求高风险时不会建议 provide_evidence', () => {
    const r = decide(
      input('damaged', [sig('EVIDENCE_REUSED_ACROSS_CLAIMS', { strength: 'strong', basisSource: 'uploaded' })], {
        claim: { type: 'damaged', hasDispute: false, amount: 100, currency: 'USD', alreadyAgreed: false },
      }),
    );
    expect(r.level).toBe('high');
    expect(r.primaryAction.type).toBe('send_message');
  });

  it('发给买家的草稿不出现指控性措辞', () => {
    const scenarios = [
      decide(input('damaged', [sig('AI_PROVENANCE_FOUND', { strength: 'strong' })])),
      decide(input('damaged', [sig('SYNTHETIC_LIKELY', { analyzer: 'synthetic' })])),
      decide(input('damaged', [sig('NARRATIVE_EVIDENCE_CONFLICT', { analyzer: 'consistency' })])),
      decide(input('damaged', [], { evidence: [], hasReference: false })),
      decide(input('missing_items', [sig('WEIGHT_MISMATCH', { analyzer: 'logistics', basisSource: 'carrier_api' })])),
    ];
    for (const r of scenarios) {
      for (const a of [r.primaryAction, ...r.alternatives]) {
        const toBuyer = `${a.message ?? ''}${a.type === 'make_offer' ? (a.notes ?? '') : ''}`;
        expect(toBuyer).not.toMatch(/欺诈|伪造|造假|骗|虚假/);
      }
    }
  });

  it('同样的输入得到同样的输出（确定性）', () => {
    const a = decide(input('damaged', [identityMatch]));
    const b = decide(input('damaged', [identityMatch]));
    expect(a).toEqual(b);
  });
});
