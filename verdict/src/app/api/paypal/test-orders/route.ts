import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { authorize } from '@/server/guard';
import { requestOrigin } from '@/server/origin';
import { createTestOrder } from '@/server/sandbox-shop';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  await ready();
  const auth = authorize(req, { write: true, owner: true, ownerReason: '只有店主可以创建沙箱测试订单' });
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => null);
  try {
    return NextResponse.json(await createTestOrder(String(body?.productKey ?? ''), requestOrigin(req)));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
