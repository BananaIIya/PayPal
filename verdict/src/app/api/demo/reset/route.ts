import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { authorize } from '@/server/guard';
import { resetDemo } from '@/demo/seed';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  await ready();
  const auth = authorize(req, { write: true, owner: true, ownerReason: '只有店主可以重置演示数据' });
  if (auth instanceof NextResponse) return auth;
  await resetDemo();
  return NextResponse.json({ ok: true });
}
