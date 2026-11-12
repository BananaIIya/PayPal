import { NextRequest, NextResponse } from 'next/server';
import { CLAIM_TYPE_LABEL, requiredShots, SHOT_HINT, SHOT_LABEL, STATUS_LABEL } from '@/core/catalog';
import type { ClaimType } from '@/core/types';
import { dataProcessors } from '@/providers/registry';
import { ready } from '@/server/bootstrap';
import { json } from '@/server/db';
import { requireToken } from '@/server/portal';
import { limitPortal } from '@/server/rate-limit';
import { claimEvidence, getClaim, getOrder, getPolicy } from '@/server/repo';

export const dynamic = 'force-dynamic';

const PORTAL_TYPES: ClaimType[] = ['not_received', 'damaged', 'not_as_described', 'missing_items'];

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  await ready();
  const { token } = await params;
  const limited = limitPortal(req, token, 'read');
  if (limited) return limited;
  const check = requireToken(token);
  if (check instanceof NextResponse) return check;
  const claim = getClaim(check.payload.claimId);
  const order = claim && getOrder(claim.order_id);
  if (!claim || !order) return NextResponse.json({ error: 'Invalid link' }, { status: 401 });

  const policy = getPolicy(claim.merchant_id, order.category);
  const items = json<{ title: string; quantity: number }[]>(order.items, []);
  const address = json<{ postalCode?: string; line1?: string } | null>(order.ship_address, null);

  return NextResponse.json({
    order: {
      orderNo: order.order_no,
      product: items[0]?.title ?? '',
      quantity: items[0]?.quantity ?? 1,
      amount: order.amount,
      currency: order.currency,
      // 只露出收货邮编后四位，让买家确认是这笔订单，又不暴露完整地址。
      addressTail: (address?.postalCode ?? address?.line1 ?? '').slice(-4),
    },
    claim: {
      status: claim.status,
      statusLabel: STATUS_LABEL[claim.status],
      type: claim.claim_type,
      lockedType: claim.origin !== 'portal',
      submittedBefore: check.used > 0,
    },
    claimTypes: PORTAL_TYPES.map((type) => ({
      type,
      label: CLAIM_TYPE_LABEL[type],
      shots: requiredShots(type, policy).map((id) => ({ id, label: SHOT_LABEL[id] ?? id, hint: SHOT_HINT[id] ?? '' })),
    })),
    processors: order.paypal_env === 'sandbox' ? [...dataProcessors(), 'PayPal (when the merchant submits dispute evidence)'] : dataProcessors(),
    // 视频抽出的帧是系统生成的，不算买家上传的内容。
    uploaded: claimEvidence(claim.id)
      .filter((e) => e.kind !== 'frame')
      .map((e) => ({ id: e.id, shot: e.shot_label, source: e.source, kind: e.kind })),
  });
}
