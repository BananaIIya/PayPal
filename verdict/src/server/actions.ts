// 动作执行器：系统里唯一调用 PayPal 写接口的地方。
// 校验顺序对齐开发文档：confirm 为 true → verdictId 是最新判定 → 动作在 PayPal 当前允许的操作内。
// actions.confirmed_by 和 confirmed_at 非空：没有商家确认记录的动作写不进库，也就发不出去。
//
// PayPal 的争议接口不支持 PayPal-Request-Id，幂等键只在本地生效。
// 所以超时、断连、5xx 记为 unknown（结果不明），在商家对账之前这笔索赔不能再执行任何动作。
import { RETURN_ACK_TYPES, type ActionType, type ReturnAckType } from '@/core/types';
import { PORTAL_LINK_PLACEHOLDER } from '@/core/recommend';
import { clientForEnv, requireSandbox } from '@/paypal';
import { PayPalApiError, type DisputeView, type PayPalDocument, type PayPalEnv, type PayPalWriteResult } from '@/paypal/client';
import { buildEvidenceDocuments } from './attachments';
import { db, newId, nowIso } from './db';
import { upsertClaimFromDispute } from './paypal-sync';
import { addTimeline, getClaim, getOrder, latestVerdict, type ClaimRow, type OrderRow } from './repo';
import { issuePortalToken } from './tokens';

export interface ActionRequest {
  claimId: string;
  type: ActionType;
  verdictId: string;
  confirm: boolean;
  idempotencyKey: string;
  confirmedBy: string;
  origin: string;
  payload: {
    message?: string;
    notes?: string;
    evidenceType?: 'OTHER' | 'PROOF_OF_FULFILLMENT';
    amount?: number;
    trackingNumber?: string;
    carrier?: string;
    attachEvidence?: boolean;
    /** 附核验报告 PDF（provide_evidence、appeal）。 */
    attachReport?: boolean;
    acknowledgementType?: ReturnAckType;
  };
}

export type ActionOutcome = { status: number; body: Record<string, unknown> };

const VALID_TYPES: ActionType[] = [
  'refund',
  'accept_claim',
  'send_message',
  'provide_evidence',
  'make_offer',
  'escalate',
  'provide_supporting_info',
  'acknowledge_return_item',
  'appeal',
];
/** 带证据附件的动作。 */
const EVIDENCE_TYPES = new Set<ActionType>(['provide_evidence', 'appeal']);
const ATTACHMENT_TYPES = new Set<ActionType>(['provide_evidence', 'appeal', 'provide_supporting_info']);
const MAX_TEXT = 2000;
// 进程在调用途中崩溃时，动作会一直停在 pending。超过这个时间才允许人工对账。
const STUCK_PENDING_MS = 2 * 60 * 1000;

const DEFAULT_NOTE: Partial<Record<ActionType, string>> = {
  make_offer: '商家提出退款以解决这笔争议。',
  accept_claim: '商家接受买家的索赔。',
  escalate: '商家不同意买家的说法，请求 PayPal 介入。',
  acknowledge_return_item: '商家已处理买家退回的包裹。',
};

export interface PayPalState {
  env: PayPalEnv;
  allowed: ActionType[];
  dispute: DisputeView | null;
  error: string | null;
}

export async function paypalState(claim: ClaimRow, order: OrderRow, opts: { fresh?: boolean } = {}): Promise<PayPalState> {
  const env = order.paypal_env;
  const closed = claim.status === 'closed';
  // 已结案的索赔只保留申诉：PayPal 判买家胜诉后，详情里会出现 appeal 链接。
  const onClosed = (allowed: ActionType[]) => (closed ? allowed.filter((a) => a === 'appeal') : allowed);
  if (!claim.paypal_dispute_id) {
    // 没有争议时退款走订单的捕获记录。还没付款的订单没有可退的东西。
    const allowed: ActionType[] = order.capture_id ? ['refund', 'send_message', 'make_offer'] : ['send_message'];
    return { env, allowed: closed ? [] : allowed, dispute: null, error: null };
  }
  try {
    const dispute = await clientForEnv(env).getDispute(claim.paypal_dispute_id, opts);
    return {
      env,
      allowed: onClosed(dispute?.allowedActions ?? []),
      dispute,
      error: dispute ? null : 'PayPal 找不到这笔争议',
    };
  } catch (e) {
    return { env, allowed: [], dispute: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function allowedActions(claim: ClaimRow): Promise<ActionType[]> {
  return (await paypalState(claim, getOrder(claim.order_id)!)).allowed;
}

function withPortalLink(text: string, claim: ClaimRow, origin: string): string {
  if (!text.includes(PORTAL_LINK_PLACEHOLDER)) return text;
  const token = issuePortalToken({ merchantId: claim.merchant_id, orderId: claim.order_id, claimId: claim.id });
  return text.replaceAll(PORTAL_LINK_PLACEHOLDER, `${origin}/c/${token}`);
}

function validate(req: ActionRequest, order: OrderRow): string | null {
  const { type, payload } = req;
  const amount = payload.amount;
  if (type === 'send_message' && !payload.message?.trim()) return '消息内容不能为空';
  if ((payload.message?.length ?? 0) > MAX_TEXT) return `消息不能超过 ${MAX_TEXT} 字`;
  if ((payload.notes?.length ?? 0) > MAX_TEXT) return `说明不能超过 ${MAX_TEXT} 字`;
  if (EVIDENCE_TYPES.has(type)) {
    if (!payload.notes?.trim()) return '提交说明不能为空';
    if (payload.evidenceType !== 'OTHER' && payload.evidenceType !== 'PROOF_OF_FULFILLMENT') return '证据类型无效';
    if (payload.evidenceType === 'PROOF_OF_FULFILLMENT' && !payload.trackingNumber) return '物流证据需要物流单号';
  }
  if (type === 'provide_supporting_info' && !payload.notes?.trim()) return '补充说明不能为空';
  if (type === 'acknowledge_return_item' && !RETURN_ACK_TYPES.includes(payload.acknowledgementType as ReturnAckType)) return '请选择退货验收结果';
  if (type === 'make_offer' || type === 'refund') {
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return '金额必须大于 0';
    if (amount > order.amount) return `金额不能超过订单金额 ${order.amount}`;
  }
  return null;
}

async function callPayPal(req: ActionRequest, claim: ClaimRow, order: OrderRow, message: string, documents: PayPalDocument[]): Promise<PayPalWriteResult> {
  const evidenceInput = () => ({
    evidenceType: req.payload.evidenceType!,
    notes: req.payload.notes!,
    documents,
    trackingNumber: req.payload.trackingNumber,
    carrier: req.payload.carrier,
  });
  const pp = clientForEnv(order.paypal_env);
  const key = req.idempotencyKey;
  const disputeId = claim.paypal_dispute_id;
  const { payload } = req;
  const note = payload.notes?.trim() || DEFAULT_NOTE[req.type] || '';

  switch (req.type) {
    case 'send_message': {
      const res: PayPalWriteResult = disputeId
        ? await pp.sendMessage(disputeId, message, key)
        : { simulated: true, environment: order.paypal_env, operation: '售后消息（不经 PayPal，MVP 不实际发送）', message };
      db()
        .prepare("INSERT INTO messages (id, order_id, sender, text, created_at) VALUES (?, ?, 'merchant', ?, ?)")
        .run(newId(), order.id, message, nowIso());
      return { ...res, message };
    }
    case 'provide_evidence':
      return pp.provideEvidence(disputeId!, evidenceInput(), key);
    case 'appeal':
      return pp.appealDispute(disputeId!, evidenceInput(), key);
    case 'provide_supporting_info':
      return pp.provideSupportingInfo(disputeId!, { notes: payload.notes!, documents }, key);
    case 'acknowledge_return_item':
      return pp.acknowledgeReturnItem(disputeId!, { note, acknowledgementType: payload.acknowledgementType! }, key);
    case 'make_offer':
      if (disputeId) {
        return pp.makeOffer(disputeId, { amount: payload.amount!, currency: order.currency, note }, key);
      }
      return pp.refundCapture(order.capture_id!, { amount: payload.amount!, currency: order.currency }, key);
    case 'accept_claim':
      return pp.acceptClaim(disputeId!, note, key);
    case 'escalate':
      return pp.escalate(disputeId!, note, key);
    case 'refund':
      return pp.refundCapture(order.capture_id!, { amount: payload.amount!, currency: order.currency }, key);
  }
}

const AFTER_ACTION: Record<ActionType, { status: 'closed' | 'action_sent'; title: string }> = {
  refund: { status: 'closed', title: '商家确认退款' },
  accept_claim: { status: 'closed', title: '商家接受索赔' },
  send_message: { status: 'action_sent', title: '商家发送消息' },
  provide_evidence: { status: 'action_sent', title: '商家提交证据' },
  make_offer: { status: 'action_sent', title: '商家提出和解' },
  escalate: { status: 'action_sent', title: '商家升级争议' },
  provide_supporting_info: { status: 'action_sent', title: '商家补充说明' },
  acknowledge_return_item: { status: 'action_sent', title: '商家确认退货验收结果' },
  // 申诉让已结案的索赔重新进入处理中，PayPal 再次结案时同步会把它关掉。
  appeal: { status: 'action_sent', title: '商家提出申诉' },
};

interface PreviousAction {
  id: string;
  status: string;
  paypal_response: string | null;
}

function findByKey(key: string): PreviousAction | undefined {
  return db().prepare('SELECT id, status, paypal_response FROM actions WHERE paypal_request_id = ?').get(key) as PreviousAction | undefined;
}

function replay(previous: PreviousAction): ActionOutcome {
  const response = previous.paypal_response ? (JSON.parse(previous.paypal_response) as Record<string, unknown>) : null;
  const body = { actionId: previous.id, status: previous.status, response, replay: true };
  if (previous.status === 'succeeded') return { status: 200, body };
  if (previous.status === 'pending') return { status: 409, body: { ...body, error: '这个动作正在执行，请稍候' } };
  return { status: 502, body: { ...body, error: (response?.error as string | undefined) ?? '这个动作上次没有成功' } };
}

export async function executeAction(req: ActionRequest): Promise<ActionOutcome> {
  if (req.confirm !== true) return { status: 400, body: { error: '动作需要商家确认' } };
  if (!req.idempotencyKey) return { status: 400, body: { error: '缺少 Idempotency-Key' } };
  if (!req.confirmedBy) return { status: 401, body: { error: '缺少确认人' } };
  if (!VALID_TYPES.includes(req.type)) return { status: 400, body: { error: '未知的动作类型' } };

  const conn = db();
  const previous = findByKey(req.idempotencyKey);
  if (previous) return replay(previous);

  const claim = getClaim(req.claimId);
  if (!claim) return { status: 404, body: { error: '索赔不存在' } };
  const order = getOrder(claim.order_id)!;

  const verdict = latestVerdict(claim.id);
  if (!verdict || verdict.id !== req.verdictId) {
    return { status: 409, body: { error: '判定已更新，请查看最新结果后再确认', latestVerdictId: verdict?.id ?? null } };
  }

  // 动作前绕过缓存：商家看到的状态可能已经过期，这里以 PayPal 此刻的状态为准。
  const state = await paypalState(claim, order, { fresh: true });
  if (state.error) return { status: 502, body: { error: `无法确认 PayPal 当前状态，动作没有执行：${state.error}` } };
  if (!state.allowed.includes(req.type)) {
    return { status: 409, body: { error: `当前状态不允许这个动作（允许：${state.allowed.join('、') || '无'}）` } };
  }

  const invalid = validate(req, order);
  if (invalid) return { status: 400, body: { error: invalid } };

  const wantsFiles = ATTACHMENT_TYPES.has(req.type) && (req.payload.attachEvidence || (EVIDENCE_TYPES.has(req.type) && req.payload.attachReport));
  const bundle = wantsFiles
    ? await buildEvidenceDocuments(claim.id, { evidence: !!req.payload.attachEvidence, report: EVIDENCE_TYPES.has(req.type) && !!req.payload.attachReport })
    : { documents: [], reportSkipped: null };
  const documents = bundle.documents;

  // 上面有 await，真实网络下其他请求可能已经插进来。从这里到 INSERT 不能再有 await，
  // 否则两个请求都能通过检查，退款就可能发出两次。
  const raced = findByKey(req.idempotencyKey);
  if (raced) return replay(raced);
  if (latestVerdict(claim.id)?.id !== verdict.id) {
    return { status: 409, body: { error: '判定已更新，请查看最新结果后再确认', latestVerdictId: latestVerdict(claim.id)?.id ?? null } };
  }
  const inFlight = conn.prepare("SELECT id, status FROM actions WHERE claim_id = ? AND status IN ('pending', 'unknown') LIMIT 1").get(claim.id) as
    | { id: string; status: string }
    | undefined;
  if (inFlight) {
    return {
      status: 409,
      body: {
        error: inFlight.status === 'pending' ? '这笔索赔有一个动作正在执行，请稍候' : '这笔索赔有一个结果不明的动作，请先核对 PayPal 后台并标记结果',
        blockedBy: inFlight.id,
      },
    };
  }

  // 替换链接后消息会变长（token 约 300 字），要按最终长度校验。放在 INSERT 前，超长时什么都不会发出。
  const message = req.payload.message ? withPortalLink(req.payload.message, claim, req.origin) : '';
  if (message.length > MAX_TEXT) return { status: 400, body: { error: `加上索赔链接后消息超过 ${MAX_TEXT} 字，请缩短` } };

  const actionId = newId();
  const confirmedAt = nowIso();
  conn
    .prepare(
      `INSERT INTO actions (id, claim_id, verdict_id, type, payload, confirmed_by, confirmed_at, paypal_request_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    .run(actionId, claim.id, verdict.id, req.type, JSON.stringify(req.payload), req.confirmedBy, confirmedAt, req.idempotencyKey);

  try {
    const result = await callPayPal(req, claim, order, message, documents);
    const response: PayPalWriteResult = { ...result };
    if (documents.length) response.documents = documents.map((d) => d.name);
    if (bundle.reportSkipped) response.reportSkipped = bundle.reportSkipped;
    conn.prepare("UPDATE actions SET status = 'succeeded', paypal_response = ? WHERE id = ?").run(JSON.stringify(response), actionId);
    const after = AFTER_ACTION[req.type];
    conn.prepare('UPDATE claims SET status = ? WHERE id = ?').run(after.status, claim.id);
    addTimeline(claim.id, 'action', after.title, `确认人：${req.confirmedBy}；${response.operation}`);
    return { status: 200, body: { actionId, status: 'succeeded', response } };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const unknown = e instanceof PayPalApiError && e.indeterminate;
    const status = unknown ? 'unknown' : 'failed';
    conn.prepare('UPDATE actions SET status = ?, paypal_response = ? WHERE id = ?').run(status, JSON.stringify({ error }), actionId);
    addTimeline(claim.id, 'action', unknown ? '动作结果不明' : '动作执行失败', error);
    return { status: 502, body: { actionId, status, error } };
  }
}

/** 结果不明的动作由人对照 PayPal 后台来定。系统不自动重试，避免重复退款。 */
export function resolveAction(input: { claimId: string; actionId: string; outcome: 'succeeded' | 'failed'; confirm: boolean; confirmedBy: string }): ActionOutcome {
  if (input.confirm !== true) return { status: 400, body: { error: '需要商家确认' } };
  if (input.outcome !== 'succeeded' && input.outcome !== 'failed') return { status: 400, body: { error: '结果无效' } };
  const conn = db();
  const action = conn.prepare('SELECT * FROM actions WHERE id = ? AND claim_id = ?').get(input.actionId, input.claimId) as
    | { id: string; type: ActionType; status: string; confirmed_at: string; paypal_response: string | null }
    | undefined;
  if (!action) return { status: 404, body: { error: '动作不存在' } };
  const stuck = action.status === 'pending' && Date.now() - new Date(action.confirmed_at).getTime() > STUCK_PENDING_MS;
  if (action.status !== 'unknown' && !stuck) return { status: 409, body: { error: '这个动作不需要对账' } };

  const response = {
    ...(action.paypal_response ? (JSON.parse(action.paypal_response) as Record<string, unknown>) : {}),
    reconciled: { by: input.confirmedBy, at: nowIso(), outcome: input.outcome },
  };
  conn.prepare('UPDATE actions SET status = ?, paypal_response = ? WHERE id = ?').run(input.outcome, JSON.stringify(response), action.id);
  if (input.outcome === 'succeeded') {
    const after = AFTER_ACTION[action.type];
    conn.prepare('UPDATE claims SET status = ? WHERE id = ?').run(after.status, input.claimId);
    addTimeline(input.claimId, 'action', `${after.title}（人工核对）`, `核对人：${input.confirmedBy}`);
  } else {
    addTimeline(input.claimId, 'action', '动作未生效（人工核对）', `核对人：${input.confirmedBy}`);
  }
  return { status: 200, body: { actionId: action.id, status: input.outcome } };
}

export type SandboxTool =
  | { tool: 'require_evidence'; value: 'SELLER_EVIDENCE' | 'BUYER_EVIDENCE' }
  | { tool: 'adjudicate'; value: 'BUYER_FAVOR' | 'SELLER_FAVOR' };

/** 沙箱专用接口，用来把争议推进到需要的状态。只对沙箱订单开放，而且 PayPal 要给了链接。 */
export async function runSandboxTool(input: { claimId: string; confirm: boolean } & SandboxTool): Promise<ActionOutcome> {
  if (input.confirm !== true) return { status: 400, body: { error: '需要商家确认' } };
  const claim = getClaim(input.claimId);
  if (!claim) return { status: 404, body: { error: '索赔不存在' } };
  const order = getOrder(claim.order_id)!;
  if (order.paypal_env !== 'sandbox' || !claim.paypal_dispute_id) return { status: 409, body: { error: '只有沙箱争议才能使用测试工具' } };
  const validValue =
    (input.tool === 'require_evidence' && (input.value === 'SELLER_EVIDENCE' || input.value === 'BUYER_EVIDENCE')) ||
    (input.tool === 'adjudicate' && (input.value === 'BUYER_FAVOR' || input.value === 'SELLER_FAVOR'));
  if (!validValue) return { status: 400, body: { error: '测试工具参数无效' } };

  try {
    const client = requireSandbox();
    const dispute = await client.getDispute(claim.paypal_dispute_id, { fresh: true });
    if (!dispute) return { status: 404, body: { error: 'PayPal 找不到这笔争议' } };
    if (input.tool === 'require_evidence') {
      if (!dispute.sandboxTools.requireEvidence) return { status: 409, body: { error: 'PayPal 当前没有提供这个测试接口' } };
      await client.requireEvidence(claim.paypal_dispute_id, input.value);
    } else {
      if (!dispute.sandboxTools.adjudicate) return { status: 409, body: { error: 'PayPal 当前没有提供这个测试接口' } };
      await client.adjudicate(claim.paypal_dispute_id, input.value);
    }
    addTimeline(claim.id, 'dispute', '沙箱测试工具', `${input.tool}：${input.value}`);
    const fresh = await client.getDispute(claim.paypal_dispute_id, { fresh: true });
    if (fresh) upsertClaimFromDispute(fresh);
    return { status: 200, body: { ok: true } };
  } catch (e) {
    return { status: 502, body: { error: e instanceof Error ? e.message : String(e) } };
  }
}
