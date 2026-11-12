import type { Metadata } from 'next';
import { PortalClient } from '@/components/PortalClient';

export const metadata: Metadata = { title: 'Submit claim evidence', robots: { index: false, follow: false } };

export default async function PortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PortalClient token={token} />;
}
