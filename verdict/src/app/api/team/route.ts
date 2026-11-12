import { NextRequest, NextResponse } from 'next/server';
import { inviteMember, listMembers } from '@/server/auth';
import { ready } from '@/server/bootstrap';
import { authorize } from '@/server/guard';
import { requestOrigin } from '@/server/origin';

export const dynamic = 'force-dynamic';

const OWNER_ONLY = 'Only the owner can manage members';

export async function GET(req: NextRequest) {
  await ready();
  const auth = authorize(req, { owner: true, ownerReason: OWNER_ONLY });
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json({ members: listMembers(auth.merchantId) });
}

/** 添加成员，返回一次性的设置密码链接（72 小时内有效）。店主自己发给对方，系统不发邮件。 */
export async function POST(req: NextRequest) {
  await ready();
  const auth = authorize(req, { write: true, owner: true, ownerReason: OWNER_ONLY });
  if (auth instanceof NextResponse) return auth;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const result = inviteMember({ merchantId: auth.merchantId, name: body.name, email: body.email, role: body.role });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  const member = listMembers(auth.merchantId).find((m) => m.id === result.user.id);
  return NextResponse.json({ member, link: `${requestOrigin(req)}/invite/${result.token}` }, { status: 201 });
}
