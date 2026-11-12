// 进程内限流（滑动窗口）。MVP 只有一个进程，够用；多实例部署要换成 Redis 之类的共享存储。
import crypto from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';

type Bucket = number[];
const g = globalThis as unknown as { __verdictRate?: { buckets: Map<string, Bucket>; sweptAt: number } };

function store() {
  g.__verdictRate ??= { buckets: new Map(), sweptAt: Date.now() };
  return g.__verdictRate;
}

const MAX_WINDOW_MS = 60 * 60 * 1000;

/** 记一次请求；超出时返回需要等待的秒数。 */
export function hit(key: string, limit: number, windowMs: number, now = Date.now()): { ok: true } | { ok: false; retryAfter: number } {
  const s = store();
  if (now - s.sweptAt > 60_000) {
    for (const [k, b] of s.buckets) if (!b.length || now - b[b.length - 1] > MAX_WINDOW_MS) s.buckets.delete(k);
    s.sweptAt = now;
  }
  const bucket = (s.buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (bucket.length >= limit) {
    s.buckets.set(key, bucket);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((bucket[0] + windowMs - now) / 1000)) };
  }
  bucket.push(now);
  s.buckets.set(key, bucket);
  return { ok: true };
}

export function resetRateLimits(): void {
  store().buckets.clear();
}

/**
 * 客户端 IP。Next 只在请求没带 X-Forwarded-For 时才填入连接地址，所以直连时这个头可以伪造，
 * 按 IP 限流只是辅助，按 token 限流才是主防线。
 * 部署在反向代理后面时，设 TRUST_PROXY_HOPS 为代理层数，取代理追加的那一段，客户端伪造的前缀会被忽略。
 */
export function clientIp(req: NextRequest): string {
  const parts = (req.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const hops = Math.max(1, Number(process.env.TRUST_PROXY_HOPS) || 1);
  return parts[parts.length - hops] ?? parts[0] ?? 'unknown';
}

export function tooMany(retryAfter: number): NextResponse {
  return NextResponse.json(
    { error: `Too many requests. Try again in ${retryAfter} s.` },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } },
  );
}

/** 限流键里不放原始 token，只放哈希前缀。 */
export function tokenKey(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 32);
}

type PortalKind = 'read' | 'challenge' | 'upload' | 'submit';
const MINUTE = 60_000;
// 正常拍一单最多十几个镜头，每个镜头一次挑战加一次上传，重拍几次也远到不了上限。
const PORTAL_LIMITS: Record<PortalKind, { perToken: number; perIp: number }> = {
  read: { perToken: 60, perIp: 120 },
  challenge: { perToken: 30, perIp: 60 },
  upload: { perToken: 20, perIp: 40 },
  submit: { perToken: 5, perIp: 10 },
};

/**
 * 索赔页限流：先按 IP（在校验 token 之前，挡住拿乱码 token 刷接口），再按 token。
 * 返回 null 表示放行。
 */
export function limitPortal(req: NextRequest, token: string, kind: PortalKind): NextResponse | null {
  const limits = PORTAL_LIMITS[kind];
  const byIp = hit(`portal:${kind}:ip:${clientIp(req)}`, limits.perIp, MINUTE);
  if (!byIp.ok) return tooMany(byIp.retryAfter);
  const byToken = hit(`portal:${kind}:token:${tokenKey(token)}`, limits.perToken, MINUTE);
  if (!byToken.ok) return tooMany(byToken.retryAfter);
  return null;
}

/** 登录、首次设置、设置密码：按 IP 每分钟 20 次。按账号的锁定在 auth.ts。 */
export function limitAuth(req: NextRequest): NextResponse | null {
  const r = hit(`auth:ip:${clientIp(req)}`, 20, MINUTE);
  return r.ok ? null : tooMany(r.retryAfter);
}
