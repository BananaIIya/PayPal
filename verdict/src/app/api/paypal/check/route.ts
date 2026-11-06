import { NextRequest, NextResponse } from 'next/server';
import { publicPayPalStatus } from '@/paypal/config';
import { getSandboxClient } from '@/paypal/sandbox';
import { ready } from '@/server/bootstrap';
import { authorize } from '@/server/guard';

export const dynamic = 'force-dynamic';

/** 只读检查，不创建任何东西。输出不含 secret。 */
export async function POST(req: NextRequest) {
  await ready();
  const auth = authorize(req, { write: true });
  if (auth instanceof NextResponse) return auth;
  const status = publicPayPalStatus();
  const client = getSandboxClient();
  if (!client) return NextResponse.json({ ok: false, status, checks: [{ name: '配置', ok: false, detail: status.error ?? '还没有配置 PayPal 沙箱' }] });
  try {
    const checks = await client.checkConnection();
    return NextResponse.json({ ok: checks.every((c) => c.ok), status, checks });
  } catch (e) {
    return NextResponse.json({ ok: false, status, checks: [{ name: '凭据', ok: false, detail: e instanceof Error ? e.message : String(e) }] });
  }
}
