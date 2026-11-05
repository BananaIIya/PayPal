import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { handleWebhook } from '@/server/ingest';
import { handleSandboxWebhook } from '@/server/paypal-sync';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  await ready();
  const raw = await req.text();
  // 模拟器事件带自己的 HMAC 签名，只能操作模拟争议。其余一律按 PayPal 官方接口验签。
  const simSignature = req.headers.get('x-verdict-sim-signature');
  const out = simSignature ? await handleWebhook(raw, simSignature) : await handleSandboxWebhook(raw, req.headers);
  return NextResponse.json(out.body, { status: out.status });
}
