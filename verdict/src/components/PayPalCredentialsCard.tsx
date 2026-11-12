'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { PayPalCredentialView } from '@/server/paypal-credentials';
import { fmtDateTime } from './format';

const SOURCE_TEXT: Record<PayPalCredentialView['source'], string> = {
  database: 'In use: credentials saved in Settings (encrypted)',
  env: 'In use: credentials from environment variables',
  none: 'Not configured. PayPal uses the simulator.',
};

/** 店主保存 PayPal 沙箱凭证。Secret 只进不出：保存后页面上只显示 Client ID 尾号。 */
export function PayPalCredentialsCard({ initial }: { initial: PayPalCredentialView }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [webhookId, setWebhookId] = useState(initial.stored?.webhookId ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const canSave = view.encryption.configured;

  async function send(method: 'PUT' | 'DELETE', body?: unknown) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/settings/paypal', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ ok: false, text: data.error ?? 'Save failed' });
        return;
      }
      setView(data as PayPalCredentialView);
      setClientId('');
      setSecret('');
      setMessage({ ok: true, text: method === 'PUT' ? 'PayPal accepted these credentials. Saved encrypted.' : 'Deleted the credentials saved in Settings.' });
      router.refresh();
    } catch {
      setMessage({ ok: false, text: 'Request failed to send. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card card-pad">
      <h2>PayPal credentials</h2>
      <p className="small" style={{ marginBottom: 6 }}>
        {SOURCE_TEXT[view.source]}
      </p>
      {view.stored && (
        <p className="muted small" style={{ marginBottom: 6 }}>
          Saved: Client ID ending <span className="mono">{view.stored.clientIdTail}</span>
          {view.stored.webhookId ? ' · Webhook ID set' : ''} · Saved by {view.stored.updatedBy} on {fmtDateTime(view.stored.updatedAt)}
        </p>
      )}
      {view.error && <p className="notice notice-danger" style={{ marginBottom: 10 }}>{view.error}</p>}
      {!canSave ? (
        <p className="notice" style={{ marginBottom: 10 }}>
          {view.encryption.error ?? 'APP_ENCRYPTION_KEY is not set on the server, so credentials cannot be saved here.'}{' '}
          Add APP_ENCRYPTION_KEY to .env.local (generate it with openssl rand -hex 32) and restart the server to save.
          {view.source === 'env' ? ' The credentials from environment variables in use now are not affected.' : ''}
        </p>
      ) : (
        <p className="muted small" style={{ marginBottom: 10 }}>
          Sandbox app credentials only. The secret is encrypted with AES-256-GCM using APP_ENCRYPTION_KEY before it is stored, and is never shown on any page after saving. Credentials are verified with PayPal before saving. Credentials saved in Settings take precedence over environment variables. After switching to another sandbox account, earlier sandbox orders and disputes can no longer be acted on.
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send('PUT', { clientId, clientSecret: secret, webhookId });
        }}
      >
        <fieldset className="bare" disabled={!canSave || busy}>
          <label className="field">
            Client ID
            <input type="text" autoComplete="off" spellCheck={false} required value={clientId} onChange={(e) => setClientId(e.target.value)} />
          </label>
          <label className="field">
            Secret
            <input type="password" autoComplete="new-password" required value={secret} onChange={(e) => setSecret(e.target.value)} />
          </label>
          <label className="field">
            Webhook ID (optional)
            <input type="text" autoComplete="off" spellCheck={false} value={webhookId} onChange={(e) => setWebhookId(e.target.value)} />
          </label>
          <button className="btn btn-primary">{busy ? 'Verifying…' : 'Verify and save'}</button>
        </fieldset>
      </form>
      {/* 放在表单外：密钥丢失、凭证解密不了的时候也要能删掉。 */}
      {view.stored && (
        <button
          type="button"
          className="btn"
          style={{ marginTop: 8 }}
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Delete the credentials saved in Settings? ${view.envConfigured ? 'The credentials from environment variables will be used instead.' : 'PayPal will go back to the simulator.'}`)) void send('DELETE');
          }}
        >
          Delete saved credentials
        </button>
      )}
      {message && (
        <p className={`notice ${message.ok ? 'notice-info' : 'notice-danger'}`} role="status" style={{ marginTop: 10 }}>
          {message.text}
        </p>
      )}
    </section>
  );
}
