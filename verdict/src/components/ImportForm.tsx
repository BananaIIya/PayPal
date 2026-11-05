'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function ImportForm({ orders }: { orders: { id: string; label: string }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch('/api/claims', { method: 'POST', body: new FormData(e.currentTarget) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error ?? '导入失败');
      setBusy(false);
      return;
    }
    router.push(`/claims/${body.claimId}`);
  }

  return (
    <form className="card card-pad" onSubmit={submit}>
      <label className="field">
        订单
        <select name="orderId" required>
          {orders.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        问题类型
        <select name="claimType" defaultValue="damaged">
          <option value="damaged">损坏</option>
          <option value="not_as_described">与描述不符</option>
          <option value="missing_items">少件或空箱</option>
          <option value="not_received">未收到货</option>
        </select>
      </label>
      <label className="field">
        对话原文
        <textarea name="narrative" rows={5} placeholder="粘贴买家的邮件或私信内容" />
      </label>
      <label className="field">
        买家发来的照片
        <input type="file" name="photos" accept="image/jpeg,image/png,image/webp" multiple />
      </label>
      <label className="field">
        聊天截图或收据
        <input type="file" name="screenshots" accept="image/jpeg,image/png,image/webp" multiple />
      </label>
      {error && (
        <p className="notice notice-danger" style={{ marginBottom: 12 }}>
          {error}
        </p>
      )}
      <button className="btn btn-primary" disabled={busy}>
        {busy ? '导入中…' : '导入并开始分析'}
      </button>
    </form>
  );
}
