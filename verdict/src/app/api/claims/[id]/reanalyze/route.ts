import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { authorize } from '@/server/guard';
import { hasPurgedEvidence, startAnalysis } from '@/server/pipeline';
import { addTimeline, getClaim } from '@/server/repo';
import { actorLabel } from '@/server/auth';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ready();
  const auth = authorize(req, { write: true });
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  if (!getClaim(id)) return NextResponse.json({ error: '索赔不存在' }, { status: 404 });
  if (hasPurgedEvidence(id)) return NextResponse.json({ error: '证据原件已按保留期删除，不能重新分析，原来的信号和判定保留' }, { status: 409 });
  addTimeline(id, 'analysis', '商家请求重新分析', `操作人：${actorLabel(auth.id)}`);
  startAnalysis(id);
  return NextResponse.json({ started: true });
}
