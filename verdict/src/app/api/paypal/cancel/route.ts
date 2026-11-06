import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { authorize } from '@/server/guard';
import { requestOrigin } from '@/server/origin';
import { cancelTestOrder } from '@/server/sandbox-shop';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  await ready();
  const auth = authorize(req, { owner: true, ownerReason: '只有店主可以创建沙箱测试订单' });
  if (auth instanceof NextResponse) return auth;
  cancelTestOrder(req.nextUrl.searchParams.get('token') ?? '');
  return NextResponse.redirect(`${requestOrigin(req)}/orders`, 303);
}
