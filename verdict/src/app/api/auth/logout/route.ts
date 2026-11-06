import { NextRequest, NextResponse } from 'next/server';
import { destroySession } from '@/server/auth';
import { SESSION_COOKIE } from '@/server/cookie-name';
import { clearSessionCookie } from '@/server/guard';
import { isCrossSite } from '@/server/origin';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (isCrossSite(req)) return NextResponse.json({ error: '拒绝跨站请求' }, { status: 403 });
  destroySession(req.cookies.get(SESSION_COOKIE)?.value);
  return clearSessionCookie(NextResponse.json({ ok: true }));
}
