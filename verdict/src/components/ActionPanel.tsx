'use client';

import { useEffect, useRef, useState } from 'react';
import { PORTAL_LINK_PLACEHOLDER } from '@/core/recommend';
import { FUND_ACTIONS, RETURN_ACK_TYPES, type ActionType, type ReturnAckType, type SuggestedAction } from '@/core/types';
import type { ClaimViewData } from '@/server/views';
import { fmtDateTime, fmtMoney } from './format';

const TYPE_LABEL: Record<string, string> = {
  refund: 'Refund',
  accept_claim: 'Accept claim',
  send_message: 'Send message',
  provide_evidence: 'Submit evidence',
  make_offer: 'Make offer',
  escalate: 'Escalate dispute',
  provide_supporting_info: 'Add supporting info',
  acknowledge_return_item: 'Acknowledge return',
  appeal: 'Appeal',
};

const ACK_LABEL: Record<ReturnAckType, string> = {
  ITEM_RECEIVED: 'Return received in normal condition',
  ITEM_NOT_RECEIVED: 'Return not received',
  DAMAGED: 'Return received, but item damaged',
  EMPTY_PACKAGE_OR_DIFFERENT: 'Empty package or different item',
  MISSING_ITEMS: 'Return received, but items missing',
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
const STATUS_TEXT: Record<string, string> = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  unknown: 'Unknown result',
  pending: 'Running',
  processing: 'Refund processing',
};

export function ActionPanel({ claimId, verdictId, options, shadow, claim, order, allowed, actions, paypal, canConfirmFunds, onDone }: Props) {
  const [index, setIndex] = useState(0);
  const current: SuggestedAction | undefined = options[index] ?? options[0];

  const [message, setMessage] = useState('');
  const [notes, setNotes] = useState('');
  const [amount, setAmount] = useState('');
  const [attachEvidence, setAttachEvidence] = useState(true);
  const [attachReport, setAttachReport] = useState(true);
  // 退货验收没有默认值：系统无法代替开箱，选“已收到”会让 PayPal 直接退款。
  const [ackType, setAckType] = useState<ReturnAckType | ''>('');
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
    setAckType(current.acknowledgementType ?? '');
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
  const processing = actions.find((a) => a.status === 'processing');

  const reconcileLocked = !!unresolved && FUND_ACTIONS.has(unresolved.type as ActionType) && !canConfirmFunds;
  const processingLocked = !!processing && FUND_ACTIONS.has(processing.type as ActionType) && !canConfirmFunds;

  const payload = (current: SuggestedAction) => ({
    message: current.type === 'send_message' || current.type === 'refund' ? message : undefined,
    notes: current.type !== 'send_message' ? notes : undefined,
    evidenceType,
    amount: current.type === 'refund' || current.type === 'make_offer' ? Number(amount) : undefined,
    trackingNumber: current.trackingNumber,
    carrier: current.carrier,
    attachEvidence: ATTACH_TYPES.has(current.type) ? attachEvidence : undefined,
    attachReport: REPORT_TYPES.has(current.type) ? attachReport && paypal.reportAvailable : undefined,
    acknowledgementType: current.type === 'acknowledge_return_item' && ackType ? ackType : undefined,
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
      setError('No response from the server. You can retry; it will not run twice.');
      return;
    }
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(body.error ?? 'Action failed');
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
    const text = outcome === 'succeeded' ? 'Does PayPal show this action took effect?' : 'Has PayPal confirmed this action did not take effect? After marking it, you can run it again.';
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
      if (!res.ok) setError(body.error ?? 'Marking failed');
      await onDone();
    } catch {
      setError('The request did not go through. Try again.');
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
    ? `Buyer (via PayPal dispute ${claim.disputeId})`
    : order.buyerName
      ? `Buyer ${order.buyerName}`
      : 'Buyer';

  return (
    <section className="card card-pad action-card">
      <h2>
        {shadow ? 'Action' : 'Recommended action'}
      </h2>
      {processing && (
        <div className="notice notice-info" style={{ marginBottom: 12 }}>
          <strong>Refund processing.</strong>
          The refund was submitted to PayPal and is still processing, so this claim stays open. It updates automatically after a sync or a completion event. If you already see the final result in PayPal, you can mark it manually.
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn" disabled={busy || processingLocked} onClick={() => reconcile(processing.id, 'succeeded')}>
              Completed
            </button>
            <button className="btn" disabled={busy || processingLocked} onClick={() => reconcile(processing.id, 'failed')}>
              Not completed
            </button>
          </div>
          {processingLocked && <div className="small" style={{ marginTop: 6 }}>This is a money action. Only the owner can reconcile the result.</div>}
        </div>
      )}
      {unresolved && (
        <div className="notice notice-danger" style={{ marginBottom: 12 }}>
          <strong>{TYPE_LABEL[unresolved.type] ?? unresolved.type}: result unknown.</strong>{' '}
          PayPal did not give a clear answer, so this action may have taken effect. Check it in the PayPal sandbox first. Until you mark it, no more actions can run on this claim, to avoid a duplicate refund.
          {typeof unresolved.response?.error === 'string' && <div className="small" style={{ marginTop: 4 }}>{unresolved.response.error}</div>}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn" disabled={busy || reconcileLocked} onClick={() => reconcile(unresolved.id, 'succeeded')}>
              Took effect
            </button>
            <button className="btn" disabled={busy || reconcileLocked} onClick={() => reconcile(unresolved.id, 'failed')}>
              Did not take effect
            </button>
          </div>
          {reconcileLocked && <div className="small" style={{ marginTop: 6 }}>This is a money action. Only the owner can reconcile the result.</div>}
          {!confirming && error && <div style={{ marginTop: 8 }}>{error}</div>}
        </div>
      )}
      {options.length > 1 && (
        <div className="action-tabs" role="group" aria-label="Choose action">
          {options.map((o, i) => (
            <button key={`${o.type}-${o.label}`} className="action-tab" aria-pressed={i === index} onClick={() => setIndex(i)}>
              {i === 0 && !shadow ? `Recommended: ${o.label}` : o.label}
            </button>
          ))}
        </div>
      )}
      {!current ? (
        <p className="muted">{claim.status === 'closed' ? 'This claim is closed.' : 'PayPal has no actions available right now.'}</p>
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
              Fulfillment evidence (PROOF_OF_FULFILLMENT) was already submitted for this dispute, and PayPal won't accept the same type again. This time it is submitted as OTHER, with the tracking number in the notes.
            </p>
          )}
          {current.paypalOperation && <div className="op-line" style={{ marginBottom: 10 }}>{current.paypalOperation}</div>}
          {current.type === 'none' ? (
            <p className="muted small">This verdict has no action that can be run directly.</p>
          ) : (
            <>
              {/* 侧栏自己滚动，主按钮吸在底部，不用先滚到面板最下面才能点。 */}
              <div className="action-cta">
                <button className={`btn ${MONEY_ACTIONS.has(current.type) ? 'btn-danger' : 'btn-primary'}`} style={{ width: '100%' }} disabled={!isAllowed || !!unresolved || !!processing || fundLocked || (current.type === 'acknowledge_return_item' && !ackType)} onClick={openConfirm}>
                  {current.label}…
                </button>
              </div>
              {fundLocked && isAllowed && (
                <p className="small muted" style={{ marginTop: 6 }}>
                  This is a money action. Only the owner can confirm it. Ask the owner to sign in and run it.
                </p>
              )}
              {!isAllowed && (
                <p className="small muted" style={{ marginTop: 6 }}>
                  {paypal.status === 'UNDER_REVIEW'
                    ? 'PayPal is reviewing this dispute, so no actions are possible right now. If you just submitted, the status usually updates in about 30 seconds. Refresh the page and try again then.'
                    : 'PayPal\'s current status does not allow this action.'}
                </p>
              )}
            </>
          )}
        </>
      )}

      {actions.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <h3 style={{ marginBottom: 4 }}>
            Action history
          </h3>
          {actions.map((a) => (
            <div key={a.id} className="small" style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
              <div className="between">
                <strong>
                  {TYPE_LABEL[a.type] ?? a.type}
                  {a.response?.offer_type === 'REFUND_WITH_RETURN' ? ' (return required)' : ''}
                </strong>
                <span className={`badge ${a.status === 'succeeded' ? 'level-low' : a.status === 'failed' ? 'level-high' : ''}`}>
                  {STATUS_TEXT[a.status] ?? a.status}
                </span>
              </div>
              <div className="muted">
                {fmtDateTime(a.confirmedAt)} · Confirmed by {a.confirmedBy}
                {a.response?.simulated ? ' · Simulated call' : a.response?.environment === 'sandbox' ? ' · Sandbox call' : ''}
                {a.response?.reconciled ? ' · Manually reconciled' : ''}
              </div>
              {typeof a.response?.operation === 'string' && <div className="muted mono">{a.response.operation}</div>}
              {typeof a.response?.error === 'string' && <div style={{ color: 'var(--high)' }}>{a.response.error}</div>}
              {Array.isArray(a.response?.documents) && a.response.documents.length > 0 && (
                <div className="muted">Attachments: {(a.response.documents as string[]).join(', ')}</div>
              )}
              {typeof a.response?.reportSkipped === 'string' && <div style={{ color: 'var(--medium, #9a6700)' }}>Report not attached: {a.response.reportSkipped}</div>}
              {typeof a.response?.message === 'string' && <div style={{ marginTop: 3, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{a.response.message}</div>}
            </div>
          ))}
        </div>
      )}

      {confirming && current && (
        <div className="modal-back" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
          <div className="modal">
            <h2 id="confirm-title">Confirm: {current.label}</h2>
            <dl className="kv">
              <dt>PayPal operation</dt>
              <dd className="mono">{current.paypalOperation}</dd>
              {moneyAmount !== null && (
                <>
                  <dt>Amount</dt>
                  <dd>
                    <strong>{fmtMoney(moneyAmount, current.type === 'accept_claim' ? (paypal.currency ?? order.currency) : order.currency)}</strong>
                    {current.type === 'make_offer' ? (offerWithReturn ? ' (refund-with-return offer: refunded after the buyer accepts and ships the item back)' : ' (offer: takes effect once the buyer accepts)') : ''}
                  </dd>
                </>
              )}
              <dt>Recipient</dt>
              <dd>{recipient}</dd>
              {current.type === 'make_offer' && offerWithReturn && (
                <>
                  <dt>Return address</dt>
                  <dd>{paypal.returnAddress}</dd>
                </>
              )}
              {(current.type === 'provide_evidence' || current.type === 'appeal') && (
                <>
                  <dt>Evidence type</dt>
                  <dd className="mono">{evidenceType}</dd>
                </>
              )}
              {ATTACH_TYPES.has(current.type) && (
                <>
                  <dt>Attachments</dt>
                  <dd>{attachmentSummary(REPORT_TYPES.has(current.type) && attachReport && paypal.reportAvailable, attachEvidence ? paypal.attachments : 0)}</dd>
                </>
              )}
              {current.type === 'acknowledge_return_item' && (
                <>
                  <dt>Inspection result</dt>
                  <dd>
                    {ackType ? (
                      <>
                        {ACK_LABEL[ackType]} <span className="mono small">{ackType}</span>
                      </>
                    ) : (
                      'Not selected'
                    )}
                  </dd>
                  {ackType === 'ITEM_RECEIVED' && (
                    <>
                      <dt>Funds</dt>
                      <dd>
                        <strong>PayPal will refund the offer amount the buyer accepted and close the case</strong> (about 2 minutes in sandbox testing)
                      </dd>
                    </>
                  )}
                </>
              )}
              {current.trackingNumber && (
                <>
                  <dt>Tracking number</dt>
                  <dd className="mono">
                    {current.carrier} {current.trackingNumber}
                  </dd>
                </>
              )}
              {(current.type === 'send_message' || current.type === 'refund') && message && (
                <>
                  <dt>Message</dt>
                  <dd>{message.replaceAll(PORTAL_LINK_PLACEHOLDER, '(replaced with a one-time claim page link when sent)')}</dd>
                </>
              )}
              {current.type !== 'send_message' && current.type !== 'refund' && notes && (
                <>
                  <dt>Notes</dt>
                  <dd>{notes}</dd>
                </>
              )}
            </dl>
            <p className="notice" style={{ marginBottom: 14 }}>
              {paypal.env === 'sandbox'
                ? 'This makes a real call to the PayPal sandbox. It uses sandbox test funds, so no real money moves, but it cannot be undone once run.'
                : 'This is a demo environment. The PayPal simulator runs this action, so no real money moves. In production this step cannot be undone.'}
            </p>
            {error && (
              <p className="notice notice-danger" style={{ marginBottom: 14 }}>
                {error}
              </p>
            )}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button
                className={`btn ${MONEY_ACTIONS.has(current.type) || (current.type === 'acknowledge_return_item' && ackType === 'ITEM_RECEIVED') ? 'btn-danger' : 'btn-primary'}`}
                disabled={busy}
                onClick={execute}
              >
                {busy ? 'Running…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function attachmentSummary(report: boolean, images: number): string {
  const parts = [report ? 'Verification report PDF' : null, images > 0 ? `${images} key evidence images` : null].filter(Boolean);
  return parts.length ? parts.join(' + ') : 'No files attached';
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
  ackType: ReturnAckType | '';
  setAckType: (v: ReturnAckType | '') => void;
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
          Amount ({p.currency}, max {p.maxAmount.toFixed(2)})
          <input type="number" min="0.01" step="0.01" max={p.maxAmount} value={p.amount} onChange={(e) => p.setAmount(e.target.value)} />
        </label>
      )}
      {p.returnChoice !== 'none' && (
        <div className="field">
          <label className="row">
            <input type="checkbox" checked={p.withReturn} disabled={p.returnChoice === 'required'} onChange={(e) => p.setWithReturn(e.target.checked)} />
            {p.returnChoice === 'required' ? 'Require the buyer to return the item first (PayPal only accepts refund-with-return offers for this dispute)' : 'Require the buyer to return the item first; refund after the return arrives'}
          </label>
          {p.withReturn && <span className="muted small" style={{ display: 'block' }}>Return address: {p.returnAddress} (see Settings)</span>}
        </div>
      )}
      {(t === 'send_message' || t === 'refund') && (
        <label className="field">
          Message to buyer (editable)
          <textarea rows={5} value={p.message} onChange={(e) => p.setMessage(e.target.value)} />
          {p.message.includes(PORTAL_LINK_PLACEHOLDER) && (
            <span className="muted small" style={{ display: 'block' }}>
              {PORTAL_LINK_PLACEHOLDER} is replaced with a one-time link for this buyer when sent.
            </span>
          )}
        </label>
      )}
      {t === 'acknowledge_return_item' && (
        <label className="field">
          Inspection result (choose based on what you found when opening it)
          <select value={p.ackType} onChange={(e) => p.setAckType(e.target.value as ReturnAckType | '')}>
            <option value="" disabled>
              Choose inspection result
            </option>
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
          {t === 'provide_evidence' || t === 'appeal' || t === 'provide_supporting_info' ? 'Notes for PayPal (editable)' : 'Notes (editable)'}
          <textarea rows={t === 'accept_claim' || t === 'acknowledge_return_item' ? 2 : 5} value={p.notes} onChange={(e) => p.setNotes(e.target.value)} />
        </label>
      )}
      {p.shadow && ATTACH_TYPES.has(t) && (
        <p className="muted small" style={{ marginBottom: 12 }}>
          In shadow mode the verification report is not attached and evidence images are not picked automatically (both would reveal the verdict). If you need attachments, upload them manually in PayPal.
        </p>
      )}
      {!p.shadow && REPORT_TYPES.has(t) && (
        <label className="row" style={{ marginBottom: 6 }}>
          <input type="checkbox" checked={p.attachReport && p.reportAvailable} disabled={!p.reportAvailable} onChange={(e) => p.setAttachReport(e.target.checked)} />
          {p.reportAvailable ? 'Attach verification report PDF (PayPal version, without internal risk flags or drafts)' : 'The server has no CJK font for the report PDF'}
        </label>
      )}
      {!p.shadow && ATTACH_TYPES.has(t) && (
        <label className="row" style={{ marginBottom: 12 }}>
          <input type="checkbox" checked={p.attachEvidence} disabled={p.attachmentCount === 0} onChange={(e) => p.setAttachEvidence(e.target.checked)} />
          {p.attachmentCount > 0 ? `Attach key evidence images (${p.attachmentCount})` : 'No evidence images to attach'}
        </label>
      )}
    </>
  );
}
