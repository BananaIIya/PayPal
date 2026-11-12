// 把账号接到路由和页面上。proxy.ts 只做“有没有 cookie”的粗筛，真正的校验在这里，每个接口和页面各自调用。
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextResponse, type NextRequest } from 'next/server';
import type { Role } from '@/core/types';
import { SESSION_MAX_MS, sessionUser, type AuthUser } from './auth';
import { SESSION_COOKIE } from './cookie-name';
import { isCrossSite } from './origin';

export interface GuardOptions {
  /** 写接口：拒绝跨站请求。cookie 是 SameSite=Lax，这里再按 Origin 拦一次。 */
  write?: boolean;
  /** 只有店主能做。 */
  owner?: boolean;
  /** 店主限定时给客服看的说明。 */
  ownerReason?: string;
}

export function authorize(req: NextRequest, opts: GuardOptions = {}): AuthUser | NextResponse {
  if (opts.write && isCrossSite(req)) return NextResponse.json({ error: 'Cross-site request rejected' }, { status: 403 });
  const user = sessionUser(req.cookies.get(SESSION_COOKIE)?.value);
  if (!user) return NextResponse.json({ error: 'Sign in first' }, { status: 401 });
  if (opts.owner && user.role !== 'owner') {
    return NextResponse.json({ error: opts.ownerReason ?? 'Only the owner can do this' }, { status: 403 });
  }
  return user;
}

function isHttps(req: NextRequest): boolean {
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? req.nextUrl.protocol.replace(':', '');
  return proto === 'https';
}

export function setSessionCookie(res: NextResponse, req: NextRequest, token: string): NextResponse {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps(req),
    path: '/',
    maxAge: Math.floor(SESSION_MAX_MS / 1000),
  });
  return res;
}

export function clearSessionCookie(res: NextResponse): NextResponse {
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
  return res;
}

export async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/** 控制台页面用：没登录就去登录页。 */
export async function pageUser(): Promise<AuthUser> {
  const user = sessionUser(await sessionToken());
  if (!user) redirect('/login');
  return user;
}

export async function optionalPageUser(): Promise<AuthUser | null> {
  return sessionUser(await sessionToken());
}

/** 传给客户端组件的当前用户，只有显示和按钮开关需要的字段。 */
export interface Viewer {
  id: string;
  name: string;
  role: Role;
}

export function viewerOf(user: AuthUser): Viewer {
  return { id: user.id, name: user.name, role: user.role };
}

/** 登录后跳回的地址只接受站内相对路径，防止被拿来做开放重定向。 */
export function safeNext(next: unknown): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/claims';
  if (/^\/(login|setup|invite)(\/|\?|$)/.test(next)) return '/claims';
  return next.slice(0, 500);
}
