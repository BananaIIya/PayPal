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
  if (!getClaim(id)) return NextResponse.json({ error: 'Claim not found' }, { status: 404 });
  if (hasPurgedEvidence(id)) return NextResponse.json({ error: 'Evidence originals were deleted after the retention period, so the claim cannot be re-analyzed. The original signals and verdict are kept.' }, { status: 409 });
  addTimeline(id, 'analysis', 'Merchant requested re-analysis', `By: ${actorLabel(auth.id)}`);
  startAnalysis(id);
  return NextResponse.json({ started: true });
}
