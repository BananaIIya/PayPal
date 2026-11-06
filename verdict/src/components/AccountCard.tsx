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
    if (next !== confirm) return setMessage({ ok: false, text: '两次输入的新密码不一样' });
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/auth/password', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current, next }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ ok: false, text: body.error ?? '修改失败' });
        return;
      }
      setCurrent('');
      setNext('');
      setConfirm('');
      setMessage({ ok: true, text: '密码已修改，其他设备上的登录已失效。' });
    } catch {
      setMessage({ ok: false, text: '请求没有发出去，请重试' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card card-pad">
      <h2>我的账号</h2>
      <p className="small" style={{ marginBottom: 10 }}>
        {name} · {email} · {ROLE_LABEL[role]}
      </p>
      <form onSubmit={submit}>
        <input type="email" autoComplete="username" value={email} readOnly hidden />
        <label className="field">
          当前密码
          <input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <div className="settings-grid">
          <label className="field">
            新密码（至少 10 位）
            <input type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} />
          </label>
          <label className="field">
            再输一次
            <input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
        </div>
        <button className="btn" disabled={busy}>
          {busy ? '保存中…' : '修改密码'}
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
