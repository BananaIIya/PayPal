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
      ['challenge_pending', 0.9],
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
    'IMAGE_FOUND_ONLINE',
    'EVIDENCE_REUSED_ACROSS_CLAIMS',
    'RECORD_NOT_FOUND',
    'SCREENSHOT_CONTENT_MISMATCH',
    'AI_PROVENANCE_FOUND',
  ])('硬规则 %s → 高风险，不被支持信号抵消，且在 Q 低时也不降级', (code) => {
    const hard = sig(code, { strength: 'strong', basisSource: 'uploaded' });
    const offset = sig('Y', { direction: 'supports_claim', strength: 'strong', confidence: 1 });
    const r = decide(input('damaged', [hard, offset, identityMatch], { evidence: [] }));
    expect(r.score).toBeLessThan(1);
    expect(r.level).toBe('high');
    expect(r.findings[0].code).toBe(code);
    expect(r.findings[0].hardRule).toBe(true);
  });

  it('未核验的来源声明不判高风险，至少中风险，并建议要原图', () => {
    const one = sig('PROVENANCE_CLAIM_UNVERIFIED', {
      analyzer: 'provenance',
      direction: 'contradicts_claim',
      strength: 'moderate',
      confidence: 0.7,
      evidenceIds: ['e1'],
      basisSource: 'live_capture',
    });
    const r = decide(input('damaged', [identityMatch, one], { evidence: [...LIVE_SHOTS, REF] }));
    expect(r.level).toBe('medium');
    expect(r.findings.find((f) => f.code === 'PROVENANCE_CLAIM_UNVERIFIED')!.hardRule).toBe(false);
    expect(r.headline).toContain('Unverified provenance claim');
    expect(r.primaryAction.label).toBe('Ask buyer for original photo');
    expect(r.notices.join()).toContain('cannot be used to refute the claim');
    expect([r.primaryAction, ...r.alternatives].map((a) => a.type)).not.toContain('refund');
    expect([r.primaryAction, ...r.alternatives].map((a) => a.type)).not.toContain('accept_claim');
    expect(r.notices.join()).toContain('will not run');

    const many = Array.from({ length: 8 }, (_, i) => ({ ...one, id: `p${i}` }));
    expect(decide(input('damaged', many, { evidence: [...LIVE_SHOTS, REF] })).level).not.toBe('high');
  });

  it('文件声明由 AI 从零生成：相册上传也判高风险，任何渠道都不建议退款', () => {
    const album: EvidenceRef[] = ['overall', 'damage_closeup', 'package', 'label'].map((shot, i) => ({
      id: `u${i}`,
      source: 'uploaded',
      layer: 'C',
      shotLabel: shot,
    }));
    const generated = sig('AI_PROVENANCE_FOUND', {
      analyzer: 'provenance',
      strength: 'strong',
      confidence: 0.9,
      evidenceIds: ['u1'],
      basisSource: 'uploaded',
    });
    for (const hasDispute of [true, false]) {
      const base = input('damaged', [generated], { evidence: [...album, REF] });
      const r = decide({ ...base, claim: { ...base.claim, hasDispute } });
      expect(r.level).toBe('high');
      expect(r.findings.find((f) => f.code === 'AI_PROVENANCE_FOUND')!.hardRule).toBe(true);
      expect(r.headline).toBe('File declares it was fully AI-generated');
      expect(r.notices.join()).toContain('fully generated by AI');
      expect(r.notices.join()).not.toContain('cannot be used to refute the claim');
      expect(r.propositions.find((p) => p.id === 'damage_exists')!.refutingSignalIds).toContain('AI_PROVENANCE_FOUND');
      const types = [r.primaryAction, ...r.alternatives].map((a) => a.type);
      expect(types).not.toContain('refund');
      expect(types).not.toContain('accept_claim');
    }
  });

  it('来源声明只在非关键镜头上时也不判低风险，建议要原图', () => {
    const r = decide(
      input('damaged', [
        { ...identityMatch, evidenceIds: ['e1'] },
        sig('PROVENANCE_CLAIM_UNVERIFIED', {
          analyzer: 'provenance',
          direction: 'contradicts_claim',
          strength: 'moderate',
          confidence: 0.7,
          evidenceIds: ['e0'],
          basisSource: 'live_capture',
        }),
      ]),
    );
    expect(r.level).toBe('medium');
    expect(r.primaryAction.label).toBe('Ask buyer for original photo');
    expect([r.primaryAction, ...r.alternatives].map((a) => a.type)).not.toContain('accept_claim');
    expect([r.primaryAction, ...r.alternatives].map((a) => a.type)).not.toContain('refund');
  });

  it('现场拍摄的序列号明显不符时判高风险，但仍先排查错发', () => {
    const r = decide(input('damaged', [sig('IDENTITY_MISMATCH', { strength: 'strong', confidence: 0.95 })]));
    expect(r.dataConfidence).toBeGreaterThanOrEqual(0.5);
    expect(r.level).toBe('high');
    expect(r.findings.find((f) => f.code === 'IDENTITY_MISMATCH')!.hardRule).toBe(false);
    expect(r.headline).toContain('check for a wrong shipment first');
    expect(r.primaryAction.label).toBe('Check for a wrong shipment first');
    expect(r.primaryAction.type).toBe('none');
    expect(r.primaryAction.paypalOperation).toBeNull();
    expect(r.alternatives.map((a) => a.type)).toContain('accept_claim');
    expect(r.notices.join()).not.toContain('will not run');
    expect(r.notices.join()).toContain('warehouse shipping error');
    expect(r.ruleTrace.join()).toContain('do not contest directly');
  });

  it('相册上传的序列号不符不升到高风险', () => {
    const r = decide(input('damaged', [sig('IDENTITY_MISMATCH', { strength: 'strong', confidence: 0.95, basisSource: 'uploaded' })]));
    expect(r.level).toBe('medium');
    expect(r.primaryAction.label).toBe('Check for a wrong shipment first');
  });

  describe('序列号不符时的退款口子只对够硬的证据开放', () => {
    const mismatch = (over: Partial<Signal> = {}) => sig('IDENTITY_MISMATCH', { strength: 'strong', confidence: 0.95, ...over });
    const payoutTypes = (r: ReturnType<typeof decide>) => [r.primaryAction, ...r.alternatives].map((a) => a.type);

    it('现场拍摄、核验完整、没有伪造类反证：允许按错发退款', () => {
      const r = decide(input('damaged', [mismatch()]));
      expect(r.identityRefund).toBe(true);
      expect(payoutTypes(r)).toContain('accept_claim');
    });

    it('相册上传的序列号：不开放退款', () => {
      const r = decide(input('damaged', [mismatch({ basisSource: 'uploaded' })]));
      expect(r.identityRefund).toBe(false);
      expect(payoutTypes(r)).not.toContain('accept_claim');
      expect(payoutTypes(r)).not.toContain('refund');
      expect(r.primaryAction.reason).toContain('cannot justify a refund');
    });

    it('同一张图带 AI 来源声明（可以伪造成“修图”）：不开放退款', () => {
      const r = decide(
        input('damaged', [mismatch(), sig('PROVENANCE_CLAIM_UNVERIFIED', { analyzer: 'provenance', strength: 'moderate', confidence: 0.7 })]),
      );
      expect(r.identityRefund).toBe(false);
      expect(payoutTypes(r)).not.toContain('accept_claim');
    });

    it('AI 检测器没跑（核验不完整）：不开放退款', () => {
      const base = input('damaged', [mismatch()]);
      const r = decide({ ...base, runs: base.runs.map((x) => (x.analyzer === 'synthetic' ? { ...x, status: 'unavailable' as const } : x)) });
      expect(r.identityRefund).toBe(false);
      expect(payoutTypes(r)).not.toContain('accept_claim');
    });

    it('有翻拍或挑战码不符这类伪造反证：不开放退款', () => {
      for (const code of ['SCREEN_RECAPTURE', 'CHALLENGE_MISMATCH', 'SYNTHETIC_LIKELY']) {
        const r = decide(input('damaged', [mismatch(), sig(code, { id: code, evidenceIds: ['e1'] })]));
        expect(r.identityRefund, code).toBe(false);
      }
    });
  });

  it('序列号不符但数据置信度不足时保持中风险', () => {
    const r = decide(
      input('damaged', [sig('IDENTITY_MISMATCH', { strength: 'strong', confidence: 0.95 })], {
        evidence: [{ id: 'e0', source: 'live_capture', layer: 'B', shotLabel: 'serial_closeup' }],
      }),
    );
    expect(r.dataConfidence).toBeLessThan(0.5);
    expect(r.level).toBe('medium');
    expect(r.primaryAction.label).toBe('Check for a wrong shipment first');
  });

  it('多份证据互相矛盾不判高风险，支持信号也不能把它降到低风险', () => {
    const cross = sig('CROSS_EVIDENCE_CONTRADICTION', { strength: 'strong', confidence: 0.88, basisSource: 'uploaded' });
    const alone = decide(input('damaged', [cross]));
    expect(alone.score).toBeLessThan(3);
    expect(alone.level).toBe('medium');
    expect(alone.findings[0].hardRule).toBe(false);
    expect(alone.primaryAction.label).toBe('Ask buyer to explain');

    const offset = sig('Y', { direction: 'supports_claim', strength: 'strong', confidence: 1 });
    const lowered = decide(input('damaged', [cross, offset, identityMatch], { evidence: [] }));
    expect(lowered.score).toBeLessThan(1);
    expect(lowered.level).toBe('medium');
  });

  it('强支持可以抵消序列号不符的分数，但判定不低于中风险', () => {
    const r = decide(
      input(
        'damaged',
        [
          sig('IDENTITY_MISMATCH', { strength: 'strong', confidence: 0.95, evidenceIds: ['e0'] }),
          sig('SUPPORT', { id: 'sup', direction: 'supports_claim', strength: 'strong', confidence: 1, evidenceIds: ['e1'] }),
        ],
        { hasReference: false, evidence: LIVE_SHOTS },
      ),
    );
    expect(r.score).toBeLessThan(1);
    expect(r.level).toBe('medium');
    expect(r.ruleTrace.join()).toContain('merchant fulfillment error');
    expect(r.primaryAction.label).toBe('Check for a wrong shipment first');
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
    expect(r.primaryAction.label).toBe('Ask buyer for live photos');
  });

  it('陈述与画面冲突 → 中风险，建议澄清', () => {
    const r = decide(input('damaged', [sig('NARRATIVE_EVIDENCE_CONFLICT', { analyzer: 'consistency', basisSource: 'uploaded' }), identityMatch]));
    expect(r.level).toBe('medium');
    expect(r.primaryAction.label).toBe('Ask buyer to clarify');
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
    expect(r.level).toBe('low');
    expect(r.primaryAction.type).toBe('accept_claim');
    expect(r.primaryAction.reason).toContain('postal code');
    expect(r.primaryAction.type).not.toBe('provide_evidence');
    expect(r.alternatives.map((a) => a.type)).not.toContain('provide_evidence');
    expect(r.notices.join()).toContain('does not prove delivery');
  });

  it('单号早于订单时不因此退款；来源声明未验证时也不退', () => {
    const early = sig('SHIPPED_BEFORE_ORDER', {
      analyzer: 'logistics',
      direction: 'supports_claim',
      strength: 'strong',
      confidence: 0.95,
      basisSource: 'carrier_api',
    });
    const alone = decide(input('not_received', [early], { hasReference: false }));
    expect(alone.level).toBe('insufficient');
    expect([alone.primaryAction, ...alone.alternatives].map((a) => a.type)).not.toContain('refund');
    expect([alone.primaryAction, ...alone.alternatives].map((a) => a.type)).not.toContain('accept_claim');
    expect(alone.notices.join()).toContain('does not prove delivery');

    const withProvenance = decide(
      input('not_received', [
        early,
        sig('PROVENANCE_CLAIM_UNVERIFIED', {
          analyzer: 'provenance',
          direction: 'contradicts_claim',
          strength: 'moderate',
          confidence: 0.7,
          basisSource: 'uploaded',
        }),
      ], { hasReference: false }),
    );
    expect(withProvenance.level).toBe('medium');
    expect(withProvenance.primaryAction.type).toBe('send_message');
    expect([withProvenance.primaryAction, ...withProvenance.alternatives].map((a) => a.type)).not.toContain('accept_claim');
  });

  it('物流未签收或状态不明时不退款', () => {
    const transit = decide(
      input('not_received', [
        sig('TRACKING_NOT_DELIVERED', {
          analyzer: 'logistics',
          direction: 'supports_claim',
          strength: 'moderate',
          confidence: 0.9,
          basisSource: 'carrier_api',
        }),
      ], { hasReference: false }),
    );
    expect(transit.level).toBe('insufficient');
    expect([transit.primaryAction, ...transit.alternatives].map((a) => a.type)).not.toContain('refund');
    expect([transit.primaryAction, ...transit.alternatives].map((a) => a.type)).not.toContain('accept_claim');
    expect(transit.notices.join()).toContain('cannot justify a refund');

    const unknown = decide(
      input('not_received', [
        sig('TRACKING_STATUS_UNKNOWN', { analyzer: 'logistics', direction: 'neutral', strength: 'weak', confidence: 0.5, basisSource: 'carrier_api' }),
      ], { hasReference: false }),
    );
    expect(unknown.level).toBe('insufficient');
    expect([unknown.primaryAction, ...unknown.alternatives].map((a) => a.type)).not.toContain('accept_claim');
  });

  it('少件称重正常且现场照片齐全时才建议部分退款', () => {
    const shots: EvidenceRef[] = ['package', 'label', 'contents'].map((shot, i) => ({
      id: `e${i}`,
      source: 'live_capture',
      layer: 'B',
      shotLabel: shot,
    }));
    const weight = sig('WEIGHT_MISMATCH', { analyzer: 'logistics', basisSource: 'carrier_api' });
    const ready = decide(input('missing_items', [weight], { evidence: shots }));
    expect(ready.level).toBe('medium');
    expect(ready.primaryAction.type).toBe('make_offer');

    const album = shots.map((e) => ({ ...e, source: 'uploaded' as const, layer: 'C' as const }));
    const unverified = decide(input('missing_items', [weight], { evidence: album }));
    expect(unverified.primaryAction.type).not.toBe('make_offer');
    expect([unverified.primaryAction, ...unverified.alternatives].map((a) => a.type)).not.toContain('refund');
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
    expect(r.notices.join()).toContain('returns not required');
    expect(r.notices.join()).toContain('between delivery and the first report');
    expect(r.primaryAction.reason).toMatch(/returns not required/i);
  });

  it('可退货的易腐商品也提示看签收到首次反馈的间隔', () => {
    const r = decide(input('damaged', [identityMatch], { policy: { ...POLICY, returnable: true, perishable: true } }));
    expect(r.notices.join()).toContain('between delivery and the first report');
    expect(r.notices.join()).not.toMatch(/returns not required/i);
  });

  it('安全敏感类目 → 先提示按安全事件处理', () => {
    const r = decide(input('damaged', [identityMatch], { policy: { ...POLICY, safetySensitive: true } }));
    expect(r.notices[0]).toContain('safety incident');
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
    expect(r.level).not.toBe('low');
    expect([r.primaryAction, ...r.alternatives].map((a) => a.type)).not.toContain('refund');
    expect([r.primaryAction, ...r.alternatives].map((a) => a.type)).not.toContain('accept_claim');
    expect(r.notices.join()).toContain('will not run');
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
    expect(r.primaryAction.message).toContain('Whole item');
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
    expect([r.primaryAction, ...r.alternatives].map((a) => a.type)).not.toContain('refund');
    expect([r.primaryAction, ...r.alternatives].map((a) => a.type)).not.toContain('make_offer');
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

  it('证据不足但双方已同意退款时，仍然建议退款', () => {
    const evidence: EvidenceRef[] = ['overall', 'damage_closeup', 'package', 'label'].map((shot, i) => ({
      id: `e${i}`,
      source: 'uploaded' as const,
      layer: 'C' as const,
      shotLabel: shot,
    }));
    const r = decide(
      input('damaged', [], {
        evidence,
        hasReference: false,
        claim: { type: 'damaged', hasDispute: true, amount: 100, currency: 'USD', alreadyAgreed: true },
      }),
    );
    expect(r.level).toBe('insufficient');
    expect(r.primaryAction.type).toBe('accept_claim');
    expect(r.notices.join()).not.toContain('will not run');
  });

  it('商家答应过退款，但命中硬规则：不按已同意处理，不建议退款', () => {
    const r = decide(
      input('damaged', [sig('AI_PROVENANCE_FOUND', { analyzer: 'provenance', strength: 'strong', confidence: 0.9, basisSource: 'uploaded' })], {
        claim: { type: 'damaged', hasDispute: true, amount: 100, currency: 'USD', alreadyAgreed: true },
      }),
    );
    expect(r.level).toBe('high');
    expect([r.primaryAction, ...r.alternatives].map((a) => a.type)).not.toContain('accept_claim');
    expect([r.primaryAction, ...r.alternatives].map((a) => a.type)).not.toContain('refund');
    expect(r.notices.join()).toContain('not treated as agreed');
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
    expect([r.primaryAction, ...r.alternatives].map((a) => a.type)).not.toContain('refund');
  });

  it('发给买家的草稿不出现指控性措辞', () => {
    const scenarios = [
      decide(input('damaged', [sig('PROVENANCE_CLAIM_UNVERIFIED', { direction: 'neutral', strength: 'moderate', confidence: 0.7, evidenceIds: ['e1'] })])),
      decide(input('damaged', [sig('SYNTHETIC_LIKELY', { analyzer: 'synthetic' })])),
      decide(input('damaged', [sig('NARRATIVE_EVIDENCE_CONFLICT', { analyzer: 'consistency' })])),
      decide(input('damaged', [], { evidence: [], hasReference: false })),
      decide(input('missing_items', [sig('WEIGHT_MISMATCH', { analyzer: 'logistics', basisSource: 'carrier_api' })])),
    ];
    for (const r of scenarios) {
      for (const a of [r.primaryAction, ...r.alternatives]) {
        const toBuyer = `${a.message ?? ''}${a.type === 'make_offer' ? (a.notes ?? '') : ''}`;
        expect(toBuyer).not.toMatch(/欺诈|伪造|造假|骗|虚假|fraud|forg|fake|scam|falsif/i);
      }
    }
  });

  it('同样的输入得到同样的输出（确定性）', () => {
    const a = decide(input('damaged', [identityMatch]));
    const b = decide(input('damaged', [identityMatch]));
    expect(a).toEqual(b);
  });
});
