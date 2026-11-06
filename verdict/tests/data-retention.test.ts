// 数据最小化：证据原件按保留期删除、按索赔删除全部数据、删除后的争议不会被同步导回。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-retention-test-'));
process.env.VERDICT_DATA_DIR = dir;
delete process.env.LLM_API_KEY;
delete process.env.LLM_PROVIDER;

let repo: typeof import('@/server/repo');
let settings: typeof import('@/server/settings');
let retention: typeof import('@/server/data-retention');
let pipeline: typeof import('@/server/pipeline');
let sync: typeof import('@/server/paypal-sync');
let db: typeof import('@/server/db');
let merchantId: string;

const DAY = 24 * 3600 * 1000;
const fileExists = (hash: string) => fs.existsSync(path.join(dir, 'evidence', hash));

beforeAll(async () => {
  const { seedDemo } = await import('@/demo/seed');
  repo = await import('@/server/repo');
  settings = await import('@/server/settings');
  retention = await import('@/server/data-retention');
  pipeline = await import('@/server/pipeline');
  sync = await import('@/server/paypal-sync');
  db = await import('@/server/db');
  await seedDemo();
  merchantId = repo.defaultMerchantId()!;
}, 120000);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

type Row = { id: string; sha256: string; claim_id: string | null; source: string; purged_at: string | null; status: string | null };
function evidenceRows(): Row[] {
  return db
    .db()
    .prepare('SELECT e.id, e.sha256, e.claim_id, e.source, e.purged_at, c.status FROM evidence e LEFT JOIN claims c ON c.id = e.claim_id')
    .all() as unknown as Row[];
}

describe('证据保留期', () => {
  it('没有设置保留期时什么都不删', () => {
    expect(retention.purgeExpiredEvidence(merchantId, Date.now() + 1000 * DAY)).toEqual({ evidence: 0, files: 0 });
  });

  it('只删已结案索赔的买家证据原件，保留行、哈希和判定；还被其他证据引用的文件不删', () => {
    // 种子数据里有证据的索赔都没结案，先结掉几笔没有争议的。
    const withEvidence = db
      .db()
      .prepare("SELECT DISTINCT c.id FROM claims c JOIN evidence e ON e.claim_id = c.id WHERE c.paypal_dispute_id IS NULL AND e.source != 'reference' LIMIT 3")
      .all() as unknown as { id: string }[];
    for (const c of withEvidence) db.db().prepare("UPDATE claims SET status = 'closed' WHERE id = ?").run(c.id);
    const before = evidenceRows();
    const closedEvidence = before.filter((r) => r.status === 'closed' && r.source !== 'reference');
    expect(closedEvidence.length).toBeGreaterThan(0);
    const verdictsBefore = db.db().prepare('SELECT COUNT(*) AS n FROM verdicts').get() as { n: number };

    expect(settings.updateSettings(merchantId, { retentionDays: 30 }).ok).toBe(true);
    // 刚上传的证据还没到期。
    const result = retention.purgeExpiredEvidence(merchantId, Date.now() + 400 * DAY);
    expect(result.evidence).toBe(closedEvidence.length);

    const after = evidenceRows();
    expect(after).toHaveLength(before.length);
    for (const r of after) {
      const shouldPurge = r.status === 'closed' && r.source !== 'reference';
      expect(!!r.purged_at).toBe(shouldPurge);
      const stillNeeded = after.some((o) => o.sha256 === r.sha256 && !o.purged_at);
      expect(fileExists(r.sha256)).toBe(stillNeeded);
    }
    expect((db.db().prepare('SELECT COUNT(*) AS n FROM verdicts').get() as { n: number }).n).toBe(verdictsBefore.n);
  });

  it('原件删除后不能重新分析，原来的信号保留', async () => {
    const claimId = evidenceRows().find((r) => r.purged_at)!.claim_id!;
    const signals = repo.claimSignals(claimId).map((s) => s.id);
    expect(pipeline.hasPurgedEvidence(claimId)).toBe(true);
    await pipeline.runAnalysis(claimId, { offline: true });
    expect(repo.claimSignals(claimId).map((s) => s.id)).toEqual(signals);
    expect(repo.claimTimeline(claimId).some((t) => t.title === '跳过重新分析')).toBe(true);
  });

  it('索赔详情里能看出原件已删除', () => {
    const claimId = evidenceRows().find((r) => r.purged_at)!.claim_id!;
    expect(repo.claimDetail(claimId)!.evidence.every((e) => e.purgedAt)).toBe(true);
  });
});

describe('按索赔删除数据', () => {
  it('PayPal 争议没结案时拒绝删除', () => {
    const open = db.db().prepare("SELECT id FROM claims WHERE paypal_dispute_id IS NOT NULL AND status != 'closed' LIMIT 1").get() as { id: string };
    const res = retention.deleteClaimData(open.id, 'demo-owner');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
    expect(repo.getClaim(open.id)).toBeDefined();
  });

  it('有结果不明的动作时拒绝删除', () => {
    const claim = db.db().prepare('SELECT id FROM claims WHERE paypal_dispute_id IS NULL LIMIT 1').get() as { id: string };
    const verdict = repo.latestVerdict(claim.id)!;
    db.db()
      .prepare("INSERT INTO actions (id, claim_id, verdict_id, type, payload, confirmed_by, confirmed_at, status) VALUES ('a-unknown', ?, ?, 'refund', '{}', 'demo-owner', ?, 'unknown')")
      .run(claim.id, verdict.id, db.nowIso());
    const res = retention.deleteClaimData(claim.id, 'demo-owner');
    expect(res.ok).toBe(false);
    db.db().prepare("DELETE FROM actions WHERE id = 'a-unknown'").run();
  });

  it('删除索赔的全部数据，订单保留；留一条不含内容的删除记录；同步不会把争议导回来', () => {
    const claim = db.db().prepare('SELECT * FROM claims WHERE paypal_dispute_id IS NOT NULL LIMIT 1').get() as unknown as import('@/server/repo').ClaimRow;
    db.db().prepare("UPDATE claims SET status = 'closed' WHERE id = ?").run(claim.id);
    const hashes = (db.db().prepare('SELECT sha256 FROM evidence WHERE claim_id = ?').all(claim.id) as unknown as { sha256: string }[]).map((r) => r.sha256);

    const res = retention.deleteClaimData(claim.id, 'demo-owner');
    expect(res.ok).toBe(true);
    for (const table of ['claims', 'evidence', 'signals', 'verdicts', 'actions', 'timeline_events', 'analysis_runs', 'challenges', 'portal_tokens']) {
      const column = table === 'claims' ? 'id' : 'claim_id';
      const n = db.db().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(claim.id) as { n: number };
      expect(n.n, table).toBe(0);
    }
    expect(repo.getOrder(claim.order_id)).toBeDefined();
    for (const hash of hashes) {
      const used = db.db().prepare('SELECT 1 FROM evidence WHERE sha256 = ? AND purged_at IS NULL').get(hash);
      expect(fileExists(hash)).toBe(!!used);
    }

    const record = retention.deletionLog().find((r) => r.claimId === claim.id)!;
    expect(record).toMatchObject({ disputeId: claim.paypal_dispute_id, deletedBy: 'demo-owner' });
    expect(JSON.stringify(record)).not.toContain(claim.narrative ?? '\u0000');

    const view = {
      id: claim.paypal_dispute_id!,
      orderId: null,
      transactionIds: [],
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      stage: 'INQUIRY',
      dueAt: null,
      updatedAt: null,
      buyerMessage: null,
      messages: [],
      amount: 10,
      currency: 'USD',
      buyerName: null,
      item: null,
      allowedActions: [],
      offerTypes: [],
      submittedEvidenceTypes: [],
      outcome: null,
      sandboxTools: { requireEvidence: false, adjudicate: false },
      log: [],
    };
    expect(sync.upsertClaimFromDispute(view)).toMatchObject({ outcome: 'skipped' });
    expect(db.db().prepare('SELECT 1 FROM claims WHERE paypal_dispute_id = ?').get(view.id)).toBeUndefined();
  });

  it('不存在的索赔返回 404', () => {
    const res = retention.deleteClaimData('nope', 'demo-owner');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });
});
