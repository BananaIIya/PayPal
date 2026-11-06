import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { authorize } from '@/server/guard';
import { db } from '@/server/db';
import { readFile } from '@/server/storage';

export const dynamic = 'force-dynamic';

/** 原件已删除时返回一张占位图，页面上所有引用这份证据的位置都能看出原因，不会显示成裂图。 */
function placeholder(text: string): NextResponse {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480"><rect width="640" height="480" fill="#ece9e1"/><text x="320" y="230" font-size="28" text-anchor="middle" fill="#6b675d" font-family="sans-serif">${text}</text><text x="320" y="272" font-size="18" text-anchor="middle" fill="#8a867b" font-family="sans-serif">哈希与分析结果仍保留</text></svg>`;
  return new NextResponse(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Cache-Control': 'no-store',
      'X-Verdict-Evidence': 'purged',
    },
  });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ready();
  const auth = authorize(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const row = db().prepare('SELECT sha256, mime_type, purged_at FROM evidence WHERE id = ?').get(id) as
    | { sha256: string; mime_type: string; purged_at: string | null }
    | undefined;
  if (!row) return NextResponse.json({ error: '证据不存在' }, { status: 404 });
  if (row.purged_at) return placeholder('原件已按保留期删除');
  let data: Buffer;
  try {
    data = readFile(row.sha256);
  } catch {
    return placeholder('原件文件不存在');
  }
  const headers: Record<string, string> = {
    'Content-Type': row.mime_type,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=3600, immutable',
  };
  if (!row.mime_type.startsWith('video/')) return new NextResponse(new Uint8Array(data), { headers });

  // Safari 播放视频必须支持分段请求。只处理单个区间，其他情况返回整个文件。
  headers['Accept-Ranges'] = 'bytes';
  const range = req.headers.get('range')?.match(/^bytes=(\d*)-(\d*)$/);
  if (!range || (range[1] === '' && range[2] === '')) return new NextResponse(new Uint8Array(data), { headers });
  const size = data.length;
  let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
  let end = range[1] === '' || range[2] === '' ? size - 1 : Number(range[2]);
  start = Math.max(0, start);
  end = Math.min(size - 1, end);
  if (start > end || start >= size) {
    return new NextResponse(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
  }
  return new NextResponse(new Uint8Array(data.subarray(start, end + 1)), {
    status: 206,
    headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
  });
}
