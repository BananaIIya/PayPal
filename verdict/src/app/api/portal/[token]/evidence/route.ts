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
  if (!claim) return NextResponse.json({ error: 'Claim not found' }, { status: 404 });
  if (claim.status === 'closed') return NextResponse.json({ error: 'This claim is closed' }, { status: 409 });

  if (requestTooLarge(req)) return NextResponse.json({ error: 'Files in one upload exceed 48MB in total. Upload them in smaller batches.' }, { status: 413 });
  const form = await req.formData();
  const file = form.get('file');
  const shot = String(form.get('shot') ?? '').slice(0, 40) || null;
  const challengeId = form.get('challengeId') ? String(form.get('challengeId')) : null;
  const durationMs = Number(form.get('durationMs') ?? 0) || null;

  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: 'No file received' }, { status: 400 });
  if (file.size > MAX_VIDEO_BYTES) return NextResponse.json({ error: 'File is larger than 40MB' }, { status: 413 });
  const buf = Buffer.from(await file.arrayBuffer());
  const video = sniffVideoType(buf);
  const mime = video ? null : sniffImageType(buf);
  if (!video && !mime) return NextResponse.json({ error: 'Only JPEG, PNG or WebP images or MP4, WebM or MOV videos are accepted' }, { status: 415 });
  if (!video && buf.length > MAX_UPLOAD_BYTES) return NextResponse.json({ error: 'Image is larger than 15MB' }, { status: 413 });

  if (challengeId) {
    const row = db().prepare('SELECT claim_id, issued_at, consumed_at FROM challenges WHERE id = ?').get(challengeId) as
      | { claim_id: string; issued_at: string; consumed_at: string | null }
      | undefined;
    if (!row || row.claim_id !== claim.id) return NextResponse.json({ error: 'Invalid challenge code' }, { status: 400 });
    if (row.consumed_at) return NextResponse.json({ error: 'Challenge code already used. Restart this shot.' }, { status: 409 });
    if (Date.now() - new Date(row.issued_at).getTime() > CHALLENGE_TTL_MS) {
      return NextResponse.json({ error: 'Challenge code expired. Restart this shot.' }, { status: 410 });
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
  const what = video ? 'video' : 'evidence';
  addTimeline(claim.id, 'evidence', challengeId ? `Challenge capture, pending verification` : `Gallery ${what} uploaded`, shot ?? undefined);
  return NextResponse.json({ evidenceId: ev.id, sha256: ev.sha256, layer: ev.layer, ...(video ? { kind: 'video' } : {}) });
}
