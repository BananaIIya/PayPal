'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FileInput } from './FileInput';

export function ImportForm({ orders }: { orders: { id: string; label: string }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/claims', { method: 'POST', body: new FormData(e.currentTarget) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? 'Import failed');
        setBusy(false);
        return;
      }
      router.push(`/claims/${body.claimId}`);
    } catch {
      setError('The request did not go through. Check your connection and try again.');
      setBusy(false);
    }
  }

  return (
    <form className="card card-pad" onSubmit={submit}>
      <label className="field">
        Order
        <select name="orderId" required>
          {orders.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Problem type
        <select name="claimType" defaultValue="damaged">
          <option value="damaged">Damaged</option>
          <option value="not_as_described">Not as described</option>
          <option value="missing_items">Missing items or empty box</option>
          <option value="not_received">Not received</option>
        </select>
      </label>
      <label className="field">
        Original conversation
        <textarea name="narrative" rows={5} placeholder="Paste the buyer's email or message" />
      </label>
      <label className="field">
        Photos or videos from the buyer
        <FileInput name="photos" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime" multiple />
        <span className="muted small">Videos are split into frames with ffmpeg for analysis. Max 40 MB each.</span>
      </label>
      <label className="field">
        Chat screenshots or receipts
        <FileInput name="screenshots" accept="image/jpeg,image/png,image/webp" multiple />
      </label>
      {error && (
        <p className="notice notice-danger" role="alert" style={{ marginBottom: 12 }}>
          {error}
        </p>
      )}
      <button className="btn btn-primary" disabled={busy}>
        {busy ? 'Importing…' : 'Import and analyze'}
      </button>
    </form>
  );
}
