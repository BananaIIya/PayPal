'use client';

import { useState } from 'react';

const TOOLS = [
  { tool: 'require_evidence', value: 'SELLER_EVIDENCE', label: 'Require seller evidence', link: 'requireEvidence' },
  { tool: 'require_evidence', value: 'BUYER_EVIDENCE', label: 'Require buyer evidence', link: 'requireEvidence' },
  { tool: 'adjudicate', value: 'SELLER_FAVOR', label: 'Decide for seller', link: 'adjudicate' },
  { tool: 'adjudicate', value: 'BUYER_FAVOR', label: 'Decide for buyer', link: 'adjudicate' },
] as const;

export function SandboxTools(p: {
  claimId: string;
  links: { requireEvidence: boolean; adjudicate: boolean };
  onDone: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = TOOLS.filter((t) => p.links[t.link]);

  async function run(t: (typeof TOOLS)[number]) {
    if (!window.confirm(`Run "${t.label}" in the PayPal sandbox? This changes the dispute's status and cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/paypal/sandbox-tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimId: p.claimId, tool: t.tool, value: t.value, confirm: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setError(body.error ?? 'Action failed');
      await p.onDone();
    } catch {
      setError('Request failed to send. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card card-pad no-print">
      <h2>Sandbox test tools</h2>
      <p className="muted small" style={{ marginBottom: 10 }}>
        PayPal offers these endpoints only in the sandbox, to move a dispute to the state you want to test.
      </p>
      {available.length === 0 ? (
        <p className="muted small">PayPal offers no test endpoints for this dispute right now, so it cannot be moved forward manually.</p>
      ) : (
        <div className="row">
          {available.map((t) => (
            <button key={t.value} className="btn" disabled={busy} onClick={() => run(t)}>
              {t.label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="notice notice-danger small" style={{ marginTop: 10 }}>
          {error}
        </p>
      )}
    </section>
  );
}
