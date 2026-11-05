import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { claimView } from '@/server/views';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await params;
  const view = await claimView(id);
  if (!view) return NextResponse.json({ error: '索赔不存在' }, { status: 404 });
  return NextResponse.json(view);
}
