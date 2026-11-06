'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { PayPalCredentialView } from '@/server/paypal-credentials';
import { fmtDateTime } from './format';

const SOURCE_TEXT: Record<PayPalCredentialView['source'], string> = {
  database: '正在使用：设置页保存的凭证（加密存储）',
  env: '正在使用：环境变量里的凭证',
  none: '还没有配置，PayPal 走模拟器',
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
        setMessage({ ok: false, text: data.error ?? '保存失败' });
        return;
      }
      setView(data as PayPalCredentialView);
      setClientId('');
      setSecret('');
      setMessage({ ok: true, text: method === 'PUT' ? 'PayPal 接受了这组凭证，已加密保存。' : '已删除设置页保存的凭证。' });
      router.refresh();
    } catch {
      setMessage({ ok: false, text: '请求没有发出去，请重试' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card card-pad">
      <h2>PayPal 凭证</h2>
      <p className="small" style={{ marginBottom: 6 }}>
        {SOURCE_TEXT[view.source]}
      </p>
      {view.stored && (
        <p className="muted small" style={{ marginBottom: 6 }}>
          已保存：Client ID 尾号 <span className="mono">{view.stored.clientIdTail}</span>
          {view.stored.webhookId ? ' · 已填 Webhook ID' : ''} · {view.stored.updatedBy} 于 {fmtDateTime(view.stored.updatedAt)} 保存
        </p>
      )}
      {view.error && <p className="notice notice-danger" style={{ marginBottom: 10 }}>{view.error}</p>}
      {!canSave ? (
        <p className="notice" style={{ marginBottom: 10 }}>
          {view.encryption.error ?? '服务端没有配置 APP_ENCRYPTION_KEY，所以不能在这里保存凭证。'}
          在 .env.local 里加上 APP_ENCRYPTION_KEY（用 openssl rand -hex 32 生成）并重启服务后就可以保存。
          {view.source === 'env' ? '现在用的是环境变量里的凭证，不受影响。' : ''}
        </p>
      ) : (
        <p className="muted small" style={{ marginBottom: 10 }}>
          只支持沙箱应用的凭证。Secret 用 AES-256-GCM 加密后存库，密钥来自 APP_ENCRYPTION_KEY，保存后任何页面都不会再显示。保存前会先向 PayPal 验证。设置页保存的凭证优先于环境变量。换成另一个沙箱账户后，之前的沙箱订单和争议就不能再操作了。
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
            Webhook ID（可选）
            <input type="text" autoComplete="off" spellCheck={false} value={webhookId} onChange={(e) => setWebhookId(e.target.value)} />
          </label>
          <button className="btn btn-primary">{busy ? '验证中…' : '验证并保存'}</button>
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
            if (window.confirm(`删除设置页保存的凭证？${view.envConfigured ? '之后会改用环境变量里的凭证。' : '之后 PayPal 会回到模拟器。'}`)) void send('DELETE');
          }}
        >
          删除保存的凭证
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
