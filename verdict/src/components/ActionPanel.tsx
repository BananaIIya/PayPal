'use client';

import { useEffect, useRef, useState } from 'react';
import { PORTAL_LINK_PLACEHOLDER } from '@/core/recommend';
import { FUND_ACTIONS, RETURN_ACK_TYPES, type ActionType, type ReturnAckType, type SuggestedAction } from '@/core/types';
import type { ClaimViewData } from '@/server/views';
import { fmtDateTime, fmtMoney } from './format';

const TYPE_LABEL: Record<string, string> = {
  refund: '退款',
  accept_claim: '接受索赔',
  send_message: '发送消息',
  provide_evidence: '提交证据',
  make_offer: '提出和解',
  escalate: '升级争议',
  provide_supporting_info: '补充说明',
  acknowledge_return_item: '确认退货',
  appeal: '申诉',
};

const ACK_LABEL: Record<ReturnAckType, string> = {
  ITEM_RECEIVED: '已收到退货，状态正常',
  ITEM_NOT_RECEIVED: '没有收到退货',
  DAMAGED: '收到退货，但商品损坏',
  EMPTY_PACKAGE_OR_DIFFERENT: '空包裹或不是原商品',
  MISSING_ITEMS: '收到退货，但少件',
};

/** 带证据附件的动作，以及其中可以附报告的动作。 */
const ATTACH_TYPES = new Set<string>(['provide_evidence', 'appeal', 'provide_supporting_info']);
const REPORT_TYPES = new Set<string>(['provide_evidence', 'appeal']);

const MONEY_ACTIONS = new Set(['refund', 'accept_claim', 'make_offer']);

interface Props {
  claimId: string;
  verdictId: string;
  /** 第一项是判定建议（影子模式下没有建议，全是中性选项）。由服务端按判定和 PayPal 状态生成。 */
  options: SuggestedAction[];
  /** 影子模式：不显示“建议”，不附报告和自动挑选的证据。 */
  shadow: boolean;
  claim: ClaimViewData['claim'];
  order: ClaimViewData['order'];
  allowed: ActionType[];
  actions: ClaimViewData['actions'];
  paypal: ClaimViewData['paypal'];
  /** 客服不能确认资金动作（退款、接受索赔、和解、确认收到退货）。服务端同样会拒绝。 */
  canConfirmFunds: boolean;
  onDone: () => Promise<void>;
}

const STUCK_PENDING_MS = 2 * 60 * 1000;
const STATUS_TEXT: Record<string, string> = { succeeded: '成功', failed: '失败', unknown: '结果不明', pending: '执行中' };

export function ActionPanel({ claimId, verdictId, options, shadow, claim, order, allowed, actions, paypal, canConfirmFunds, onDone }: Props) {
  const [index, setIndex] = useState(0);
  const current: SuggestedAction | undefined = options[index] ?? options[0];

  const [message, setMessage] = useState('');
  const [notes, setNotes] = useState('');
  const [amount, setAmount] = useState('');
  const [attachEvidence, setAttachEvidence] = useState(true);
  const [attachReport, setAttachReport] = useState(true);
  const [ackType, setAckType] = useState<ReturnAckType>('ITEM_RECEIVED');
  const [withReturn, setWithReturn] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useRef<string | null>(null);

  useEffect(() => {
    if (!current) return;
    setMessage(current.message ?? '');
    setNotes(current.notes ?? '');
    const initial = current.offerAmount ?? current.refundAmount;
    setAmount(initial !== undefined ? String(initial) : '');
    setAttachEvidence(current.attachEvidence ?? true);
    setAttachReport(current.attachReport ?? false);
    setAckType(current.acknowledgementType ?? 'ITEM_RECEIVED');
    setWithReturn(current.withReturn ?? false);
    setError(null);
  }, [current]);

  const isAllowed = !!current && current.type !== 'none' && allowed.includes(current.type);
  const fundLocked = !!current && current.type !== 'none' && FUND_ACTIONS.has(current.type) && !canConfirmFunds;
  // 只有 PayPal 争议里的和解能要求退货；PayPal 只给 REFUND_WITH_RETURN 时必须勾选。
  const returnChoice: 'none' | 'optional' | 'required' =
    current?.type !== 'make_offer' || !claim.disputeId || !paypal.offerTypes.includes('REFUND_WITH_RETURN')
      ? 'none'
      : paypal.offerTypes.includes('REFUND')
        ? 'optional'
        : 'required';
  const offerWithReturn = returnChoice === 'required' || (returnChoice === 'optional' && withReturn);
  // PayPal 不接受同一证据类型再交一次（沙箱里 INQUIRY 交过物流证据，CHARGEBACK 再交被拒）。
  const fulfillmentUsed =
    (current?.type === 'provide_evidence' || current?.type === 'appeal') &&
    current.evidenceType === 'PROOF_OF_FULFILLMENT' &&
    paypal.submittedEvidenceTypes.includes('PROOF_OF_FULFILLMENT');
  const evidenceType = fulfillmentUsed ? 'OTHER' : current?.evidenceType;
  const unresolved = actions.find(
    (a) => a.status === 'unknown' || (a.status === 'pending' && Date.now() - new Date(a.confirmedAt).getTime() > STUCK_PENDING_MS),
  );

  const reconcileLocked = !!unresolved && FUND_ACTIONS.has(unresolved.type as ActionType) && !canConfirmFunds;

  const payload = (current: SuggestedAction) => ({
    message: current.type === 'send_message' || current.type === 'refund' ? message : undefined,
    notes: current.type !== 'send_message' ? notes : undefined,
    evidenceType,
    amount: current.type === 'refund' || current.type === 'make_offer' ? Number(amount) : undefined,
    trackingNumber: current.trackingNumber,
    carrier: current.carrier,
    attachEvidence: ATTACH_TYPES.has(current.type) ? attachEvidence : undefined,
    attachReport: REPORT_TYPES.has(current.type) ? attachReport && paypal.reportAvailable : undefined,
    acknowledgementType: current.type === 'acknowledge_return_item' ? ackType : undefined,
    withReturn: current.type === 'make_offer' && offerWithReturn ? true : undefined,
  });

  function openConfirm() {
    // 同一次确认复用同一个幂等键，连点两次也只执行一次。
    idempotencyKey.current = crypto.randomUUID();
    setError(null);
    setConfirming(true);
  }

  async function execute() {
    if (!current) return;
    setBusy(true);
    setError(null);
    let res: Response;
    try {
      res = await fetch(`/api/claims/${claimId}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey.current! },
        body: JSON.stringify({ type: current.type, verdictId, confirm: true, payload: payload(current) }),
      });
    } catch {
      // 不知道服务端有没有收到，所以保留幂等键。重试时服务端会返回上一次的结果，不会再执行一次。
      setBusy(false);
      setError('没有收到服务端响应，可以重试，不会重复执行。');
      return;
    }
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(body.error ?? '执行失败');
      // PayPal 明确拒绝时，重试是一次新的尝试，要换新的幂等键。
      if (body.status === 'failed') idempotencyKey.current = crypto.randomUUID();
      // 结果不明时不能再点确认，关掉弹窗，由面板上的提示引导去对账。
      if (body.status === 'unknown') setConfirming(false);
      await onDone();
      return;
    }
    setConfirming(false);
    await onDone();
  }

  async function reconcile(actionId: string, outcome: 'succeeded' | 'failed') {
    const text = outcome === 'succeeded' ? 'PayPal 后台显示这个动作已经生效？' : 'PayPal 后台确认这个动作没有生效？标记后可以重新执行。';
    if (!window.confirm(text)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/claims/${claimId}/actions/${actionId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome, confirm: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setError(body.error ?? '标记失败');
      await onDone();
    } catch {
      setError('请求没有发出去，请重试');
    } finally {
      setBusy(false);
    }
  }

  const moneyAmount =
    current?.type === 'accept_claim'
      ? (paypal.amount ?? order.amount)
      : current?.type === 'refund' || current?.type === 'make_offer'
        ? Number(amount)
        : null;

  const recipient = claim.disputeId
    ? `买家（经 PayPal 争议 ${claim.disputeId}）`
    : order.buyerName
      ? `买家 ${order.buyerName}`
      : '买家';

  return (
    <section className="card card-pad action-card">
      <h2>{shadow ? '动作' : '建议动作'}</h2>
      {unresolved && (
        <div className="notice notice-danger" style={{ marginBottom: 12 }}>
          <strong>{TYPE_LABEL[unresolved.type] ?? unresolved.type}的结果不明。</strong>
          PayPal 没有给出明确答复，这个动作可能已经生效。请先到 PayPal 沙箱后台核对，标记之前这笔索赔不能再执行动作，以免重复退款。
          {typeof unresolved.response?.error === 'string' && <div className="small" style={{ marginTop: 4 }}>{unresolved.response.error}</div>}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn" disabled={busy || reconcileLocked} onClick={() => reconcile(unresolved.id, 'succeeded')}>
              已生效
            </button>
            <button className="btn" disabled={busy || reconcileLocked} onClick={() => reconcile(unresolved.id, 'failed')}>
              没有生效
            </button>
          </div>
          {reconcileLocked && <div className="small" style={{ marginTop: 6 }}>这是资金动作，只有店主可以核对结果。</div>}
          {!confirming && error && <div style={{ marginTop: 8 }}>{error}</div>}
        </div>
      )}
      {options.length > 1 && (
        <div className="action-tabs" role="group" aria-label="选择动作">
          {options.map((o, i) => (
            <button key={`${o.type}-${o.label}`} className="action-tab" aria-pressed={i === index} onClick={() => setIndex(i)}>
              {i === 0 && !shadow ? `建议：${o.label}` : o.label}
            </button>
          ))}
        </div>
      )}
      {!current ? (
        <p className="muted">{claim.status === 'closed' ? '这笔索赔已结案。' : 'PayPal 当前没有可以执行的动作。'}</p>
      ) : (
        <>
          <p style={{ marginBottom: 10 }}>{current.reason}</p>
          <ActionFields
            action={current}
            message={message}
            setMessage={setMessage}
            notes={notes}
            setNotes={setNotes}
            amount={amount}
            setAmount={setAmount}
            attachEvidence={attachEvidence}
            setAttachEvidence={setAttachEvidence}
            attachReport={attachReport}
            setAttachReport={setAttachReport}
            reportAvailable={paypal.reportAvailable}
            ackType={ackType}
            setAckType={setAckType}
            attachmentCount={paypal.attachments}
            currency={order.currency}
            maxAmount={order.amount}
            returnChoice={returnChoice}
            withReturn={offerWithReturn}
            setWithReturn={setWithReturn}
            returnAddress={paypal.returnAddress}
            shadow={shadow}
          />
          {fulfillmentUsed && (
            <p className="notice" style={{ marginBottom: 10 }}>
              这笔争议已经提交过物流证据（PROOF_OF_FULFILLMENT），PayPal 不接受同一类型再交一次。这次按 OTHER 提交，物流单号会写进说明。
            </p>
          )}
          {current.paypalOperation && <div className="op-line" style={{ marginBottom: 10 }}>{current.paypalOperation}</div>}
          {current.type === 'none' ? (
            <p className="muted small">这个判定没有可以直接执行的动作。</p>
          ) : (
            <>
              <button className={`btn ${MONEY_ACTIONS.has(current.type) ? 'btn-danger' : 'btn-primary'}`} style={{ width: '100%' }} disabled={!isAllowed || !!unresolved || fundLocked} onClick={openConfirm}>
                {current.label}…
              </button>
              {fundLocked && isAllowed && (
                <p className="small muted" style={{ marginTop: 6 }}>
                  这是资金动作，只有店主可以确认，请店主登录后执行。
                </p>
              )}
              {!isAllowed && (
                <p className="small muted" style={{ marginTop: 6 }}>
                  {paypal.status === 'UNDER_REVIEW'
                    ? 'PayPal 正在审核这笔争议，现在不能操作。如果刚提交过，通常半分钟左右状态会更新，到时刷新页面再试。'
                    : 'PayPal 当前状态不允许这个动作。'}
                </p>
              )}
            </>
          )}
        </>
      )}

      {actions.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <h3 style={{ marginBottom: 4 }}>已执行</h3>
          {actions.map((a) => (
            <div key={a.id} className="small" style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
              <div className="between">
                <strong>
                  {TYPE_LABEL[a.type] ?? a.type}
                  {a.response?.offer_type === 'REFUND_WITH_RETURN' ? '（要求退货）' : ''}
                </strong>
                <span className={`badge ${a.status === 'succeeded' ? 'level-low' : a.status === 'failed' ? 'level-high' : ''}`}>
                  {STATUS_TEXT[a.status] ?? a.status}
                </span>
              </div>
              <div className="muted">
                {fmtDateTime(a.confirmedAt)} · 确认人 {a.confirmedBy}
                {a.response?.simulated ? ' · 模拟调用' : a.response?.environment === 'sandbox' ? ' · 沙箱调用' : ''}
                {a.response?.reconciled ? ' · 人工核对' : ''}
              </div>
              {typeof a.response?.operation === 'string' && <div className="muted mono">{a.response.operation}</div>}
              {typeof a.response?.error === 'string' && <div style={{ color: 'var(--high)' }}>{a.response.error}</div>}
              {Array.isArray(a.response?.documents) && a.response.documents.length > 0 && (
                <div className="muted">附件：{(a.response.documents as string[]).join('、')}</div>
              )}
              {typeof a.response?.reportSkipped === 'string' && <div style={{ color: 'var(--medium, #9a6700)' }}>没有附上报告：{a.response.reportSkipped}</div>}
              {typeof a.response?.message === 'string' && <div style={{ marginTop: 3, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{a.response.message}</div>}
            </div>
          ))}
        </div>
      )}

      {confirming && current && (
        <div className="modal-back" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
          <div className="modal">
            <h2 id="confirm-title">确认：{current.label}</h2>
            <dl className="kv">
              <dt>PayPal 操作</dt>
              <dd className="mono">{current.paypalOperation}</dd>
              {moneyAmount !== null && (
                <>
                  <dt>金额</dt>
                  <dd>
                    <strong>{fmtMoney(moneyAmount, current.type === 'accept_claim' ? (paypal.currency ?? order.currency) : order.currency)}</strong>
                    {current.type === 'make_offer' ? (offerWithReturn ? '（退货退款和解，买家接受并寄回后退款）' : '（和解提议，买家接受后生效）') : ''}
                  </dd>
                </>
              )}
              <dt>收件方</dt>
              <dd>{recipient}</dd>
              {current.type === 'make_offer' && offerWithReturn && (
                <>
                  <dt>退货地址</dt>
                  <dd>{paypal.returnAddress}</dd>
                </>
              )}
              {(current.type === 'provide_evidence' || current.type === 'appeal') && (
                <>
                  <dt>证据类型</dt>
                  <dd className="mono">{evidenceType}</dd>
                </>
              )}
              {ATTACH_TYPES.has(current.type) && (
                <>
                  <dt>附件</dt>
                  <dd>{attachmentSummary(REPORT_TYPES.has(current.type) && attachReport && paypal.reportAvailable, attachEvidence ? paypal.attachments : 0)}</dd>
                </>
              )}
              {current.type === 'acknowledge_return_item' && (
                <>
                  <dt>验收结果</dt>
                  <dd>
                    {ACK_LABEL[ackType]} <span className="mono small">{ackType}</span>
                  </dd>
                  {ackType === 'ITEM_RECEIVED' && (
                    <>
                      <dt>资金</dt>
                      <dd>
                        <strong>PayPal 会按买家已接受的和解金额退款并结案</strong>（沙箱实测约 2 分钟）
                      </dd>
                    </>
                  )}
                </>
              )}
              {current.trackingNumber && (
                <>
                  <dt>物流单号</dt>
                  <dd className="mono">
                    {current.carrier} {current.trackingNumber}
                  </dd>
                </>
              )}
              {(current.type === 'send_message' || current.type === 'refund') && message && (
                <>
                  <dt>消息内容</dt>
                  <dd>{message.replaceAll(PORTAL_LINK_PLACEHOLDER, '（发送时替换为一次性索赔页链接）')}</dd>
                </>
              )}
              {current.type !== 'send_message' && current.type !== 'refund' && notes && (
                <>
                  <dt>说明</dt>
                  <dd>{notes}</dd>
                </>
              )}
            </dl>
            <p className="notice" style={{ marginBottom: 14 }}>
              {paypal.env === 'sandbox'
                ? '这个操作会真实调用 PayPal 沙箱。使用的是沙箱测试资金，不产生真实资金流动，但执行后无法撤回。'
                : '当前是演示环境，这个操作由 PayPal 模拟器执行，不产生真实资金流动。正式环境下这一步无法撤回。'}
            </p>
            {error && (
              <p className="notice notice-danger" style={{ marginBottom: 14 }}>
                {error}
              </p>
            )}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" disabled={busy} onClick={() => setConfirming(false)}>
                取消
              </button>
              <button
                className={`btn ${MONEY_ACTIONS.has(current.type) || (current.type === 'acknowledge_return_item' && ackType === 'ITEM_RECEIVED') ? 'btn-danger' : 'btn-primary'}`}
                disabled={busy}
                onClick={execute}
              >
                {busy ? '执行中…' : '确认执行'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function attachmentSummary(report: boolean, images: number): string {
  const parts = [report ? '核验报告 PDF' : null, images > 0 ? `${images} 张关键证据图片` : null].filter(Boolean);
  return parts.length ? parts.join(' + ') : '不附文件';
}

function ActionFields(p: {
  action: SuggestedAction;
  message: string;
  setMessage: (v: string) => void;
  notes: string;
  setNotes: (v: string) => void;
  amount: string;
  setAmount: (v: string) => void;
  attachEvidence: boolean;
  setAttachEvidence: (v: boolean) => void;
  attachReport: boolean;
  setAttachReport: (v: boolean) => void;
  reportAvailable: boolean;
  ackType: ReturnAckType;
  setAckType: (v: ReturnAckType) => void;
  attachmentCount: number;
  currency: string;
  maxAmount: number;
  returnChoice: 'none' | 'optional' | 'required';
  withReturn: boolean;
  setWithReturn: (v: boolean) => void;
  returnAddress: string;
  shadow: boolean;
}) {
  const t = p.action.type;
  return (
    <>
      {(t === 'refund' || t === 'make_offer') && (
        <label className="field">
          金额（{p.currency}，最多 {p.maxAmount.toFixed(2)}）
          <input type="number" min="0.01" step="0.01" max={p.maxAmount} value={p.amount} onChange={(e) => p.setAmount(e.target.value)} />
        </label>
      )}
      {p.returnChoice !== 'none' && (
        <div className="field">
          <label className="row">
            <input type="checkbox" checked={p.withReturn} disabled={p.returnChoice === 'required'} onChange={(e) => p.setWithReturn(e.target.checked)} />
            {p.returnChoice === 'required' ? '要求买家先退货（这笔争议 PayPal 只接受退货退款和解）' : '要求买家先退货，收到退货后再退款'}
          </label>
          {p.withReturn && <span className="muted small" style={{ display: 'block' }}>退货地址：{p.returnAddress}（设置页可查看）</span>}
        </div>
      )}
      {(t === 'send_message' || t === 'refund') && (
        <label className="field">
          给买家的消息（可编辑）
          <textarea rows={5} value={p.message} onChange={(e) => p.setMessage(e.target.value)} />
          {p.message.includes(PORTAL_LINK_PLACEHOLDER) && (
            <span className="muted small" style={{ display: 'block' }}>
              {PORTAL_LINK_PLACEHOLDER} 会在发送时替换成这位买家专属的一次性链接。
            </span>
          )}
        </label>
      )}
      {t === 'acknowledge_return_item' && (
        <label className="field">
          验收结果（按实际开箱情况选择）
          <select value={p.ackType} onChange={(e) => p.setAckType(e.target.value as ReturnAckType)}>
            {RETURN_ACK_TYPES.map((k) => (
              <option key={k} value={k}>
                {ACK_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
      )}
      {t !== 'send_message' && t !== 'refund' && t !== 'none' && t !== 'escalate' && (
        <label className="field">
          {t === 'provide_evidence' || t === 'appeal' || t === 'provide_supporting_info' ? '提交给 PayPal 的说明（可编辑）' : '说明（可编辑）'}
          <textarea rows={t === 'accept_claim' || t === 'acknowledge_return_item' ? 2 : 5} value={p.notes} onChange={(e) => p.setNotes(e.target.value)} />
        </label>
      )}
      {p.shadow && ATTACH_TYPES.has(t) && (
        <p className="muted small" style={{ marginBottom: 12 }}>
          影子模式下不附核验报告，也不自动挑选证据图片（两者都会透露判定）。需要附件的话请在 PayPal 后台手动上传。
        </p>
      )}
      {!p.shadow && REPORT_TYPES.has(t) && (
        <label className="row" style={{ marginBottom: 6 }}>
          <input type="checkbox" checked={p.attachReport && p.reportAvailable} disabled={!p.reportAvailable} onChange={(e) => p.setAttachReport(e.target.checked)} />
          {p.reportAvailable ? '附核验报告 PDF（提交版，不含内部风险标记和草稿）' : '服务器缺少中文字体，无法生成报告 PDF'}
        </label>
      )}
      {!p.shadow && ATTACH_TYPES.has(t) && (
        <label className="row" style={{ marginBottom: 12 }}>
          <input type="checkbox" checked={p.attachEvidence} disabled={p.attachmentCount === 0} onChange={(e) => p.setAttachEvidence(e.target.checked)} />
          {p.attachmentCount > 0 ? `附关键证据图片（${p.attachmentCount} 张）` : '没有可以附上的证据图片'}
        </label>
      )}
    </>
  );
}
