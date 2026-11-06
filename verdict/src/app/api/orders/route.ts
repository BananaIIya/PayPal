import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { checkApiKey, pushOrder } from '@/server/order-push';

export const dynamic = 'force-dynamic';

/**
 * 商家系统推送订单与发货信息（开发文档 POST /api/orders）。用 Bearer 密钥鉴权，浏览器不会自动带上，
 * 所以不需要再做跨站检查。按 orderNo 幂等：重复推送同一订单只会更新物流信息。
 */
export async function POST(req: NextRequest) {
  const auth = checkApiKey(req.headers.get('authorization'));
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  await ready();
  const body = await req.json().catch(() => undefined);
  if (body === undefined) return NextResponse.json({ error: '请求体要是 JSON' }, { status: 400 });
  const result = pushOrder(body);
  return NextResponse.json(result.body, { status: result.status });
}
