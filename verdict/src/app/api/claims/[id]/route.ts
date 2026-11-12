import { NextRequest, NextResponse } from 'next/server';
import { ready } from '@/server/bootstrap';
import { deleteClaimData } from '@/server/data-retention';
import { authorize } from '@/server/guard';
import { claimView } from '@/server/views';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ready();
  const auth = authorize(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const view = await claimView(id);
  if (!view) return NextResponse.json({ error: 'Claim not found' }, { status: 404 });
  return NextResponse.json(view);
}

/** 开发文档“数据最小化”：按索赔删除全部数据。不可恢复，只有店主可以操作。 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await ready();
  const auth = authorize(req, { write: true, owner: true, ownerReason: 'Only the owner can delete claim data' });
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const result = deleteClaimData(id, auth.id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ deleted: true, evidence: result.record.evidence, files: result.files });
}
