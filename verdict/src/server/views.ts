import { FOLLOW_UP_TYPES, followUpDraft, returnOfferDraft } from '@/core/recommend';
import { paypalState } from './actions';
import { selectAttachmentEvidence } from './attachments';
import { claimDetail, formatReturnAddress, getClaim, getOrder, getPolicy, merchantReturnAddress } from './repo';
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
  const canOfferReturn =
    state.allowed.includes('make_offer') &&
    !state.allowed.includes('acknowledge_return_item') &&
    !!dispute?.offerTypes.includes('REFUND_WITH_RETURN') &&
    getPolicy(claim.merchant_id, order.category).returnable &&
    !suggested.some((a) => a.type === 'make_offer' && a.withReturn);
  const view = {
    ...detail,
    allowedActions: state.allowed,
    /** PayPal 当前允许、但判定引擎不会主动建议的后续操作（补充说明、确认退货、申诉）的草稿。 */
    followUps: report
      ? [
          ...(canOfferReturn ? [returnOfferDraft({ amount: dispute?.amount ?? order.amount, currency: dispute?.currency ?? order.currency })] : []),
          ...FOLLOW_UP_TYPES.filter((t) => state.allowed.includes(t)).map((t) =>
            followUpDraft(t, report, { trackingNumber: order.tracking_number, carrier: order.carrier }),
          ),
        ]
      : [],
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
      attachments: selectAttachmentEvidence(id).length,
      /** 服务器上有可内嵌的中文字体时才能生成 PDF 报告。 */
      reportAvailable: findReportFont() !== null,
      captureWarning: capture?.warning ?? null,
    },
  };
  // node:sqlite 的行没有原型，React 不允许这种对象跨过服务端到客户端组件的边界。
  return JSON.parse(JSON.stringify(view)) as typeof view;
}
export type ClaimViewData = NonNullable<Awaited<ReturnType<typeof claimView>>>;
