import { NextRequest, NextResponse } from 'next/server';
import { changePassword, setPasswordWithLink } from '@/server/auth';
import { ready } from '@/server/bootstrap';
import { SESSION_COOKIE } from '@/server/cookie-name';
import { authorize, setSessionCookie } from '@/server/guard';
import { isCrossSite } from '@/server/origin';
import { limitAuth } from '@/server/rate-limit';

export const dynamic = 'force-dynamic';

/** 用邀请或重置链接设置密码，成功后直接登录。 */
export async function POST(req: NextRequest) {
  if (isCrossSite(req)) return NextResponse.json({ error: '拒绝跨站请求' }, { status: 403 });
  const limited = limitAuth(req);
  if (limited) return limited;
  await ready();
  const body = (await req.json().catch(() => ({}))) as { token?: unknown; password?: unknown };
  const result = await setPasswordWithLink(body.token, body.password);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return setSessionCookie(NextResponse.json({ ok: true }), req, result.sessionToken);
}

/** 已登录时修改自己的密码。其他设备上的登录会失效，当前这个保留。 */
export async function PUT(req: NextRequest) {
  const limited = limitAuth(req);
  if (limited) return limited;
  await ready();
  const auth = authorize(req, { write: true });
  if (auth instanceof NextResponse) return auth;
  const body = (await req.json().catch(() => ({}))) as { current?: unknown; next?: unknown };
  const result = await changePassword(auth, body.current, body.next, req.cookies.get(SESSION_COOKIE)!.value);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
}
