'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function PayPalSyncButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function sync() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/paypal/sync', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setResult(body.error ?? 'Sync failed');
      else {
        const skipped = body.skipped?.length ? `, ${body.skipped.length} skipped` : '';
        setResult(`${body.created} new, ${body.updated} updated${skipped}`);
      }
      router.refresh();
    } catch {
      setResult('Request failed to send. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {result && <span className="muted small">{result}</span>}
      <button className="btn" disabled={busy} onClick={sync}>
        {busy ? 'Syncing…' : 'Sync PayPal sandbox'}
      </button>
    </>
  );
}
