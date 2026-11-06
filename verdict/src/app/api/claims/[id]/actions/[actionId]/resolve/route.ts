import { NextRequest, NextResponse } from 'next/server';
import { resolveAction } from '@/server/actions';
import { ready } from '@/server/bootstrap';
import { authorize } from '@/server/guard';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; actionId: string }> }) {
  await ready();
  const auth = authorize(req, { write: true });
  if (auth instanceof NextResponse) return auth;
  const { id, actionId } = await params;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: '请求体无效' }, { status: 400 });
  const out = resolveAction({ claimId: id, actionId, outcome: body.outcome, confirm: body.confirm, actor: auth });
  return NextResponse.json(out.body, { status: out.status });
}
