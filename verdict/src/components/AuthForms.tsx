'use client';

import { useState } from 'react';

const MIN_PASSWORD = 10;

async function post(url: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, data: { error: '请求没有发出去，请检查网络后重试' } };
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
      s.setError(String(data.error ?? '登录失败'));
      return;
    }
    // 整页跳转，让服务端组件带着新的会话重新渲染。
    window.location.assign(typeof data.next === 'string' ? data.next : '/claims');
  }

  return (
    <form onSubmit={submit}>
      <label className="field">
        邮箱
        <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="field">
        密码
        <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {s.error && (
        <p className="notice notice-danger" role="alert" style={{ marginBottom: 12 }}>
          {s.error}
        </p>
      )}
      <button className="btn btn-primary" style={{ width: '100%' }} disabled={s.busy}>
        {s.busy ? '登录中…' : '登录'}
      </button>
      <p className="muted small" style={{ marginTop: 12 }}>
        忘记密码：客服请找店主重新生成链接；店主在服务端运行 <code>npm run account-link -- 你的邮箱</code>。
      </p>
    </form>
  );
}

function NewPasswordFields(p: { password: string; setPassword: (v: string) => void; confirm: string; setConfirm: (v: string) => void }) {
  return (
    <>
      <label className="field">
        密码（至少 {MIN_PASSWORD} 位）
        <input type="password" autoComplete="new-password" required minLength={MIN_PASSWORD} value={p.password} onChange={(e) => p.setPassword(e.target.value)} />
      </label>
      <label className="field">
        再输一次
        <input type="password" autoComplete="new-password" required value={p.confirm} onChange={(e) => p.setConfirm(e.target.value)} />
      </label>
    </>
  );
}

function mismatch(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD) return `密码至少 ${MIN_PASSWORD} 位`;
  if (password !== confirm) return '两次输入的密码不一样';
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
      s.setError(String(data.error ?? '创建失败'));
      return;
    }
    window.location.assign('/claims');
  }

  return (
    <form onSubmit={submit}>
      <label className="field">
        名字
        <input type="text" autoComplete="name" required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        邮箱（登录用）
        <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <NewPasswordFields password={password} setPassword={setPassword} confirm={confirm} setConfirm={setConfirm} />
      {s.error && (
        <p className="notice notice-danger" role="alert" style={{ marginBottom: 12 }}>
          {s.error}
        </p>
      )}
      <button className="btn btn-primary" style={{ width: '100%' }} disabled={s.busy}>
        {s.busy ? '创建中…' : '创建并登录'}
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
      s.setError(String(data.error ?? '设置失败'));
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
        {s.busy ? '保存中…' : '设置密码并登录'}
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
      退出
    </button>
  );
}
