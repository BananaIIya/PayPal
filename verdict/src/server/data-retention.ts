// 数据最小化（开发文档“安全与隐私·数据最小化”）：
// 原始证据文件按商家设置的保留期到期删除；提供按索赔删除全部数据的接口。
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, db, kvGet, kvSet, nowIso, tx } from './db';
import { isAnalysisRunning } from './pipeline';
import { getClaim, getOrder, merchantSettings } from './repo';

function evidenceFile(hash: string): string | null {
  return /^[0-9a-f]{64}$/.test(hash) ? path.join(dataDir(), 'evidence', hash) : null;
}

/** 没有任何证据行还需要这个文件时才删。同一张图可能被多笔索赔引用（复用检测就是这种情况）。 */
function removeUnreferencedFiles(hashes: Iterable<string>): number {
  let removed = 0;
  for (const hash of new Set(hashes)) {
    const stillUsed = db().prepare('SELECT 1 FROM evidence WHERE sha256 = ? AND purged_at IS NULL LIMIT 1').get(hash);
    if (stillUsed) continue;
    const file = evidenceFile(hash);
    if (file && fs.existsSync(file)) {
      fs.rmSync(file);
      removed += 1;
    }
    // 缓存里是从这张图提取的属性，原件删了它也该删。
    if (!db().prepare('SELECT 1 FROM evidence WHERE sha256 = ? LIMIT 1').get(hash)) {
      db().prepare('DELETE FROM provider_cache WHERE sha256 = ?').run(hash);
    }
  }
  return removed;
}

export interface PurgeResult {
  evidence: number;
  files: number;
}

/**
 * 删除已结案索赔里超过保留期的买家证据原件。
 * 只删文件，证据行、SHA-256、感知哈希、信号和判定都保留：报告和审计仍然完整，复用检测也还能比对。
 * 商家留底照是比对基准，不在范围内。
 */
export function purgeExpiredEvidence(merchantId: string, now = Date.now()): PurgeResult {
  const days = merchantSettings(merchantId).retentionDays;
  if (!days) return { evidence: 0, files: 0 };
  const cutoff = new Date(now - days * 24 * 3600 * 1000).toISOString();
  const rows = db()
    .prepare(
      `SELECT e.id, e.sha256 FROM evidence e JOIN claims c ON c.id = e.claim_id
       WHERE c.merchant_id = ? AND c.status = 'closed' AND e.source != 'reference'
         AND e.purged_at IS NULL AND e.created_at < ?`,
    )
    .all(merchantId, cutoff) as unknown as { id: string; sha256: string }[];
  if (rows.length === 0) return { evidence: 0, files: 0 };
  const at = new Date(now).toISOString();
  tx(() => {
    const mark = db().prepare('UPDATE evidence SET purged_at = ? WHERE id = ?');
    for (const r of rows) mark.run(at, r.id);
  });
  return { evidence: rows.length, files: removeUnreferencedFiles(rows.map((r) => r.sha256)) };
}

const PURGE_INTERVAL_MS = 3600 * 1000;
const g = globalThis as unknown as { __verdictPurgedAt?: number };

/** 每次请求都会调用，但一小时最多真正执行一次。 */
export function purgeIfDue(): void {
  if (g.__verdictPurgedAt && Date.now() - g.__verdictPurgedAt < PURGE_INTERVAL_MS) return;
  g.__verdictPurgedAt = Date.now();
  const merchants = db().prepare('SELECT id FROM merchants').all() as unknown as { id: string }[];
  for (const m of merchants) {
    try {
      purgeExpiredEvidence(m.id);
    } catch (e) {
      console.error('[verdict] Failed to delete evidence past the retention period', e instanceof Error ? e.message : e);
    }
  }
}

export interface DeletionRecord {
  claimId: string;
  disputeId: string | null;
  orderNo: string;
  deletedAt: string;
  deletedBy: string;
  evidence: number;
}

const DELETION_LOG = 'deletion_log';

/** 删除记录只留编号和时间，不含买家的任何内容。也用来阻止同步把已删除的争议重新导入。 */
export function deletionLog(): DeletionRecord[] {
  return kvGet<DeletionRecord[]>(DELETION_LOG) ?? [];
}

export function isDeletedDispute(disputeId: string): boolean {
  return deletionLog().some((r) => r.disputeId === disputeId);
}

export type DeleteResult = { ok: true; record: DeletionRecord; files: number } | { ok: false; status: number; error: string };

/**
 * 按索赔删除全部数据：买家陈述、证据文件、挑战码、索赔页 token、信号、分析记录、判定、动作记录、时间线。
 * 订单和双方消息属于订单，不随索赔删除。
 */
export function deleteClaimData(claimId: string, deletedBy: string): DeleteResult {
  const claim = getClaim(claimId);
  if (!claim) return { ok: false, status: 404, error: 'Claim not found' };
  if (claim.paypal_dispute_id && claim.status !== 'closed') {
    return { ok: false, status: 409, error: 'The PayPal dispute is not closed yet. After deleting, you can no longer respond to this dispute in Verdict. Delete it after the dispute closes.' };
  }
  const inFlight = db().prepare("SELECT 1 FROM actions WHERE claim_id = ? AND status IN ('pending', 'unknown') LIMIT 1").get(claimId);
  if (inFlight) return { ok: false, status: 409, error: 'There is an action with an unknown result or still running. Reconcile it in the action history before deleting.' };
  if (isAnalysisRunning(claimId)) return { ok: false, status: 409, error: 'Analysis is still running. Try deleting again later.' };

  const order = getOrder(claim.order_id);
  const conn = db();
  const evidence = conn.prepare('SELECT sha256 FROM evidence WHERE claim_id = ?').all(claimId) as unknown as { sha256: string }[];
  const record: DeletionRecord = {
    claimId,
    disputeId: claim.paypal_dispute_id,
    orderNo: order?.order_no ?? '',
    deletedAt: nowIso(),
    deletedBy,
    evidence: evidence.length,
  };
  tx(() => {
    // 顺序按外键：动作引用判定，其余都引用索赔。
    for (const table of ['actions', 'verdicts', 'signals', 'analysis_runs', 'timeline_events', 'challenges', 'portal_tokens', 'evidence']) {
      conn.prepare(`DELETE FROM ${table} WHERE claim_id = ?`).run(claimId);
    }
    // webhook 原文里有争议详情（含买家消息），也要删。
    if (claim.paypal_dispute_id) conn.prepare('DELETE FROM paypal_events WHERE resource_id = ?').run(claim.paypal_dispute_id);
    conn.prepare('DELETE FROM claims WHERE id = ?').run(claimId);
    kvSet(DELETION_LOG, [...deletionLog(), record]);
  });
  return { ok: true, record, files: removeUnreferencedFiles(evidence.map((e) => e.sha256)) };
}

