import { FOLLOW_UP_TYPES, followUpDraft } from '@/core/recommend';
import { paypalState } from './actions';
import { selectAttachmentEvidence } from './attachments';
import { claimDetail, getClaim, getOrder } from './repo';
import { findReportFont } from './report-pdf';

export async function claimView(id: string) {
  const detail = claimDetail(id);
  if (!detail) return null;
  const claim = getClaim(id)!;
  const state = await paypalState(claim, getOrder(claim.order_id)!);
  const dispute = state.dispute;
  const report = detail.verdict?.report;
  const order = getOrder(claim.order_id)!;
  const view = {
    ...detail,
    allowedActions: state.allowed,
    /** PayPal 当前允许、但判定引擎不会主动建议的后续操作（补充说明、确认退货、申诉）的草稿。 */
    followUps: report
      ? FOLLOW_UP_TYPES.filter((t) => state.allowed.includes(t)).map((t) =>
          followUpDraft(t, report, { trackingNumber: order.tracking_number, carrier: order.carrier }),
        )
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
      attachments: selectAttachmentEvidence(id).length,
      /** 服务器上有可内嵌的中文字体时才能生成 PDF 报告。 */
      reportAvailable: findReportFont() !== null,
    },
  };
  // node:sqlite 的行没有原型，React 不允许这种对象跨过服务端到客户端组件的边界。
  return JSON.parse(JSON.stringify(view)) as typeof view;
}
export type ClaimViewData = NonNullable<Awaited<ReturnType<typeof claimView>>>;
