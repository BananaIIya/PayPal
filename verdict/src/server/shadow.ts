// 影子模式（开发文档测试部分）：判定只记录、不展示，用来和商家自己的实际决定对比。
// 处理人员按自己的判断处理，事后把他们的决定和当时的判定对照，看系统在这家店的数据上靠不靠谱，再决定要不要正式启用。
import { LEVEL_LABEL } from '@/core/catalog';
import type { ActionType, VerdictLevel } from '@/core/types';
import { db, json } from './db';
import { actorLabel } from './auth';
import { shadowModeOn } from './repo';

export type Decision = 'refund' | 'offer' | 'contest' | 'ask' | 'review';

export const DECISION_LABEL: Record<Decision, string> = {
  refund: '退款',
  offer: '和解',
  contest: '反驳',
  ask: '沟通补证',
  review: '人工复核',
};

const DECISION_OF: Partial<Record<ActionType | 'none', Decision>> = {
  refund: 'refund',
  accept_claim: 'refund',
  make_offer: 'offer',
  provide_evidence: 'contest',
  escalate: 'contest',
  appeal: 'contest',
  provide_supporting_info: 'contest',
  send_message: 'ask',
  none: 'review',
};

export function decisionOf(type: string): Decision | null {
  return DECISION_OF[type as ActionType] ?? null;
}

/** 判定方向和人工决定完全相反：系统建议反驳而人工退款，或系统建议退款而人工反驳。 */
function opposite(system: Decision, merchant: Decision): boolean {
  return (system === 'contest' && merchant === 'refund') || (system === 'refund' && merchant === 'contest');
}

export interface ComparisonRow {
  claimId: string;
  orderNo: string;
  product: string;
  level: VerdictLevel;
  system: Decision;
  merchant: Decision;
  actionType: string;
  agree: boolean;
  opposite: boolean;
  shadow: boolean;
  decidedAt: string;
  decidedBy: string;
}

export interface ShadowComparison {
  shadowMode: boolean;
  /** 只统计影子模式下做的决定（处理人员没看到判定）。 */
  blindOnly: boolean;
  totalDecided: number;
  blindDecided: number;
  agree: number;
  agreementRate: number | null;
  opposite: number;
  /** 判定等级 × 人工决定。 */
  matrix: Record<VerdictLevel, Record<Decision, number>>;
  /** 按判定等级的一致率。 */
  byLevel: { level: VerdictLevel; label: string; total: number; agree: number }[];
  rows: ComparisonRow[];
}

const LEVELS: VerdictLevel[] = ['high', 'medium', 'insufficient', 'low'];
const DECISIONS: Decision[] = ['refund', 'offer', 'contest', 'ask', 'review'];

/**
 * 每笔索赔取一个“决定”：第一笔成功的退款、和解或反驳动作；没有的话取第一条消息。
 * 对照的是执行那个动作时的判定（动作记录里的 verdict_id），不是之后重新分析出来的判定。
 */
export function shadowComparison(merchantId: string, opts: { blindOnly?: boolean } = {}): ShadowComparison {
  const rows = db()
    .prepare(
      `SELECT a.claim_id, a.type, a.confirmed_by, a.confirmed_at, a.shadow, v.level, v.suggested_action, o.order_no, o.items
       FROM actions a
       JOIN claims c ON c.id = a.claim_id
       JOIN orders o ON o.id = c.order_id
       JOIN verdicts v ON v.id = a.verdict_id
       WHERE c.merchant_id = ? AND a.status = 'succeeded'
       ORDER BY a.confirmed_at`,
    )
    .all(merchantId) as unknown as {
    claim_id: string;
    type: string;
    confirmed_by: string;
    confirmed_at: string;
    shadow: number;
    level: VerdictLevel;
    suggested_action: string;
    order_no: string;
    items: string;
  }[];

  const decisive = new Map<string, (typeof rows)[number]>();
  const firstAsk = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const d = decisionOf(r.type);
    if (!d) continue;
    if (d === 'ask') {
      if (!firstAsk.has(r.claim_id)) firstAsk.set(r.claim_id, r);
    } else if (!decisive.has(r.claim_id)) decisive.set(r.claim_id, r);
  }
  for (const [id, r] of firstAsk) if (!decisive.has(id)) decisive.set(id, r);

  const all: ComparisonRow[] = [...decisive.values()].map((r) => {
    const merchant = decisionOf(r.type)!;
    const system = decisionOf(r.suggested_action) ?? 'review';
    return {
      claimId: r.claim_id,
      orderNo: r.order_no,
      product: json<{ title?: string }[]>(r.items, [])[0]?.title ?? '',
      level: r.level,
      system,
      merchant,
      actionType: r.type,
      agree: system === merchant,
      opposite: opposite(system, merchant),
      shadow: !!r.shadow,
      decidedAt: r.confirmed_at,
      decidedBy: actorLabel(r.confirmed_by),
    };
  });
  const blind = all.filter((r) => r.shadow);
  // 没有影子模式下的决定时退回统计全部，并在页面上说明。
  const blindOnly = opts.blindOnly ?? blind.length > 0;
  const used = (blindOnly ? blind : all).sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));

  const matrix = Object.fromEntries(LEVELS.map((l) => [l, Object.fromEntries(DECISIONS.map((d) => [d, 0]))])) as ShadowComparison['matrix'];
  for (const r of used) matrix[r.level][r.merchant] += 1;
  const agree = used.filter((r) => r.agree).length;
  return {
    shadowMode: shadowModeOn(merchantId),
    blindOnly,
    totalDecided: all.length,
    blindDecided: blind.length,
    agree,
    agreementRate: used.length ? agree / used.length : null,
    opposite: used.filter((r) => r.opposite).length,
    matrix,
    byLevel: LEVELS.map((level) => {
      const of = used.filter((r) => r.level === level);
      return { level, label: LEVEL_LABEL[level], total: of.length, agree: of.filter((r) => r.agree).length };
    }),
    rows: used,
  };
}

/** 影子模式下列表不显示判定等级和分数；演示场景的标题也会透露判定，换成订单号。 */
export function maskClaimList<T extends { level: unknown; score: unknown; dataConfidence: unknown; merchantRisk: unknown; incomplete: boolean; scenarioTitle: string | null }>(
  merchantId: string | null,
  items: T[],
): { claims: T[]; shadow: boolean } {
  if (!merchantId || !shadowModeOn(merchantId)) return { claims: items, shadow: false };
  return {
    shadow: true,
    claims: items.map((c) => ({ ...c, level: null, score: null, dataConfidence: null, merchantRisk: null, incomplete: false, scenarioTitle: null })),
  };
}
