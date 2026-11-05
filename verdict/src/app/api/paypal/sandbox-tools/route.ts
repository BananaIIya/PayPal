import { NextRequest, NextResponse } from 'next/server';
import { runSandboxTool } from '@/server/actions';
import { ready } from '@/server/bootstrap';
import { isCrossSite } from '@/server/origin';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (isCrossSite(req)) return NextResponse.json({ error: '拒绝跨站请求' }, { status: 403 });
  await ready();
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: '请求体无效' }, { status: 400 });
  const out = await runSandboxTool({ claimId: body.claimId, tool: body.tool, value: body.value, confirm: body.confirm });
  return NextResponse.json(out.body, { status: out.status });
}
