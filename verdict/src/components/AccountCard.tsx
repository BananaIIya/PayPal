'use client';

import { useState } from 'react';
import { ROLE_LABEL, type Role } from '@/core/types';

/** 当前账号：修改密码。改完后其他设备上的登录失效，这台保留。 */
export function AccountCard({ name, email, role }: { name: string; email: string; role: Role }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) return setMessage({ ok: false, text: 'New passwords do not match' });
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/auth/password', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current, next }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ ok: false, text: body.error ?? 'Could not change password' });
        return;
      }
      setCurrent('');
      setNext('');
      setConfirm('');
      setMessage({ ok: true, text: 'Password changed. You have been signed out on other devices.' });
    } catch {
      setMessage({ ok: false, text: 'Request failed to send. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card card-pad">
      <h2>My account</h2>
      <p className="small" style={{ marginBottom: 10 }}>
        {name} · {email} · {ROLE_LABEL[role]}
      </p>
      <form onSubmit={submit}>
        <input type="email" autoComplete="username" value={email} readOnly hidden />
        <label className="field">
          Current password
          <input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <div className="settings-grid">
          <label className="field">
            New password (at least 10 characters)
            <input type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} />
          </label>
          <label className="field">
            Confirm new password
            <input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
        </div>
        <button className="btn" disabled={busy}>
          {busy ? 'Saving…' : 'Change password'}
        </button>
      </form>
      {message && (
        <p className={`notice ${message.ok ? 'notice-info' : 'notice-danger'}`} role="status" style={{ marginTop: 10 }}>
          {message.text}
        </p>
      )}
    </section>
  );
}
