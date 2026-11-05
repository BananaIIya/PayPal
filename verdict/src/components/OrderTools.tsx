'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function OrderTools({
  orderId,
  initialWeight,
  paypalEnv,
  captureId,
}: {
  orderId: string;
  initialWeight: number | null;
  paypalEnv: 'simulator' | 'sandbox';
  captureId: string | null;
}) {
  const router = useRouter();
  const [link, setLink] = useState<{ url: string; claimId: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [weight, setWeight] = useState(initialWeight ? String(initialWeight) : '');

  async function post(name: string, url: string, init: RequestInit) {
    setBusy(name);
    setError(null);
    const res = await fetch(url, init);
    const body = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setError(body.error ?? '操作失败');
      return null;
    }
    return body;
  }

  async function createLink() {
    const body = await post('link', `/api/orders/${orderId}/portal-link`, { method: 'POST' });
    if (body) setLink({ url: body.url, claimId: body.claimId });
  }

  async function simulate(reason: string, message: string) {
    const body = await post('dispute', '/api/demo/simulate-dispute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, reason, message }),
    });
    if (body?.claimId) router.push(`/claims/${body.claimId}`);
  }

  async function uploadReference(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const body = await post('ref', `/api/orders/${orderId}/references`, { method: 'POST', body: new FormData(form) });
    if (body) {
      form.reset();
      router.refresh();
    }
  }

  async function saveWeight() {
    const body = await post('weight', `/api/orders/${orderId}/weight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weightG: Number(weight) }),
    });
    if (body) router.refresh();
  }

  return (
    <>
      <section className="card card-pad">
        <h2>买家索赔链接</h2>
        <p className="muted" style={{ marginBottom: 10 }}>
          新建一笔等待买家提交的索赔，并生成一次性签名链接。
        </p>
        {paypalEnv === 'sandbox' && !captureId ? (
          <p className="muted small">这笔测试订单还没有付款。</p>
        ) : (
          <button className="btn btn-primary" disabled={busy === 'link'} onClick={createLink}>
            生成索赔链接
          </button>
        )}
        {link && (
          <div style={{ marginTop: 12 }}>
            <input type="text" readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} aria-label="索赔链接" />
            <div className="row" style={{ marginTop: 8 }}>
              <a className="btn" href={link.url} target="_blank" rel="noreferrer">
                打开买家页面
              </a>
              <button
                className="btn"
                onClick={async () => {
                  await navigator.clipboard.writeText(link.url);
                  setCopied(true);
                }}
              >
                {copied ? '已复制' : '复制'}
              </button>
              <a className="btn" href={`/claims/${link.claimId}`}>
                查看这笔索赔
              </a>
            </div>
          </div>
        )}
      </section>

      {paypalEnv === 'sandbox' ? (
        <section className="card card-pad">
          <h2>发起沙箱争议</h2>
          {captureId ? (
            <>
              <p className="muted" style={{ marginBottom: 8 }}>
                用付款的沙箱个人账户登录 PayPal 沙箱网站，找到这笔交易并报告问题。选“没收到货”或“与描述不符”，其他类型 Verdict 暂不处理。争议一般几分钟内会同步过来。
              </p>
              <p className="small">
                PayPal 交易号：<span className="mono">{captureId}</span>
              </p>
              <p className="muted small" style={{ marginTop: 8 }}>
                同一笔交易只能开一次争议，关闭后也不能再开。测试下一个场景要重新下单。
              </p>
            </>
          ) : (
            <p className="muted">付款完成后才能发起争议。</p>
          )}
        </section>
      ) : (
      <section className="card card-pad">
        <h2>模拟 PayPal 争议</h2>
        <p className="muted" style={{ marginBottom: 10 }}>
          让模拟器发起一笔争议，走一遍验签、去重、拉详情、建索赔的 webhook 流程。
        </p>
        <div className="row">
          <button className="btn" disabled={busy === 'dispute'} onClick={() => simulate('MERCHANDISE_OR_SERVICE_NOT_RECEIVED', '我一直没有收到这个包裹。')}>
            未收到货
          </button>
          <button className="btn" disabled={busy === 'dispute'} onClick={() => simulate('MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', '收到的商品和描述不一样。')}>
            与描述不符
          </button>
        </div>
      </section>
      )}

      <section className="card card-pad">
        <h2>发货留底</h2>
        <form onSubmit={uploadReference}>
          <label className="field">
            镜头
            <select name="shot" defaultValue="overall">
              <option value="overall">商品整体照</option>
              <option value="serial_closeup">序列号特写</option>
              <option value="package">外包装</option>
              <option value="label">面单特写</option>
            </select>
          </label>
          <label className="field">
            图片
            <input type="file" name="file" accept="image/jpeg,image/png,image/webp" required />
          </label>
          <button className="btn" disabled={busy === 'ref'}>
            上传留底
          </button>
        </form>
        <label className="field" style={{ marginTop: 16 }}>
          发货称重（克）
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input type="number" min="1" value={weight} onChange={(e) => setWeight(e.target.value)} />
            <button type="button" className="btn" disabled={busy === 'weight'} onClick={saveWeight}>
              保存
            </button>
          </div>
        </label>
        {error && <p className="notice notice-danger">{error}</p>}
      </section>
    </>
  );
}
