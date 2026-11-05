import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { db } from '@/server/db';
import { readFile } from '@/server/storage';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await params;
  const row = db().prepare('SELECT sha256, mime_type FROM evidence WHERE id = ?').get(id) as { sha256: string; mime_type: string } | undefined;
  if (!row) return NextResponse.json({ error: '证据不存在' }, { status: 404 });
  return new NextResponse(new Uint8Array(readFile(row.sha256)), {
    headers: {
      'Content-Type': row.mime_type,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600, immutable',
    },
  });
}
