// 带挑战编号上传时先保持待核验；画面里的码核对通过后才提升为 B 层。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EvidenceAttributes } from '@/providers/types';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-challenge-'));
process.env.VERDICT_DATA_DIR = dir;
delete process.env.LLM_API_KEY;
delete process.env.LLM_PROVIDER;

let repo: typeof import('@/server/repo');
let db: typeof import('@/server/db');
let ingest: typeof import('@/server/ingest');
let pipeline: typeof import('@/server/pipeline');
let storage: typeof import('@/server/storage');
let cachePut: typeof import('@/providers/registry').cachePut;

function attrs(code: string | null): EvidenceAttributes {
  return {
    objectCount: 1,
    color: null,
    model: null,
    serialNumber: null,
    damageLocation: null,
    packagingOpened: null,
    packagingIntact: null,
    challengeCodeSeen: code,
    screenRecapture: { likely: false, confidence: 0, cues: [] },
    physicalPlausibility: { plausible: true, confidence: 0.9, reason: '' },
    screenshot: { isScreenshot: false, orderNumber: null, amount: null, chatLines: [] },
    suspiciousRegion: null,
  };
}

beforeAll(async () => {
  repo = await import('@/server/repo');
  db = await import('@/server/db');
  ingest = await import('@/server/ingest');
  pipeline = await import('@/server/pipeline');
  storage = await import('@/server/storage');
  ({ cachePut } = await import('@/providers/registry'));
  db.db().prepare('INSERT INTO merchants (id, name, settings) VALUES (?, ?, ?)').run('m-ch', '挑战测试店', '{}');
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function capture(seen: string | null, issued = 'AB12') {
  const orderId = db.newId();
  db.db()
    .prepare(
      `INSERT INTO orders (id, merchant_id, order_no, items, category, amount, currency, created_at)
       VALUES (?, 'm-ch', ?, '[]', 'general', 20, 'USD', ?)`,
    )
    .run(orderId, `CH-${orderId.slice(0, 8)}`, db.nowIso());
  const claimId = ingest.createClaim({ merchantId: 'm-ch', orderId, origin: 'portal', type: 'damaged', status: 'analyzing' });
  const challengeId = db.newId();
  db.db()
    .prepare('INSERT INTO challenges (id, claim_id, shot_label, code, action, issued_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(challengeId, claimId, 'overall', issued, '把纸条放进画面', db.nowIso(), db.nowIso());
  const file = Buffer.from(`challenge-${claimId}-${seen ?? 'none'}`);
  const hash = storage.sha256(file);
  cachePut('vision', hash, 'test', attrs(seen));
  const saved = await repo.addEvidence({
    claimId,
    orderId,
    source: 'challenge_pending',
    file,
    mime: 'image/jpeg',
    shot: 'overall',
    challengeId,
  });
  const frameFile = Buffer.from(`frame-${claimId}`);
  cachePut('vision', storage.sha256(frameFile), 'test', attrs(seen));
  const frame = await repo.addEvidence({
    claimId,
    orderId,
    source: 'challenge_pending',
    file: frameFile,
    mime: 'image/jpeg',
    shot: 'overall',
    challengeId,
    kind: 'frame',
    parentId: saved.id,
  });
  await pipeline.runAnalysis(claimId, { offline: true });
  const rows = repo.claimEvidence(claimId);
  const codes = repo.claimSignals(claimId).map((s) => s.code);
  return {
    parent: rows.find((r) => r.id === saved.id)!,
    frame: rows.find((r) => r.id === frame.id)!,
    codes,
  };
}

describe('挑战拍摄', () => {
  it('码一致后提升为 B 层，并只把它当作可信度线索', async () => {
    const { parent, frame, codes } = await capture('AB12');
    expect(parent.source).toBe('live_capture');
    expect(parent.layer).toBe('B');
    expect(frame.source).toBe('live_capture');
    expect(frame.layer).toBe('B');
    expect(codes).toContain('CHALLENGE_MATCHED');
    expect(codes).not.toContain('CHALLENGE_MISSING');
  });

  it('画面里没有码时保持待核验', async () => {
    const { parent, frame, codes } = await capture(null);
    expect(parent.source).toBe('challenge_pending');
    expect(parent.layer).toBe('C');
    expect(frame.source).toBe('challenge_pending');
    expect(codes).toContain('CHALLENGE_MISSING');
    expect(codes).not.toContain('CHALLENGE_MATCHED');
  });

  it('码不一致时不提升，并记为不符', async () => {
    const { parent, codes } = await capture('ZZ99', 'AB12');
    expect(parent.source).toBe('challenge_pending');
    expect(parent.layer).toBe('C');
    expect(codes).toContain('CHALLENGE_MISMATCH');
    expect(codes).not.toContain('CHALLENGE_MATCHED');
  });
});
