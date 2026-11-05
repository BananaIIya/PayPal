import { NextRequest, NextResponse } from 'next/server';
import { executeAction } from '@/server/actions';
import { CURRENT_USER, ready } from '@/server/bootstrap';
import { requestOrigin } from '@/server/origin';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: '请求体无效' }, { status: 400 });
  const out = await executeAction({
    claimId: id,
    type: body.type,
    verdictId: body.verdictId,
    confirm: body.confirm,
    payload: body.payload ?? {},
    idempotencyKey: req.headers.get('idempotency-key') ?? '',
    confirmedBy: CURRENT_USER.id,
    origin: requestOrigin(req),
  });
  return NextResponse.json(out.body, { status: out.status });
}
