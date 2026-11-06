import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { authorize } from '@/server/guard';
import { requestOrigin } from '@/server/origin';
import { completeTestOrder } from '@/server/sandbox-shop';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  await ready();
  const auth = authorize(req, { owner: true, ownerReason: '只有店主可以创建沙箱测试订单' });
  if (auth instanceof NextResponse) return auth;
  const origin = requestOrigin(req);
  const token = req.nextUrl.searchParams.get('token') ?? '';
  try {
    const { orderId } = await completeTestOrder(token);
    return NextResponse.redirect(`${origin}/orders/${orderId}`, 303);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.redirect(`${origin}/orders?paypal_error=${encodeURIComponent(message)}`, 303);
  }
}
