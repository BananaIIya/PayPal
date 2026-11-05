import { NextRequest, NextResponse } from 'next/server';
import { resolveAction } from '@/server/actions';
import { CURRENT_USER, ready } from '@/server/bootstrap';
import { isCrossSite } from '@/server/origin';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; actionId: string }> }) {
  if (isCrossSite(req)) return NextResponse.json({ error: '拒绝跨站请求' }, { status: 403 });
  await ready();
  const { id, actionId } = await params;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: '请求体无效' }, { status: 400 });
  const out = resolveAction({ claimId: id, actionId, outcome: body.outcome, confirm: body.confirm, confirmedBy: CURRENT_USER.id });
  return NextResponse.json(out.body, { status: out.status });
}
