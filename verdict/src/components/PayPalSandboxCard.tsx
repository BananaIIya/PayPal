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
      setChecks(body.checks ?? [{ name: '连接', ok: false, detail: body.error ?? '检查失败' }]);
    } catch {
      setChecks([{ name: '连接', ok: false, detail: '请求没有发出去，请重试' }]);
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
        setSyncError(body.error ?? '同步失败');
      }
      router.refresh();
    } catch {
      setSyncError('请求没有发出去，请重试');
    } finally {
      setBusy(null);
    }
  }

  const { status, lastSync } = p;
  return (
    <section className="card card-pad">
      <h2>PayPal 沙箱</h2>
      {status.state === 'off' && (
        <p className="muted">还没有配置。在 .env.local 里填 PAYPAL_ENV、PAYPAL_CLIENT_ID、PAYPAL_CLIENT_SECRET，步骤见 README。没有配置时一切走模拟器。</p>
      )}
      {status.state === 'invalid' && <p className="notice notice-danger">{status.error}</p>}
      {status.state === 'ready' && (
        <>
          <dl className="kv">
            <dt>环境</dt>
            <dd>沙箱（代码里写死，不会连到正式环境）</dd>
            <dt>Client ID</dt>
            <dd className="mono">…{status.clientIdTail}</dd>
            <dt>Webhook</dt>
            <dd>{status.webhookConfigured ? '已配置 PAYPAL_WEBHOOK_ID' : '未配置，只靠每分钟的定时同步'}</dd>
            <dt>上次同步</dt>
            <dd suppressHydrationWarning>
              {lastSync ? `${fmtDateTime(lastSync.lastRunAt)}，新增 ${lastSync.created}，更新 ${lastSync.updated}，跳过 ${lastSync.skipped.length}` : '还没有同步过'}
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
                  <span className="mono">{s.id}</span>：{s.reason}
                </li>
              ))}
            </ul>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" disabled={!!busy} onClick={check}>
              {busy === 'check' ? '检查中…' : '检查连接'}
            </button>
            <button className="btn" disabled={!!busy} onClick={sync}>
              {busy === 'sync' ? '同步中…' : '立即同步'}
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
                    <span className={`badge ${c.ok ? 'level-low' : 'level-high'}`}>{c.ok ? '通过' : '未通过'}</span>
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
