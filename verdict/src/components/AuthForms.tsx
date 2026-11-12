'use client';

import { useState } from 'react';

const MIN_PASSWORD = 10;

async function post(url: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, data: { error: 'Request failed to send. Check your connection and try again.' } };
  }
}

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return { busy, setBusy, error, setError };
}

export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const s = useSubmit();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    s.setBusy(true);
    s.setError(null);
    const { ok, data } = await post('/api/auth/login', { email, password, next });
    if (!ok) {
      s.setBusy(false);
      s.setError(String(data.error ?? 'Sign-in failed'));
      return;
    }
    // 整页跳转，让服务端组件带着新的会话重新渲染。
    window.location.assign(typeof data.next === 'string' ? data.next : '/claims');
  }

  return (
    <form onSubmit={submit}>
      <label className="field">
        Email
        <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="field">
        Password
        <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {s.error && (
        <p className="notice notice-danger" role="alert" style={{ marginBottom: 12 }}>
          {s.error}
        </p>
      )}
      <button className="btn btn-primary" style={{ width: '100%' }} disabled={s.busy}>
        {s.busy ? 'Signing in…' : 'Sign in'}
      </button>
      <p className="muted small" style={{ marginTop: 12 }}>
        Forgot your password? Agents: ask the owner for a new link. Owners: run <code>npm run account-link -- your-email</code> on the server.
      </p>
    </form>
  );
}

function NewPasswordFields(p: { password: string; setPassword: (v: string) => void; confirm: string; setConfirm: (v: string) => void }) {
  return (
    <>
      <label className="field">
        Password (at least {MIN_PASSWORD} characters)
        <input type="password" autoComplete="new-password" required minLength={MIN_PASSWORD} value={p.password} onChange={(e) => p.setPassword(e.target.value)} />
      </label>
      <label className="field">
        Confirm password
        <input type="password" autoComplete="new-password" required value={p.confirm} onChange={(e) => p.setConfirm(e.target.value)} />
      </label>
    </>
  );
}

function mismatch(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters`;
  if (password !== confirm) return 'Passwords do not match';
  return null;
}

export function SetupForm({ token }: { token: string }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const s = useSubmit();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const problem = mismatch(password, confirm);
    if (problem) return s.setError(problem);
    s.setBusy(true);
    s.setError(null);
    const { ok, data } = await post('/api/auth/setup', { token, name, email, password });
    if (!ok) {
      s.setBusy(false);
      s.setError(String(data.error ?? 'Could not create account'));
      return;
    }
    window.location.assign('/claims');
  }

  return (
    <form onSubmit={submit}>
      <label className="field">
        Name
        <input type="text" autoComplete="name" required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        Email (used to sign in)
        <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <NewPasswordFields password={password} setPassword={setPassword} confirm={confirm} setConfirm={setConfirm} />
      {s.error && (
        <p className="notice notice-danger" role="alert" style={{ marginBottom: 12 }}>
          {s.error}
        </p>
      )}
      <button className="btn btn-primary" style={{ width: '100%' }} disabled={s.busy}>
        {s.busy ? 'Creating…' : 'Create and sign in'}
      </button>
    </form>
  );
}

export function SetPasswordForm({ token, email }: { token: string; email: string }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const s = useSubmit();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const problem = mismatch(password, confirm);
    if (problem) return s.setError(problem);
    s.setBusy(true);
    s.setError(null);
    const { ok, data } = await post('/api/auth/password', { token, password });
    if (!ok) {
      s.setBusy(false);
      s.setError(String(data.error ?? 'Could not set password'));
      return;
    }
    window.location.assign('/claims');
  }

  return (
    <form onSubmit={submit}>
      {/* 让密码管理器知道这个密码属于哪个账号。 */}
      <input type="email" autoComplete="username" value={email} readOnly hidden />
      <NewPasswordFields password={password} setPassword={setPassword} confirm={confirm} setConfirm={setConfirm} />
      {s.error && (
        <p className="notice notice-danger" role="alert" style={{ marginBottom: 12 }}>
          {s.error}
        </p>
      )}
      <button className="btn btn-primary" style={{ width: '100%' }} disabled={s.busy}>
        {s.busy ? 'Saving…' : 'Set password and sign in'}
      </button>
    </form>
  );
}

export function LogoutButton() {
  const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    await post('/api/auth/logout', {});
    window.location.assign('/login');
  }
  return (
    <button className="btn btn-ghost-dark" onClick={logout} disabled={busy}>
      Sign out
    </button>
  );
}
