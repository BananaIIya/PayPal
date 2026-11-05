import { NextRequest } from 'next/server';
import { ready } from '@/server/bootstrap';
import { claimRuns, getClaim, latestVerdict } from '@/server/repo';

export const dynamic = 'force-dynamic';

/** SSE：分析进度与判定变化时推送。服务端轮询数据库，不依赖进程内共享状态。 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await params;
  const encoder = new TextEncoder();
  let timer: NodeJS.Timeout;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      let last = '';
      let quiet = 0;
      const tick = () => {
        if (closed) return;
        const claim = getClaim(id);
        const payload = JSON.stringify({ runs: claimRuns(id), verdictId: latestVerdict(id)?.id ?? null, status: claim?.status ?? null });
        if (payload !== last) {
          last = payload;
          quiet = 0;
          controller.enqueue(encoder.encode(`event: update\ndata: ${payload}\n\n`));
        } else if (++quiet > 25) {
          quiet = 0;
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
        }
      };
      tick();
      timer = setInterval(tick, 600);
      req.signal.addEventListener('abort', () => {
        closed = true;
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* 已关闭 */
        }
      });
    },
    cancel() {
      closed = true;
      clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' },
  });
}
