import { NextRequest, NextResponse } from 'next/server';
import { executeAction } from '@/server/actions';
import { ready } from '@/server/bootstrap';
import { authorize } from '@/server/guard';
import { requestOrigin } from '@/server/origin';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ready();
  const auth = authorize(req, { write: true });
  if (auth instanceof NextResponse) return auth;
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
    actor: auth,
    origin: requestOrigin(req),
  });
  return NextResponse.json(out.body, { status: out.status });
}
