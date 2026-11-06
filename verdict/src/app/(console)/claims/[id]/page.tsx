import { notFound } from 'next/navigation';
import { ClaimView } from '@/components/ClaimView';
import { ready } from '@/server/bootstrap';
import { pageUser, viewerOf } from '@/server/guard';
import { claimView } from '@/server/views';

export const dynamic = 'force-dynamic';

export default async function ClaimPage({ params }: { params: Promise<{ id: string }> }) {
  await ready();
  const viewer = await pageUser();
  const { id } = await params;
  const view = await claimView(id);
  if (!view) notFound();
  return <ClaimView initial={view} viewer={viewerOf(viewer)} />;
}
