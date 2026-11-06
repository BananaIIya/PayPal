'use client';

import { useState } from 'react';

export function TestOrderForm({ products }: { products: { key: string; title: string; amount: number }[] }) {
  const [productKey, setProductKey] = useState(products[0]?.key ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/paypal/test-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productKey }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.approveUrl) {
        setError(body.error ?? '下单失败');
        setBusy(false);
        return;
      }
      window.location.href = body.approveUrl;
    } catch {
      setError('请求没有发出去，请重试');
      setBusy(false);
    }
  }

  return (
    <section className="card card-pad" style={{ marginBottom: 14 }}>
      <h2>沙箱测试下单</h2>
      <p className="muted" style={{ marginBottom: 10 }}>
        会跳转到 PayPal 沙箱，用你的沙箱个人账户付款，全程是测试资金。付款方式请选 Visa：默认的银行账户走 eCheck，款项会一直待处理，部分退款和多数争议选项都测不了。付款后用同一个账户开争议，Verdict 会自动同步过来。
      </p>
      <form className="row" onSubmit={submit}>
        <select value={productKey} onChange={(e) => setProductKey(e.target.value)} aria-label="测试商品" style={{ width: 'auto' }}>
          {products.map((p) => (
            <option key={p.key} value={p.key}>
              {p.title} · USD {p.amount.toFixed(2)}
            </option>
          ))}
        </select>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? '跳转中…' : '去沙箱付款'}
        </button>
      </form>
      {error && (
        <p className="notice notice-danger" style={{ marginTop: 10 }}>
          {error}
        </p>
      )}
    </section>
  );
}
