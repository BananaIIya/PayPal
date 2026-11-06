import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { authorize } from '@/server/guard';
import { requestOrigin } from '@/server/origin';
import { getClaim } from '@/server/repo';
import { issuePortalToken } from '@/server/tokens';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ready();
  const auth = authorize(req, { write: true });
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const claim = getClaim(id);
  if (!claim) return NextResponse.json({ error: '索赔不存在' }, { status: 404 });
  const token = issuePortalToken({ merchantId: claim.merchant_id, orderId: claim.order_id, claimId: id });
  return NextResponse.json({ token, url: `${requestOrigin(req)}/c/${token}` });
}
