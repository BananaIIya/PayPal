import type { NextRequest } from 'next/server';

/**
 * 发给买家的链接用的地址。优先用 PUBLIC_URL。
 * 没配置时取请求的 Host，这样从局域网 IP 打开控制台时，生成的链接手机也能打开。
 * Host 由请求方决定，正式部署必须配置 PUBLIC_URL。
 */
export function requestOrigin(req: NextRequest): string {
  const configured = process.env.PUBLIC_URL?.replace(/\/+$/, '');
  if (configured) return configured;
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? req.nextUrl.protocol.replace(':', '');
  return host ? `${proto}://${host}` : req.nextUrl.origin;
}

/**
 * 控制台没有登录，所以其他网站的页面可以向 localhost 发请求。
 * 这些接口现在能操作真实的沙箱账户，要拒绝跨站来的请求。
 */
export function isCrossSite(req: NextRequest): boolean {
  if (req.headers.get('sec-fetch-site') === 'cross-site') return true;
  const origin = req.headers.get('origin');
  if (!origin) return false;
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}
