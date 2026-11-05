import { NextRequest, NextResponse } from 'next/server';
import type { ClaimType } from '@/core/types';
import { ready } from '@/server/bootstrap';
import { createClaim } from '@/server/ingest';
import { startAnalysis } from '@/server/pipeline';
import { addEvidence, addTimeline, getOrder, listClaims } from '@/server/repo';
import { MAX_UPLOAD_BYTES, sniffImageType } from '@/server/storage';

export const dynamic = 'force-dynamic';

export async function GET() {
  await ready();
  return NextResponse.json({ claims: listClaims() });
}

const TYPES: ClaimType[] = ['not_received', 'damaged', 'not_as_described', 'missing_items'];

/** 商家手动导入买家私下发来的照片和截图。 */
export async function POST(req: NextRequest) {
  await ready();
  const form = await req.formData();
  const orderId = String(form.get('orderId') ?? '');
  const type = String(form.get('claimType') ?? '') as ClaimType;
  const narrative = String(form.get('narrative') ?? '').slice(0, 5000);
  const order = getOrder(orderId);
  if (!order) return NextResponse.json({ error: '请选择订单' }, { status: 400 });
  if (!TYPES.includes(type)) return NextResponse.json({ error: '问题类型无效' }, { status: 400 });

  const photos = form.getAll('photos').filter((f): f is File => f instanceof File && f.size > 0);
  const screenshots = form.getAll('screenshots').filter((f): f is File => f instanceof File && f.size > 0);
  const files: { file: File; shot: string | null }[] = [
    ...photos.map((file) => ({ file, shot: null })),
    ...screenshots.map((file) => ({ file, shot: 'chat_screenshot' })),
  ];

  const parsed: { buf: Buffer; mime: string; shot: string | null }[] = [];
  for (const { file, shot } of files) {
    if (file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: `${file.name} 超过 15MB` }, { status: 413 });
    const buf = Buffer.from(await file.arrayBuffer());
    const mime = sniffImageType(buf);
    if (!mime) return NextResponse.json({ error: `${file.name} 不是 JPEG、PNG 或 WebP 图片` }, { status: 415 });
    parsed.push({ buf, mime, shot });
  }

  const claimId = createClaim({
    merchantId: order.merchant_id,
    orderId,
    origin: 'manual_import',
    type,
    narrative,
    status: 'analyzing',
  });
  addTimeline(claimId, 'claim', '商家手动导入', `${parsed.length} 份文件`);
  for (const p of parsed) {
    await addEvidence({ claimId, orderId, source: 'manual_import', file: p.buf, mime: p.mime, shot: p.shot });
    addTimeline(claimId, 'evidence', '证据上传', p.shot ?? '商家导入的照片');
  }
  startAnalysis(claimId);
  return NextResponse.json({ claimId });
}
