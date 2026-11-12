import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { authorize } from '@/server/guard';
import { addEvidence, getOrder } from '@/server/repo';
import { MAX_UPLOAD_BYTES, sniffImageType } from '@/server/storage';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ready();
  const auth = authorize(req, { write: true });
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  if (!getOrder(id)) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  const form = await req.formData();
  const file = form.get('file');
  const shot = String(form.get('shot') ?? 'overall');
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: 'Select a file' }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: 'File is larger than 15MB' }, { status: 413 });
  const buf = Buffer.from(await file.arrayBuffer());
  const mime = sniffImageType(buf);
  if (!mime) return NextResponse.json({ error: 'Only JPEG, PNG or WebP images are accepted' }, { status: 415 });
  const ev = await addEvidence({ claimId: null, orderId: id, source: 'reference', file: buf, mime, shot });
  return NextResponse.json({ evidenceId: ev.id });
}
