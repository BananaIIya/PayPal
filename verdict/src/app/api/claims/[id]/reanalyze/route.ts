import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { startAnalysis } from '@/server/pipeline';
import { addTimeline, getClaim } from '@/server/repo';

export const dynamic = 'force-dynamic';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await params;
  if (!getClaim(id)) return NextResponse.json({ error: '索赔不存在' }, { status: 404 });
  addTimeline(id, 'analysis', '商家请求重新分析');
  startAnalysis(id);
  return NextResponse.json({ started: true });
}
