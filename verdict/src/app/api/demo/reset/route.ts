import { NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { resetDemo } from '@/demo/seed';

export const dynamic = 'force-dynamic';

export async function POST() {
  await ready();
  await resetDemo();
  return NextResponse.json({ ok: true });
}
