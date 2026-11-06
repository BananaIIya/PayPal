import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { authorize } from '@/server/guard';
import { defaultMerchantId } from '@/server/repo';
import { settingsView, updateSettings } from '@/server/settings';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  await ready();
  const auth = authorize(req);
  if (auth instanceof NextResponse) return auth;
  const merchantId = defaultMerchantId();
  if (!merchantId) return NextResponse.json({ error: '没有商家数据' }, { status: 404 });
  return NextResponse.json(settingsView(merchantId));
}

/** 权重会改变判定结果，只有店主能改。客服可以查看。 */
export async function PUT(req: NextRequest) {
  await ready();
  const auth = authorize(req, { write: true, owner: true, ownerReason: '只有店主可以修改判定设置' });
  if (auth instanceof NextResponse) return auth;
  const merchantId = defaultMerchantId();
  if (!merchantId) return NextResponse.json({ error: '没有商家数据' }, { status: 404 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: '请求体无效' }, { status: 400 });
  const result = updateSettings(merchantId, body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result);
}
