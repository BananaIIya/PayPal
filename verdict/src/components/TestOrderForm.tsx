'use client';

import { useState } from 'react';

export function TestOrderForm({ products }: { products: { key: string; title: string; amount: number }[] }) {
  const [productKey, setProductKey] = useState(products[0]?.key ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/paypal/test-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productKey }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.approveUrl) {
        setError(body.error ?? 'Could not create order');
        setBusy(false);
        return;
      }
      window.location.href = body.approveUrl;
    } catch {
      setError('Request failed to send. Try again.');
      setBusy(false);
    }
  }

  return (
    <section className="card card-pad" style={{ marginBottom: 14 }}>
      <h2>Sandbox test order</h2>
      <p className="muted" style={{ marginBottom: 10 }}>
        Takes you to the PayPal sandbox to pay with your personal sandbox account. Only test funds are used. Choose Visa as the payment method: the default bank account uses eCheck, which stays pending, so partial refunds and most dispute options cannot be tested. After paying, open a dispute with the same account and Verdict syncs it automatically.
      </p>
      <form className="row" onSubmit={submit}>
        <select value={productKey} onChange={(e) => setProductKey(e.target.value)} aria-label="Test product" style={{ width: 'auto' }}>
          {products.map((p) => (
            <option key={p.key} value={p.key}>
              {p.title} · USD {p.amount.toFixed(2)}
            </option>
          ))}
        </select>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Redirecting…' : 'Pay in sandbox'}
        </button>
      </form>
      {error && (
        <p className="notice notice-danger" style={{ marginTop: 10 }}>
          {error}
        </p>
      )}
    </section>
  );
}
