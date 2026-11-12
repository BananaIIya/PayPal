'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** 开发文档“数据最小化”：按索赔删除全部数据。放在折叠区里，避免误点。 */
export function DeleteClaim({ claimId, blocked }: { claimId: string; blocked: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (!window.confirm('Delete all data for this claim? Original evidence, the verdict and action records will be deleted. This cannot be undone.')) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/claims/${claimId}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? 'Delete failed');
        return;
      }
      router.push('/claims');
      router.refresh();
    } catch {
      setError('The request did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card card-pad no-print">
      <details>
        <summary>Delete this claim's data</summary>
        <p className="muted small" style={{ margin: '8px 0' }}>
          Deletes the buyer statement, original evidence, challenge codes, claim page link, analysis signals, verdict, action records and timeline. This cannot be undone. The order and messages between both parties belong to the order and are kept. The PayPal dispute and funds are not affected. Verdict keeps only a deletion record (ID and time).
        </p>
        {blocked ? (
          <p className="notice">{blocked}</p>
        ) : (
          <button className="btn btn-danger" disabled={busy} onClick={remove}>
            {busy ? 'Deleting…' : 'Delete all data'}
          </button>
        )}
        {error && (
          <p className="notice notice-danger" role="alert" style={{ marginTop: 8 }}>
            {error}
          </p>
        )}
      </details>
    </section>
  );
}
