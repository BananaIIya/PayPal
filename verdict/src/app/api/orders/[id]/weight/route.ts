import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { authorize } from '@/server/guard';
import { db } from '@/server/db';
import { getOrder } from '@/server/repo';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ready();
  const auth = authorize(req, { write: true });
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  if (!getOrder(id)) return NextResponse.json({ error: '订单不存在' }, { status: 404 });
  const body = await req.json().catch(() => null);
  const weight = Number(body?.weightG);
  if (!Number.isFinite(weight) || weight <= 0 || weight > 1_000_000) {
    return NextResponse.json({ error: '重量无效' }, { status: 400 });
  }
  db().prepare('UPDATE orders SET shipped_weight_g = ? WHERE id = ?').run(Math.round(weight), id);
  return NextResponse.json({ ok: true });
}
