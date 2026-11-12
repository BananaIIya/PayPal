'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { fmtDateTime } from './format';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export function PayPalSandboxCard(p: {
  status: { state: 'off' | 'invalid' | 'ready'; clientIdTail: string | null; webhookConfigured: boolean; error: string | null };
  lastSync: { lastRunAt: string; ok: boolean; created: number; updated: number; skipped: { id: string; reason: string }[]; error: string | null } | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<'check' | 'sync' | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  async function check() {
    setBusy('check');
    try {
      const res = await fetch('/api/paypal/check', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      setChecks(body.checks ?? [{ name: 'Connection', ok: false, detail: body.error ?? 'Check failed' }]);
    } catch {
      setChecks([{ name: 'Connection', ok: false, detail: 'Request failed to send. Try again.' }]);
    } finally {
      setBusy(null);
    }
  }

  async function sync() {
    setBusy('sync');
    setSyncError(null);
    try {
      const res = await fetch('/api/paypal/sync', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setSyncError(body.error ?? 'Sync failed');
      }
      router.refresh();
    } catch {
      setSyncError('Request failed to send. Try again.');
    } finally {
      setBusy(null);
    }
  }

  const { status, lastSync } = p;
  return (
    <section className="card card-pad">
      <h2>PayPal sandbox</h2>
      {status.state === 'off' && (
        <p className="muted">Not configured. The owner can enter the sandbox app's Client ID and Secret under "PayPal credentials" in Settings, or add them to .env.local (see the README). Without them, everything uses the simulator.</p>
      )}
      {status.state === 'invalid' && <p className="notice notice-danger">{status.error}</p>}
      {status.state === 'ready' && (
        <>
          <dl className="kv">
            <dt>Environment</dt>
            <dd>Sandbox (hard-coded, never connects to live)</dd>
            <dt>Client ID</dt>
            <dd className="mono">…{status.clientIdTail}</dd>
            <dt>Webhook</dt>
            <dd>{status.webhookConfigured ? 'PAYPAL_WEBHOOK_ID configured' : 'Not configured. Relies on the scheduled sync every minute.'}</dd>
            <dt>Last sync</dt>
            <dd suppressHydrationWarning>
              {lastSync ? `${fmtDateTime(lastSync.lastRunAt)}, ${lastSync.created} new, ${lastSync.updated} updated, ${lastSync.skipped.length} skipped` : 'Never synced'}
            </dd>
          </dl>
          {lastSync?.error && (
            <p className="notice notice-danger small" style={{ marginTop: 10 }}>
              {lastSync.error}
            </p>
          )}
          {lastSync && lastSync.skipped.length > 0 && (
            <ul className="small muted" style={{ marginTop: 10 }}>
              {lastSync.skipped.slice(0, 5).map((s) => (
                <li key={s.id}>
                  <span className="mono">{s.id}</span>: {s.reason}
                </li>
              ))}
            </ul>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" disabled={!!busy} onClick={check}>
              {busy === 'check' ? 'Checking…' : 'Check connection'}
            </button>
            <button className="btn" disabled={!!busy} onClick={sync}>
              {busy === 'sync' ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
          {syncError && (
            <p className="notice notice-danger small" style={{ marginTop: 10 }}>
              {syncError}
            </p>
          )}
          {checks && (
            <div style={{ marginTop: 12 }}>
              {checks.map((c) => (
                <div key={c.name} style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
                  <div className="between">
                    <strong>{c.name}</strong>
                    <span className={`badge ${c.ok ? 'level-low' : 'level-high'}`}>{c.ok ? 'Passed' : 'Failed'}</span>
                  </div>
                  <div className="muted small">{c.detail}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
