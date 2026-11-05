import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { isCrossSite, requestOrigin } from '@/server/origin';
import { createTestOrder } from '@/server/sandbox-shop';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (isCrossSite(req)) return NextResponse.json({ error: '拒绝跨站请求' }, { status: 403 });
  await ready();
  const body = await req.json().catch(() => null);
  try {
    return NextResponse.json(await createTestOrder(String(body?.productKey ?? ''), requestOrigin(req)));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
