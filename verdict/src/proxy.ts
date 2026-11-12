// 粗筛：没有会话 cookie 的请求，页面跳登录页，接口返回 401。
// 这里不查数据库，cookie 是否有效由各接口和页面里的 authorize / pageUser 判断（Next 文档：proxy 只做乐观检查）。
// 它的价值是兜底：以后新加的控制台接口忘了校验，至少也挡住了没登录的请求。
import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/server/cookie-name';

/** 不需要控制台登录的路径：买家索赔页（凭签名 token）、PayPal 回调（验签）、商家系统推送（API 密钥）、登录相关页面。 */
function isPublic(pathname: string): boolean {
  if (pathname === '/api/orders') return true;
  return ['/login', '/setup', '/invite/', '/c/', '/api/portal/', '/api/auth/', '/webhooks/'].some(
    (p) => pathname === p.replace(/\/$/, '') || pathname.startsWith(p.endsWith('/') ? p : `${p}/`),
  );
}

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (isPublic(pathname) || req.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'Sign in first' }, { status: 401 });
  const url = new URL('/login', req.url);
  if (pathname !== '/') url.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(url);
}

export const config = {
  // icon.svg 是站点图标，登录页和买家索赔页（都没有会话）也要能加载。
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
