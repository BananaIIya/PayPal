import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { CLAIM_TYPE_BY_REASON, simulateDispute } from '@/server/ingest';
import { getOrder } from '@/server/repo';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  await ready();
  const body = await req.json().catch(() => ({}));
  if (!getOrder(String(body.orderId))) return NextResponse.json({ error: '订单不存在' }, { status: 404 });
  const reason = String(body.reason);
  if (!(reason in CLAIM_TYPE_BY_REASON)) return NextResponse.json({ error: '争议原因无效' }, { status: 400 });
  const out = await simulateDispute(String(body.orderId), reason, String(body.message ?? '买家在 PayPal 发起了争议。').slice(0, 2000));
  return NextResponse.json(out.body, { status: out.status });
}
