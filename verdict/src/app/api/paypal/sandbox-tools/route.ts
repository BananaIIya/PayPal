import { NextRequest, NextResponse } from 'next/server';
import { runSandboxTool } from '@/server/actions';
import { ready } from '@/server/bootstrap';
import { authorize } from '@/server/guard';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  await ready();
  const auth = authorize(req, { write: true, owner: true, ownerReason: 'Only the owner can advance or decide sandbox disputes' });
  if (auth instanceof NextResponse) return auth;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  const out = await runSandboxTool({ claimId: body.claimId, tool: body.tool, value: body.value, confirm: body.confirm });
  return NextResponse.json(out.body, { status: out.status });
}
