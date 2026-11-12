'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { FileInput } from './FileInput';

export function OrderTools({
  orderId,
  initialWeight,
  paypalEnv,
  captureId,
}: {
  orderId: string;
  initialWeight: number | null;
  paypalEnv: 'simulator' | 'sandbox';
  captureId: string | null;
}) {
  const router = useRouter();
  const [link, setLink] = useState<{ url: string; claimId: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [weight, setWeight] = useState(initialWeight ? String(initialWeight) : '');

  async function post(name: string, url: string, init: RequestInit) {
    setBusy(name);
    setError(null);
    const res = await fetch(url, init);
    const body = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setError(body.error ?? 'Action failed');
      return null;
    }
    return body;
  }

  async function createLink() {
    const body = await post('link', `/api/orders/${orderId}/portal-link`, { method: 'POST' });
    if (body) setLink({ url: body.url, claimId: body.claimId });
  }

  async function simulate(reason: string, message: string) {
    const body = await post('dispute', '/api/demo/simulate-dispute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, reason, message }),
    });
    if (body?.claimId) router.push(`/claims/${body.claimId}`);
  }

  async function uploadReference(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const body = await post('ref', `/api/orders/${orderId}/references`, { method: 'POST', body: new FormData(form) });
    if (body) {
      form.reset();
      router.refresh();
    }
  }

  async function saveWeight() {
    const body = await post('weight', `/api/orders/${orderId}/weight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weightG: Number(weight) }),
    });
    if (body) router.refresh();
  }

  return (
    <>
      <section className="card card-pad">
        <h2>Buyer claim link</h2>
        <p className="muted" style={{ marginBottom: 10 }}>
          Creates a claim waiting for the buyer and a one-time signed link.
        </p>
        {paypalEnv === 'sandbox' && !captureId ? (
          <p className="muted small">This test order has not been paid yet.</p>
        ) : (
          <button className="btn btn-primary" disabled={busy === 'link'} onClick={createLink}>
            Create claim link
          </button>
        )}
        {link && (
          <div style={{ marginTop: 12 }}>
            <input type="text" readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} aria-label="Claim link" />
            <div className="row" style={{ marginTop: 8 }}>
              <a className="btn" href={link.url} target="_blank" rel="noreferrer">
                Open buyer page
              </a>
              <button
                className="btn"
                onClick={async () => {
                  await navigator.clipboard.writeText(link.url);
                  setCopied(true);
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
              <a className="btn" href={`/claims/${link.claimId}`}>
                View claim
              </a>
            </div>
          </div>
        )}
      </section>

      {paypalEnv === 'sandbox' ? (
        <section className="card card-pad">
          <h2>Open a sandbox dispute</h2>
          {captureId ? (
            <>
              <p className="muted" style={{ marginBottom: 8 }}>
                Sign in to the PayPal sandbox site with the personal sandbox account that paid, find this transaction and report a problem. Choose "Item not received" or "Not as described". Verdict does not handle other types yet. A dispute can be answered only after about 3 minutes, and syncing it may take about as long.
              </p>
              <p className="small">
                PayPal transaction ID: <span className="mono">{captureId}</span>
              </p>
              <p className="muted small" style={{ marginTop: 8 }}>
                A transaction can have only one dispute, and it cannot be reopened after it closes. Place a new order to test the next scenario.
              </p>
            </>
          ) : (
            <p className="muted">You can open a dispute after payment completes.</p>
          )}
        </section>
      ) : (
      <section className="card card-pad">
        <h2>Simulate a PayPal dispute</h2>
        <p className="muted" style={{ marginBottom: 10 }}>
          Has the simulator open a dispute and runs the full webhook flow: signature check, deduplication, fetching details and creating the claim.
        </p>
        <div className="row">
          <button className="btn" disabled={busy === 'dispute'} onClick={() => simulate('MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'I never received this package.')}>
            Not received
          </button>
          <button className="btn" disabled={busy === 'dispute'} onClick={() => simulate('MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', 'The item I received is not as described.')}>
            Not as described
          </button>
        </div>
      </section>
      )}

      <section className="card card-pad">
        <h2>Shipment reference</h2>
        <form onSubmit={uploadReference}>
          <label className="field">
            Shot
            <select name="shot" defaultValue="overall">
              <option value="overall">Whole item</option>
              <option value="serial_closeup">Serial number close-up</option>
              <option value="package">Outer packaging</option>
              <option value="label">Shipping label close-up</option>
            </select>
          </label>
          <label className="field">
            Image
            <FileInput name="file" accept="image/jpeg,image/png,image/webp" required />
          </label>
          <button className="btn" disabled={busy === 'ref'}>
            Upload reference photo
          </button>
        </form>
        <label className="field" style={{ marginTop: 16 }}>
          Shipping weight (g)
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input type="number" min="1" value={weight} onChange={(e) => setWeight(e.target.value)} />
            <button type="button" className="btn" disabled={busy === 'weight'} onClick={saveWeight}>
              Save
            </button>
          </div>
        </label>
        {error && <p className="notice notice-danger">{error}</p>}
      </section>
    </>
  );
}
