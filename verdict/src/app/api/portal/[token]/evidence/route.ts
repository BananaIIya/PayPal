import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { db, nowIso } from '@/server/db';
import { requireToken } from '@/server/portal';
import { clientIp, limitPortal } from '@/server/rate-limit';
import { addEvidence, addTimeline, getClaim } from '@/server/repo';
import { MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES, requestTooLarge, sniffImageType, sniffVideoType } from '@/server/storage';
import { addVideoEvidence } from '@/server/video';

export const dynamic = 'force-dynamic';

const CHALLENGE_TTL_MS = 15 * 60 * 1000;

/** 登记证据（照片或短视频）。带有效挑战的先记为待核验（C 层），画面里的码核对通过后才提升。否则算相册上传。 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  await ready();
  const { token } = await params;
  const limited = limitPortal(req, token, 'upload');
  if (limited) return limited;
  const check = requireToken(token);
  if (check instanceof NextResponse) return check;
  const claim = getClaim(check.payload.claimId);
  if (!claim) return NextResponse.json({ error: '索赔不存在' }, { status: 404 });
  if (claim.status === 'closed') return NextResponse.json({ error: '这笔索赔已结案' }, { status: 409 });

  if (requestTooLarge(req)) return NextResponse.json({ error: '一次上传的文件合计超过 48MB，请分几次上传' }, { status: 413 });
  const form = await req.formData();
  const file = form.get('file');
  const shot = String(form.get('shot') ?? '').slice(0, 40) || null;
  const challengeId = form.get('challengeId') ? String(form.get('challengeId')) : null;
  const durationMs = Number(form.get('durationMs') ?? 0) || null;

  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: '没有收到文件' }, { status: 400 });
  if (file.size > MAX_VIDEO_BYTES) return NextResponse.json({ error: '文件超过 40MB' }, { status: 413 });
  const buf = Buffer.from(await file.arrayBuffer());
  const video = sniffVideoType(buf);
  const mime = video ? null : sniffImageType(buf);
  if (!video && !mime) return NextResponse.json({ error: '只接受 JPEG、PNG、WebP 图片或 MP4、WebM、MOV 视频' }, { status: 415 });
  if (!video && buf.length > MAX_UPLOAD_BYTES) return NextResponse.json({ error: '图片超过 15MB' }, { status: 413 });

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

  const base = {
    claimId: claim.id,
    orderId: claim.order_id,
    source: challengeId ? ('challenge_pending' as const) : ('uploaded' as const),
    file: buf,
    shot,
    challengeId,
    captureMeta: {
      serverTime: nowIso(),
      durationMs,
      userAgent: req.headers.get('user-agent'),
      ip: clientIp(req),
    },
  };
  const ev = video ? await addVideoEvidence({ ...base, mime: video }) : await addEvidence({ ...base, mime: mime! });
  const what = video ? '视频' : '证据';
  addTimeline(claim.id, 'evidence', challengeId ? `挑战拍摄，待核验` : `相册${what}上传`, shot ?? undefined);
  return NextResponse.json({ evidenceId: ev.id, sha256: ev.sha256, layer: ev.layer, ...(video ? { kind: 'video' } : {}) });
}
