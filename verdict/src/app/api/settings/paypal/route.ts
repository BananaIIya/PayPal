import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { authorize } from '@/server/guard';
import { deletePayPalCredentials, paypalCredentialView, savePayPalCredentials } from '@/server/paypal-credentials';

export const dynamic = 'force-dynamic';

const OWNER_ONLY = 'Only the owner can view and change PayPal credentials';

export async function GET(req: NextRequest) {
  await ready();
  const auth = authorize(req, { owner: true, ownerReason: OWNER_ONLY });
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json(paypalCredentialView(auth.merchantId));
}

/** 保存沙箱凭证：先向 PayPal 换一次令牌验证，通过后加密入库。响应里没有 secret。 */
export async function PUT(req: NextRequest) {
  await ready();
  const auth = authorize(req, { write: true, owner: true, ownerReason: OWNER_ONLY });
  if (auth instanceof NextResponse) return auth;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await savePayPalCredentials(auth, body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result.view);
}

export async function DELETE(req: NextRequest) {
  await ready();
  const auth = authorize(req, { write: true, owner: true, ownerReason: OWNER_ONLY });
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json(deletePayPalCredentials(auth.merchantId));
}
