import { NextRequest, NextResponse } from 'next/server';
import type { ClaimType } from '@/core/types';
import { ready } from '@/server/bootstrap';
import { db } from '@/server/db';
import { startAnalysis } from '@/server/pipeline';
import { requireToken } from '@/server/portal';
import { limitPortal } from '@/server/rate-limit';
import { addTimeline, getClaim } from '@/server/repo';
import { consumePortalToken } from '@/server/tokens';

export const dynamic = 'force-dynamic';

const TYPES: ClaimType[] = ['not_received', 'damaged', 'not_as_described', 'missing_items'];

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  await ready();
  const { token } = await params;
  const limited = limitPortal(req, token, 'submit');
  if (limited) return limited;
  const check = requireToken(token);
  if (check instanceof NextResponse) return check;
  const claim = getClaim(check.payload.claimId);
  if (!claim) return NextResponse.json({ error: '索赔不存在' }, { status: 404 });
  if (claim.status === 'closed') return NextResponse.json({ error: '这笔索赔已结案' }, { status: 409 });

  const body = await req.json().catch(() => ({}));
  const narrative = String(body.narrative ?? '').slice(0, 5000);
  const type = TYPES.includes(body.claimType) ? (body.claimType as ClaimType) : claim.claim_type;

  // PayPal 争议的类型来自 PayPal，补证时不让买家修改。
  db()
    .prepare('UPDATE claims SET claim_type = ?, narrative = ?, status = ? WHERE id = ?')
    .run(claim.origin === 'portal' ? type : claim.claim_type, narrative || claim.narrative, 'analyzing', claim.id);
  consumePortalToken(check.payload.jti);
  addTimeline(claim.id, 'claim', '买家提交索赔', narrative ? narrative.slice(0, 80) : undefined);
  startAnalysis(claim.id);
  return NextResponse.json({ ok: true });
}
