import { paypalState } from './actions';
import { selectAttachmentEvidence } from './attachments';
import { claimDetail, getClaim, getOrder } from './repo';

export async function claimView(id: string) {
  const detail = claimDetail(id);
  if (!detail) return null;
  const claim = getClaim(id)!;
  const state = await paypalState(claim, getOrder(claim.order_id)!);
  const dispute = state.dispute;
  const view = {
    ...detail,
    allowedActions: state.allowed,
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
    },
  };
  // node:sqlite 的行没有原型，React 不允许这种对象跨过服务端到客户端组件的边界。
  return JSON.parse(JSON.stringify(view)) as typeof view;
}
export type ClaimViewData = NonNullable<Awaited<ReturnType<typeof claimView>>>;
