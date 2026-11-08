import { FOLLOW_UP_TYPES, followUpDraft, neutralActions, returnOfferDraft } from '@/core/recommend';
import type { SuggestedAction } from '@/core/types';
import { identityRefundAllowed, paypalState, payoutBlockedByVerdict } from './actions';
import { selectAttachmentEvidence } from './attachments';
import { claimDetail, formatReturnAddress, getClaim, getOrder, getPolicy, merchantAgreedRefund, merchantReturnAddress, shadowModeOn } from './repo';
import { findReportFont } from './report-pdf';
import { captureState } from './sandbox-shop';

export async function claimView(id: string) {
  const detail = claimDetail(id);
  if (!detail) return null;
  const claim = getClaim(id)!;
  const order = getOrder(claim.order_id)!;
  const state = await paypalState(claim, order);
  const dispute = state.dispute;
  const report = detail.verdict?.report;
  // 有争议时付款被暂扣是正常的；没有争议时这决定了退款能不能成功。
  const capture = claim.paypal_dispute_id || claim.status === 'closed' ? null : await captureState(order);
  // PayPal 允许退货退款、类目也适合退回时，额外给出这个选项；建议列表里已有同类动作就不重复。
  const suggested = report ? [report.primaryAction, ...report.alternatives] : [];
  // 买家已经寄回（PayPal 给出确认退货）时，PayPal 仍会列出 make_offer，这时再提退货退款没有意义。
  const returnPossible =
    state.allowed.includes('make_offer') &&
    !state.allowed.includes('acknowledge_return_item') &&
    !!dispute?.offerTypes.includes('REFUND_WITH_RETURN') &&
    getPolicy(claim.merchant_id, order.category).returnable;
  const canOfferReturn = returnPossible && !suggested.some((a) => a.type === 'make_offer' && a.withReturn);
  const amount = dispute?.amount ?? order.amount;
  const currency = dispute?.currency ?? order.currency;
  const closed = claim.status === 'closed';
  const shadow = shadowModeOn(claim.merchant_id);
  /** PayPal 当前允许、但判定引擎不会主动建议的后续操作（补充说明、确认退货、申诉）的草稿。 */
  const followUps: SuggestedAction[] = report
    ? [
        ...(canOfferReturn ? [returnOfferDraft({ amount, currency })] : []),
        ...FOLLOW_UP_TYPES.filter((t) => state.allowed.includes(t)).map((t) =>
          followUpDraft(t, report, { trackingNumber: order.tracking_number, carrier: order.carrier }),
        ),
      ]
    : [];
  /** 动作面板的选项：第一项是判定建议；已结案时只剩 PayPal 仍然开放的后续操作。影子模式下换成中性选项。 */
  const rawOptions: SuggestedAction[] = !report
    ? []
    : shadow
      ? neutralActions({
          allowed: state.allowed,
          hasDispute: !!claim.paypal_dispute_id,
          closed,
          amount,
          currency,
          trackingNumber: order.tracking_number,
          carrier: order.carrier,
          canOfferReturn: returnPossible,
        })
      : closed
        ? followUps
        : [report.primaryAction, ...report.alternatives, ...followUps];
  // 面板上不留会被执行器拒绝的退款按钮。建议本身就是退款或和解，以及错发排查时的退款，才保留。
  // 影子模式仍用中性文案，但同样拿掉不能执行的资金按钮。
  const actionOptions = report
    ? rawOptions.filter(
        (a) =>
          !payoutBlockedByVerdict(
            {
              level: report.level,
              suggestedAction: report.primaryAction.type,
              identityRefund: identityRefundAllowed(report.findings),
              alreadyAgreed: merchantAgreedRefund(order.id),
            },
            a,
          ),
      )
    : rawOptions;
  const base = {
    ...detail,
    allowedActions: state.allowed,
    followUps: shadow ? [] : followUps,
    actionOptions,
    /** 影子模式：判定照常计算，但不显示给处理人员。 */
    shadow,
    paypal: {
      env: state.env,
      error: state.error,
      status: dispute?.status ?? null,
      stage: dispute?.stage ?? null,
      outcome: dispute?.outcome ?? null,
      amount: dispute?.amount ?? null,
      currency: dispute?.currency ?? null,
      sandboxTools: dispute?.sandboxTools ?? { requireEvidence: false, adjudicate: false },
      /** PayPal 允许的和解类型，含 REFUND_WITH_RETURN 时可以要求买家先退货。 */
      offerTypes: dispute?.offerTypes ?? [],
      submittedEvidenceTypes: dispute?.submittedEvidenceTypes ?? [],
      returnAddress: formatReturnAddress(merchantReturnAddress(claim.merchant_id)),
      // 自动挑选的附件来自反驳索赔的信号，影子模式下数量本身就会透露判定，所以不自动附件。
      attachments: shadow ? 0 : selectAttachmentEvidence(id).length,
      /** 服务器上有可内嵌的中文字体时才能生成 PDF 报告。 */
      reportAvailable: !shadow && findReportFont() !== null,
      captureWarning: capture?.warning ?? null,
    },
  };
  /**
   * 影子模式下去掉一切会透露判定的内容：判定报告、信号、分析器备注、演示场景说明、
   * 时间线里“判定等级变化”的细节。保留判定 ID，动作仍然要绑定到具体判定上，事后才能对照。
   */
  const view = shadow
    ? {
        ...base,
        verdict: base.verdict ? { id: base.verdict.id, createdAt: base.verdict.createdAt, report: null } : null,
        signals: [] as typeof base.signals,
        runs: base.runs.map((r) => ({ ...r, note: null })),
        // 演示场景的标题、故事和文档期望都会透露判定。
        claim: { ...base.claim, scenario: null },
        timeline: base.timeline.map((t) => (t.title === '判定设置修改后重新判定' ? { ...t, detail: null } : t)),
      }
    : base;
  // node:sqlite 的行没有原型，React 不允许这种对象跨过服务端到客户端组件的边界。
  return JSON.parse(JSON.stringify(view)) as typeof view;
}
export type ClaimViewData = NonNullable<Awaited<ReturnType<typeof claimView>>>;
