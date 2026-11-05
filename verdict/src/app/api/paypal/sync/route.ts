import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { isCrossSite } from '@/server/origin';
import { syncSandboxDisputes } from '@/server/paypal-sync';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (isCrossSite(req)) return NextResponse.json({ error: '拒绝跨站请求' }, { status: 403 });
  await ready();
  try {
    const state = await syncSandboxDisputes();
    return NextResponse.json(state, { status: state.ok ? 200 : 502 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
  }
}
