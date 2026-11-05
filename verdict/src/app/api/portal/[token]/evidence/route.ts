import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { db, nowIso } from '@/server/db';
import { requireToken } from '@/server/portal';
import { addEvidence, addTimeline, getClaim } from '@/server/repo';
import { MAX_UPLOAD_BYTES, sniffImageType } from '@/server/storage';

export const dynamic = 'force-dynamic';

const CHALLENGE_TTL_MS = 15 * 60 * 1000;

/** 登记证据。带有效挑战的算现场拍摄（B 层），否则算相册上传（C 层）。 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  await ready();
  const { token } = await params;
  const check = requireToken(token);
  if (check instanceof NextResponse) return check;
  const claim = getClaim(check.payload.claimId);
  if (!claim) return NextResponse.json({ error: '索赔不存在' }, { status: 404 });
  if (claim.status === 'closed') return NextResponse.json({ error: '这笔索赔已结案' }, { status: 409 });

  const form = await req.formData();
  const file = form.get('file');
  const shot = String(form.get('shot') ?? '').slice(0, 40) || null;
  const challengeId = form.get('challengeId') ? String(form.get('challengeId')) : null;
  const durationMs = Number(form.get('durationMs') ?? 0) || null;

  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: '没有收到文件' }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: '文件超过 15MB' }, { status: 413 });
  const buf = Buffer.from(await file.arrayBuffer());
  const mime = sniffImageType(buf);
  if (!mime) return NextResponse.json({ error: '只接受 JPEG、PNG 或 WebP 图片' }, { status: 415 });

  if (challengeId) {
    const row = db().prepare('SELECT claim_id, issued_at, consumed_at FROM challenges WHERE id = ?').get(challengeId) as
      | { claim_id: string; issued_at: string; consumed_at: string | null }
      | undefined;
    if (!row || row.claim_id !== claim.id) return NextResponse.json({ error: '挑战码无效' }, { status: 400 });
    if (row.consumed_at) return NextResponse.json({ error: '挑战码已使用，请重新开始这个镜头' }, { status: 409 });
    if (Date.now() - new Date(row.issued_at).getTime() > CHALLENGE_TTL_MS) {
      return NextResponse.json({ error: '挑战码已过期，请重新开始这个镜头' }, { status: 410 });
    }
    db().prepare('UPDATE challenges SET consumed_at = ? WHERE id = ?').run(nowIso(), challengeId);
  }

  const ev = await addEvidence({
    claimId: claim.id,
    orderId: claim.order_id,
    source: challengeId ? 'live_capture' : 'uploaded',
    file: buf,
    mime,
    shot,
    challengeId,
    captureMeta: {
      serverTime: nowIso(),
      durationMs,
      userAgent: req.headers.get('user-agent'),
      ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    },
  });
  addTimeline(claim.id, 'evidence', challengeId ? '现场拍摄证据上传' : '相册证据上传', shot ?? undefined);
  return NextResponse.json({ evidenceId: ev.id, sha256: ev.sha256, layer: ev.layer });
}
