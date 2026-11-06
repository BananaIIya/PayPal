import { NextRequest, NextResponse } from 'next/server';
import { login } from '@/server/auth';
import { ready } from '@/server/bootstrap';
import { safeNext, setSessionCookie } from '@/server/guard';
import { isCrossSite } from '@/server/origin';
import { limitAuth } from '@/server/rate-limit';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  // 登录也要拦跨站请求：否则别的网站能让你登录进它控制的账号（登录 CSRF）。
  if (isCrossSite(req)) return NextResponse.json({ error: '拒绝跨站请求' }, { status: 403 });
  const limited = limitAuth(req);
  if (limited) return limited;
  await ready();
  const body = (await req.json().catch(() => ({}))) as { email?: unknown; password?: unknown; next?: unknown };
  const result = await login(body.email, body.password);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return setSessionCookie(NextResponse.json({ ok: true, next: safeNext(body.next) }), req, result.sessionToken);
}
