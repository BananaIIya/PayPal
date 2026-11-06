import { NextRequest, NextResponse } from 'next/server';
import { reissueLink } from '@/server/auth';
import { ready } from '@/server/bootstrap';
import { authorize } from '@/server/guard';
import { requestOrigin } from '@/server/origin';

export const dynamic = 'force-dynamic';

/** 重新生成设置密码链接。之前没用过的链接作废。 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ready();
  const auth = authorize(req, { write: true, owner: true, ownerReason: '只有店主可以管理成员' });
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const result = reissueLink(auth, id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ link: `${requestOrigin(req)}/invite/${result.token}`, purpose: result.purpose });
}
