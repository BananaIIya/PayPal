import { NextRequest, NextResponse } from 'next/server';
import { createFirstOwner } from '@/server/auth';
import { ready } from '@/server/bootstrap';
import { setSessionCookie } from '@/server/guard';
import { isCrossSite } from '@/server/origin';
import { limitAuth } from '@/server/rate-limit';
import { defaultMerchantId } from '@/server/repo';

export const dynamic = 'force-dynamic';

/** 创建第一个店主账号。需要服务端终端里打印的一次性设置码。 */
export async function POST(req: NextRequest) {
  if (isCrossSite(req)) return NextResponse.json({ error: 'Cross-site request rejected' }, { status: 403 });
  const limited = limitAuth(req);
  if (limited) return limited;
  await ready();
  const merchantId = defaultMerchantId();
  if (!merchantId) return NextResponse.json({ error: 'Merchant data is not initialized yet. Refresh and try again.' }, { status: 503 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await createFirstOwner({ token: body.token, merchantId, name: body.name, email: body.email, password: body.password });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return setSessionCookie(NextResponse.json({ ok: true }), req, result.sessionToken);
}
