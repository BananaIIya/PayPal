// 缺少比对依据时必须留在“无法核对”，不能写成一致或已签收到订单地址。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnalyzerContext, EvidenceRow } from '@/analyzers';
import type { EvidenceAttributes } from '@/providers/types';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-compare-'));
process.env.VERDICT_DATA_DIR = dir;
delete process.env.LLM_API_KEY;
delete process.env.LLM_PROVIDER;

let analyzers: typeof import('@/analyzers');
let cachePut: typeof import('@/providers/registry').cachePut;

function attrs(over: Partial<EvidenceAttributes> = {}): EvidenceAttributes {
  return {
    objectCount: null,
    color: null,
    model: null,
    serialNumber: null,
    damageLocation: null,
    packagingOpened: null,
    packagingIntact: null,
    challengeCodeSeen: null,
    screenRecapture: { likely: false, confidence: 0, cues: [] },
    physicalPlausibility: { plausible: true, confidence: 0.9, reason: '' },
    screenshot: { isScreenshot: false, orderNumber: null, amount: null, chatLines: [] },
    suspiciousRegion: null,
    ...over,
  };
}

function row(id: string, hash: string): EvidenceRow {
  return {
    id,
    claim_id: 'c1',
    order_id: 'o1',
    source: 'uploaded',
    sha256: hash,
    dhash: null,
    layer: 'C',
    mime_type: 'image/jpeg',
    shot_label: 'overall',
    challenge_id: null,
    created_at: '2026-01-02T00:00:00.000Z',
    kind: 'image',
  };
}

function context(over: Partial<AnalyzerContext> = {}): AnalyzerContext {
  return {
    claim: { id: 'c1', type: 'not_as_described', narrative: null, createdAt: '2026-01-02T00:00:00.000Z' },
    order: {
      id: 'o1',
      merchantId: 'm1',
      orderNo: 'NO-1',
      buyerEmailHash: null,
      shipAddress: { city: 'San Francisco', postalCode: '94107' },
      items: [{ sku: 'MUG', title: '杯子', quantity: 1 }],
      listingSnapshot: { title: '杯子' },
      amount: 40,
      carrier: 'UPS',
      trackingNumber: '1Z',
      shippedWeightG: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    evidence: [],
    references: [],
    challenges: new Map(),
    messages: [],
    merchantEvidence: [],
    knownOrderNumbers: new Set(['NO-1']),
    tracking: { name: '测试物流', async track() { return { status: 'delivered', events: [{ at: '2026-01-03T00:00:00.000Z', description: '已签收' }], deliveredAt: '2026-01-03T00:00:00.000Z', deliveredPostalCode: '94107' }; } },
    behavior: { buyerClaims: 0, similarNarrative: null, skuReasonClaims: 0, linkedAccounts: 0 },
    offline: true,
    ...over,
  };
}

beforeAll(async () => {
  analyzers = await import('@/analyzers');
  ({ cachePut } = await import('@/providers/registry'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('商品快照比对', () => {
  it('快照没有颜色和型号时，不能声称实物与快照一致', async () => {
    cachePut('vision', 'snap-buyer', 'test', attrs({ color: '黑色', model: 'M1' }));
    const out = await analyzers.ANALYZER_IMPL.reference(context({ evidence: [row('b1', 'snap-buyer')] }));
    expect(out.status).toBe('done');
    if (out.status !== 'done') return;
    const codes = out.signals.map((s) => s.code);
    expect(codes).toContain('SNAPSHOT_UNVERIFIED');
    expect(codes).not.toContain('SNAPSHOT_MATCH');
    expect(out.signals.find((s) => s.code === 'SNAPSHOT_UNVERIFIED')!.direction).toBe('neutral');
  });

  it('两边都有且不同的字段才记为不一致，不再另报无法核对', async () => {
    cachePut('vision', 'snap-diff', 'test', attrs({ color: '黑色', model: 'M1' }));
    const out = await analyzers.ANALYZER_IMPL.reference(
      context({
        evidence: [row('b2', 'snap-diff')],
        order: { ...context().order, listingSnapshot: { color: '藏青色', model: 'M1' } },
      }),
    );
    expect(out.status).toBe('done');
    if (out.status !== 'done') return;
    const diff = out.signals.find((s) => s.code === 'SNAPSHOT_DIFFERENCE')!;
    expect(diff.explanation).toContain('Color');
    expect(diff.explanation).toContain('藏青色');
    expect(diff.explanation).not.toContain('Model');
    expect(out.signals.map((s) => s.code)).not.toContain('SNAPSHOT_UNVERIFIED');
  });
});

describe('物流地址比对', () => {
  function logistics(zip: string | undefined, claimType: AnalyzerContext['claim']['type'] = 'not_received') {
    return analyzers.ANALYZER_IMPL.logistics(
      context({
        claim: { id: 'c1', type: claimType, narrative: null, createdAt: '2026-01-02T00:00:00.000Z' },
        tracking: {
          name: '测试物流',
          async track() {
            return {
              status: 'delivered' as const,
              events: [{ at: '2026-01-03T00:00:00.000Z', description: '已签收' }],
              deliveredAt: '2026-01-03T00:00:00.000Z',
              deliveredPostalCode: zip,
            };
          },
        },
      }),
    );
  }

  it('两边邮编一致才确认签收到订单地址', async () => {
    const out = await logistics('94107');
    expect(out.status).toBe('done');
    if (out.status !== 'done') return;
    const hit = out.signals.find((s) => s.code === 'DELIVERED_CONFIRMED')!;
    expect(hit.explanation).toContain('94107');
    expect(hit.explanation).not.toMatch(/unknown/i);
  });

  it('缺少签收邮编时保持无法核对', async () => {
    const out = await logistics(undefined);
    expect(out.status).toBe('done');
    if (out.status !== 'done') return;
    expect(out.signals.map((s) => s.code)).not.toContain('DELIVERED_CONFIRMED');
    expect(out.signals.find((s) => s.code === 'DELIVERY_ADDRESS_UNVERIFIED')!.direction).toBe('neutral');
  });

  it('邮编不同仍然是地址不符，不是已确认送达', async () => {
    const out = await logistics('10001');
    expect(out.status).toBe('done');
    if (out.status !== 'done') return;
    expect(out.signals.map((s) => s.code)).toContain('DELIVERY_ADDRESS_MISMATCH');
    expect(out.signals.map((s) => s.code)).not.toContain('DELIVERED_CONFIRMED');
    expect(out.signals.map((s) => s.code)).not.toContain('DELIVERY_ADDRESS_UNVERIFIED');
  });

  function at(createdAt: string, eventAt: string) {
    return analyzers.ANALYZER_IMPL.logistics(
      context({
        claim: { id: 'c1', type: 'not_received', narrative: null, createdAt },
        order: { ...context().order, createdAt },
        tracking: {
          name: '测试物流',
          async track() {
            return {
              status: 'delivered' as const,
              events: [{ at: eventAt, description: '揽收' }],
              deliveredAt: eventAt,
              deliveredPostalCode: '94107',
            };
          },
        },
      }),
    );
  }

  it('早几毫秒或刚好 1 分钟仍按签收邮编判断', async () => {
    for (const [createdAt, eventAt] of [
      ['2026-01-02T00:00:00.002Z', '2026-01-02T00:00:00.000Z'],
      ['2026-01-02T00:01:00.000Z', '2026-01-02T00:00:00.000Z'],
    ] as const) {
      const out = await at(createdAt, eventAt);
      expect(out.status).toBe('done');
      if (out.status !== 'done') return;
      expect(out.signals.map((s) => s.code)).toContain('DELIVERED_CONFIRMED');
      expect(out.signals.map((s) => s.code)).not.toContain('SHIPPED_BEFORE_ORDER');
    }
  });

  it('早过 1 分钟才认为单号不可能是这笔订单，说明里保留完整时间', async () => {
    const out = await at('2026-01-02T00:05:00.000Z', '2026-01-02T00:00:00.000Z');
    expect(out.status).toBe('done');
    if (out.status !== 'done') return;
    const hit = out.signals.find((s) => s.code === 'SHIPPED_BEFORE_ORDER')!;
    expect(hit.explanation).toContain('2026-01-02T00:00:00.000Z');
    expect(hit.explanation).toContain('2026-01-02T00:05:00.000Z');
    expect(out.signals.map((s) => s.code)).not.toContain('DELIVERED_CONFIRMED');
  });

  it('事件列表倒序时仍用最早的一条判断单号', async () => {
    const out = await analyzers.ANALYZER_IMPL.logistics(
      context({
        claim: { id: 'c1', type: 'not_received', narrative: null, createdAt: '2026-01-02T00:00:00.000Z' },
        order: { ...context().order, createdAt: '2026-01-02T00:10:00.000Z' },
        tracking: {
          name: '测试物流',
          async track() {
            return {
              status: 'delivered' as const,
              events: [
                { at: '2026-01-02T00:12:00.000Z', description: '已签收' },
                { at: '2026-01-02T00:00:00.000Z', description: '揽收' },
              ],
              deliveredAt: '2026-01-02T00:12:00.000Z',
              deliveredPostalCode: '94107',
            };
          },
        },
      }),
    );
    expect(out.status).toBe('done');
    if (out.status !== 'done') return;
    expect(out.signals.map((s) => s.code)).toContain('SHIPPED_BEFORE_ORDER');
    expect(out.signals.map((s) => s.code)).not.toContain('DELIVERED_CONFIRMED');
  });

  it('ZIP+4 和五位邮编写法不同仍算送到同一地址', async () => {
    const out = await logistics('94107-1234');
    expect(out.status).toBe('done');
    if (out.status !== 'done') return;
    expect(out.signals.map((s) => s.code)).toContain('DELIVERED_CONFIRMED');
    expect(out.signals.map((s) => s.code)).not.toContain('DELIVERY_ADDRESS_MISMATCH');
  });

  it('未签收或状态不明都不写成已确认送达', async () => {
    for (const status of ['in_transit', 'unknown'] as const) {
      const out = await analyzers.ANALYZER_IMPL.logistics(
        context({
          claim: { id: 'c1', type: 'not_received', narrative: null, createdAt: '2026-01-02T00:00:00.000Z' },
          tracking: {
            name: '测试物流',
            async track() {
              return { status, events: [{ at: '2026-01-03T00:00:00.000Z', description: '运输中' }], deliveredPostalCode: '94107' };
            },
          },
        }),
      );
      expect(out.status).toBe('done');
      if (out.status !== 'done') return;
      expect(out.signals.map((s) => s.code)).not.toContain('DELIVERED_CONFIRMED');
      expect(out.signals.map((s) => s.code)).toContain(status === 'in_transit' ? 'TRACKING_NOT_DELIVERED' : 'TRACKING_STATUS_UNKNOWN');
    }
  });
});
