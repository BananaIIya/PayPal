import { NextRequest, NextResponse } from 'next/server';
import { setMemberDisabled } from '@/server/auth';
import { ready } from '@/server/bootstrap';
import { authorize } from '@/server/guard';

export const dynamic = 'force-dynamic';

/** 停用或启用成员。停用后对方所有登录立即失效。 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ready();
  const auth = authorize(req, { write: true, owner: true, ownerReason: 'Only the owner can manage members' });
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { disabled?: unknown };
  if (typeof body.disabled !== 'boolean') return NextResponse.json({ error: 'Missing disabled' }, { status: 400 });
  const result = setMemberDisabled(auth, id, body.disabled);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ member: result.member });
}
