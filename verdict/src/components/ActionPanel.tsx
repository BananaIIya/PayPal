'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { PORTAL_LINK_PLACEHOLDER } from '@/core/recommend';
import type { ActionType, SuggestedAction, VerdictReport } from '@/core/types';
import type { ClaimViewData } from '@/server/views';
import { fmtDateTime, fmtMoney } from './format';

const TYPE_LABEL: Record<string, string> = {
  refund: '退款',
  accept_claim: '接受索赔',
  send_message: '发送消息',
  provide_evidence: '提交证据',
  make_offer: '提出和解',
  escalate: '升级争议',
};

const MONEY_ACTIONS = new Set(['refund', 'accept_claim', 'make_offer']);

interface Props {
  claimId: string;
  verdictId: string;
  report: VerdictReport;
  claim: ClaimViewData['claim'];
  order: ClaimViewData['order'];
  allowed: ActionType[];
  actions: ClaimViewData['actions'];
  paypal: ClaimViewData['paypal'];
  onDone: () => Promise<void>;
}

const STUCK_PENDING_MS = 2 * 60 * 1000;
const STATUS_TEXT: Record<string, string> = { succeeded: '成功', failed: '失败', unknown: '结果不明', pending: '执行中' };

export function ActionPanel({ claimId, verdictId, report, claim, order, allowed, actions, paypal, onDone }: Props) {
  const options = useMemo(() => [report.primaryAction, ...report.alternatives], [report]);
  const [index, setIndex] = useState(0);
  const current = options[index] ?? options[0];

  const [message, setMessage] = useState('');
  const [notes, setNotes] = useState('');
  const [amount, setAmount] = useState('');
  const [attachEvidence, setAttachEvidence] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useRef<string | null>(null);

  useEffect(() => {
    setMessage(current.message ?? '');
    setNotes(current.notes ?? '');
    const initial = current.offerAmount ?? current.refundAmount;
    setAmount(initial !== undefined ? String(initial) : '');
    setAttachEvidence(current.attachEvidence ?? true);
    setError(null);
  }, [current]);

  const isAllowed = current.type !== 'none' && allowed.includes(current.type);
  const closed = claim.status === 'closed';
  const unresolved = actions.find(
    (a) => a.status === 'unknown' || (a.status === 'pending' && Date.now() - new Date(a.confirmedAt).getTime() > STUCK_PENDING_MS),
  );

  const payload = () => ({
    message: current.type === 'send_message' || current.type === 'refund' ? message : undefined,
    notes: current.type !== 'send_message' ? notes : undefined,
    evidenceType: current.evidenceType,
    amount: current.type === 'refund' || current.type === 'make_offer' ? Number(amount) : undefined,
    trackingNumber: current.trackingNumber,
    carrier: current.carrier,
    attachEvidence: current.type === 'provide_evidence' ? attachEvidence : undefined,
  });

  function openConfirm() {
    // 同一次确认复用同一个幂等键，连点两次也只执行一次。
    idempotencyKey.current = crypto.randomUUID();
    setError(null);
    setConfirming(true);
  }

  async function execute() {
    setBusy(true);
    setError(null);
    let res: Response;
    try {
      res = await fetch(`/api/claims/${claimId}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey.current! },
        body: JSON.stringify({ type: current.type, verdictId, confirm: true, payload: payload() }),
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
    current.type === 'accept_claim'
      ? (paypal.amount ?? order.amount)
      : current.type === 'refund' || current.type === 'make_offer'
        ? Number(amount)
        : null;

  const recipient = claim.disputeId
    ? `买家（经 PayPal 争议 ${claim.disputeId}）`
    : order.buyerName
      ? `买家 ${order.buyerName}`
      : '买家';

  return (
    <section className="card card-pad action-card">
      <h2>建议动作</h2>
      {unresolved && (
        <div className="notice notice-danger" style={{ marginBottom: 12 }}>
          <strong>{TYPE_LABEL[unresolved.type] ?? unresolved.type}的结果不明。</strong>
          PayPal 没有给出明确答复，这个动作可能已经生效。请先到 PayPal 沙箱后台核对，标记之前这笔索赔不能再执行动作，以免重复退款。
          {typeof unresolved.response?.error === 'string' && <div className="small" style={{ marginTop: 4 }}>{unresolved.response.error}</div>}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn" disabled={busy} onClick={() => reconcile(unresolved.id, 'succeeded')}>
              已生效
            </button>
            <button className="btn" disabled={busy} onClick={() => reconcile(unresolved.id, 'failed')}>
              没有生效
            </button>
          </div>
          {!confirming && error && <div style={{ marginTop: 8 }}>{error}</div>}
        </div>
      )}
      {options.length > 1 && !closed && (
        <div className="action-tabs" role="group" aria-label="选择动作">
          {options.map((o, i) => (
            <button key={`${o.type}-${o.label}`} className="action-tab" aria-pressed={i === index} onClick={() => setIndex(i)}>
              {i === 0 ? `建议：${o.label}` : o.label}
            </button>
          ))}
        </div>
      )}
      {closed ? (
        <p className="muted">这笔索赔已结案。</p>
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
            attachmentCount={paypal.attachments}
            currency={order.currency}
            maxAmount={order.amount}
          />
          {current.paypalOperation && <div className="op-line" style={{ marginBottom: 10 }}>{current.paypalOperation}</div>}
          {current.type === 'none' ? (
            <p className="muted small">这个判定没有可以直接执行的动作。</p>
          ) : (
            <>
              <button className={`btn ${MONEY_ACTIONS.has(current.type) ? 'btn-danger' : 'btn-primary'}`} style={{ width: '100%' }} disabled={!isAllowed || !!unresolved} onClick={openConfirm}>
                {current.label}…
              </button>
              {!isAllowed && <p className="small muted" style={{ marginTop: 6 }}>PayPal 当前状态不允许这个动作。</p>}
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
                <strong>{TYPE_LABEL[a.type] ?? a.type}</strong>
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
              {typeof a.response?.message === 'string' && <div style={{ marginTop: 3, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{a.response.message}</div>}
            </div>
          ))}
        </div>
      )}

      {confirming && (
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
                    {current.type === 'make_offer' ? '（和解提议，买家接受后生效）' : ''}
                  </dd>
                </>
              )}
              <dt>收件方</dt>
              <dd>{recipient}</dd>
              {current.type === 'provide_evidence' && (
                <>
                  <dt>证据类型</dt>
                  <dd className="mono">{current.evidenceType}</dd>
                  <dt>附件</dt>
                  <dd>{attachEvidence && paypal.attachments > 0 ? `${paypal.attachments} 张关键证据图片` : '不附图片'}</dd>
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
              <button className={`btn ${MONEY_ACTIONS.has(current.type) ? 'btn-danger' : 'btn-primary'}`} disabled={busy} onClick={execute}>
                {busy ? '执行中…' : '确认执行'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
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
  attachmentCount: number;
  currency: string;
  maxAmount: number;
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
      {(t === 'provide_evidence' || t === 'make_offer' || t === 'accept_claim') && (
        <label className="field">
          {t === 'provide_evidence' ? '提交给 PayPal 的说明（可编辑）' : '说明（可编辑）'}
          <textarea rows={t === 'accept_claim' ? 2 : 5} value={p.notes} onChange={(e) => p.setNotes(e.target.value)} />
        </label>
      )}
      {t === 'provide_evidence' && (
        <label className="row" style={{ marginBottom: 12 }}>
          <input type="checkbox" checked={p.attachEvidence} disabled={p.attachmentCount === 0} onChange={(e) => p.setAttachEvidence(e.target.checked)} />
          {p.attachmentCount > 0 ? `附关键证据图片（${p.attachmentCount} 张）` : '没有可以附上的证据图片'}
        </label>
      )}
    </>
  );
}
