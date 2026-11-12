import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { authorize } from '@/server/guard';
import { CLAIM_TYPE_BY_REASON, simulateDispute } from '@/server/ingest';
import { getOrder } from '@/server/repo';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  await ready();
  const auth = authorize(req, { write: true });
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => ({}));
  if (!getOrder(String(body.orderId))) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  const reason = String(body.reason);
  if (!(reason in CLAIM_TYPE_BY_REASON)) return NextResponse.json({ error: 'Invalid dispute reason' }, { status: 400 });
  const out = await simulateDispute(String(body.orderId), reason, String(body.message ?? 'The buyer opened a dispute on PayPal.').slice(0, 2000));
  return NextResponse.json(out.body, { status: out.status });
}
