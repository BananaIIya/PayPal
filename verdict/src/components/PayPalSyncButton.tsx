'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function PayPalSyncButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function sync() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/paypal/sync', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setResult(body.error ?? '同步失败');
      else {
        const skipped = body.skipped?.length ? `，跳过 ${body.skipped.length} 笔` : '';
        setResult(`新增 ${body.created} 笔，更新 ${body.updated} 笔${skipped}`);
      }
      router.refresh();
    } catch {
      setResult('请求没有发出去，请重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {result && <span className="muted small">{result}</span>}
      <button className="btn" disabled={busy} onClick={sync}>
        {busy ? '同步中…' : '同步 PayPal 沙箱'}
      </button>
    </>
  );
}
