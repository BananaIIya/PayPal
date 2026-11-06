import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { authorize } from '@/server/guard';
import { requestOrigin } from '@/server/origin';
import { createClaim } from '@/server/ingest';
import { addTimeline, getOrder } from '@/server/repo';
import { issuePortalToken } from '@/server/tokens';

export const dynamic = 'force-dynamic';

/** 为订单新建一个等待买家提交的索赔，并生成索赔页链接。 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ready();
  const auth = authorize(req, { write: true });
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const order = getOrder(id);
  if (!order) return NextResponse.json({ error: '订单不存在' }, { status: 404 });
  const claimId = createClaim({ merchantId: order.merchant_id, orderId: id, origin: 'portal', type: 'damaged', status: 'collecting' });
  addTimeline(claimId, 'claim', '商家生成索赔页链接');
  const token = issuePortalToken({ merchantId: order.merchant_id, orderId: id, claimId });
  return NextResponse.json({ claimId, token, url: `${requestOrigin(req)}/c/${token}` });
}
