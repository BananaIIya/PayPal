import { NextRequest, NextResponse } from 'next/server';
import type { ClaimType } from '@/core/types';
import { ready } from '@/server/bootstrap';
import { authorize } from '@/server/guard';
import { createClaim } from '@/server/ingest';
import { startAnalysis } from '@/server/pipeline';
import { addEvidence, addTimeline, defaultMerchantId, getOrder, listClaims } from '@/server/repo';
import { maskClaimList } from '@/server/shadow';
import { MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES, requestTooLarge, sniffImageType, sniffVideoType, type VideoMime } from '@/server/storage';
import { addVideoEvidence } from '@/server/video';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  await ready();
  const auth = authorize(req);
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json(maskClaimList(defaultMerchantId(), listClaims()));
}

const TYPES: ClaimType[] = ['not_received', 'damaged', 'not_as_described', 'missing_items'];

/** 商家手动导入买家私下发来的照片和截图。 */
export async function POST(req: NextRequest) {
  await ready();
  const auth = authorize(req, { write: true });
  if (auth instanceof NextResponse) return auth;
  if (requestTooLarge(req)) return NextResponse.json({ error: 'Files in one upload exceed 48MB in total. Upload them in smaller batches.' }, { status: 413 });
  const form = await req.formData();
  const orderId = String(form.get('orderId') ?? '');
  const type = String(form.get('claimType') ?? '') as ClaimType;
  const narrative = String(form.get('narrative') ?? '').slice(0, 5000);
  const order = getOrder(orderId);
  if (!order) return NextResponse.json({ error: 'Select an order' }, { status: 400 });
  if (!TYPES.includes(type)) return NextResponse.json({ error: 'Invalid issue type' }, { status: 400 });

  const photos = form.getAll('photos').filter((f): f is File => f instanceof File && f.size > 0);
  const screenshots = form.getAll('screenshots').filter((f): f is File => f instanceof File && f.size > 0);
  const files: { file: File; shot: string | null }[] = [
    ...photos.map((file) => ({ file, shot: null })),
    ...screenshots.map((file) => ({ file, shot: 'chat_screenshot' })),
  ];

  const parsed: { buf: Buffer; mime: string; video: VideoMime | null; shot: string | null }[] = [];
  for (const { file, shot } of files) {
    if (file.size > MAX_VIDEO_BYTES) return NextResponse.json({ error: `${file.name} is larger than 40MB` }, { status: 413 });
    const buf = Buffer.from(await file.arrayBuffer());
    // 截图只能是图片；买家私下发来的视频按照片一样导入。
    const video = shot ? null : sniffVideoType(buf);
    const mime = video ?? sniffImageType(buf);
    if (!mime) return NextResponse.json({ error: `${file.name} is not a JPEG, PNG or WebP image or an MP4, WebM or MOV video` }, { status: 415 });
    if (!video && buf.length > MAX_UPLOAD_BYTES) return NextResponse.json({ error: `${file.name} is larger than 15MB` }, { status: 413 });
    parsed.push({ buf, mime, video, shot });
  }

  const claimId = createClaim({
    merchantId: order.merchant_id,
    orderId,
    origin: 'manual_import',
    type,
    narrative,
    status: 'analyzing',
  });
  addTimeline(claimId, 'claim', 'Manual import', `${parsed.length} files`);
  for (const p of parsed) {
    if (p.video) await addVideoEvidence({ claimId, orderId, source: 'manual_import', file: p.buf, mime: p.video, shot: null });
    else await addEvidence({ claimId, orderId, source: 'manual_import', file: p.buf, mime: p.mime, shot: p.shot });
    addTimeline(claimId, 'evidence', 'Evidence uploaded', p.shot ?? (p.video ? 'Video imported by merchant' : 'Photo imported by merchant'));
  }
  startAnalysis(claimId);
  return NextResponse.json({ claimId });
}
