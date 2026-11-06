'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** 开发文档“数据最小化”：按索赔删除全部数据。放在折叠区里，避免误点。 */
export function DeleteClaim({ claimId, blocked }: { claimId: string; blocked: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (!window.confirm('确定删除这笔索赔的全部数据吗？证据原件、判定和动作记录都会被删除，不能恢复。')) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/claims/${claimId}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? '删除失败');
        return;
      }
      router.push('/claims');
      router.refresh();
    } catch {
      setError('请求没有发出去，请重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card card-pad no-print">
      <details>
        <summary>删除这笔索赔的数据</summary>
        <p className="muted small" style={{ margin: '8px 0' }}>
          删除买家陈述、证据原件、挑战码、索赔页链接、分析信号、判定、动作记录和时间线，不能恢复。订单和双方消息属于订单，会保留。PayPal 上的争议和资金不受影响，Verdict 只留一条删除记录（编号和时间）。
        </p>
        {blocked ? (
          <p className="notice">{blocked}</p>
        ) : (
          <button className="btn btn-danger" disabled={busy} onClick={remove}>
            {busy ? '删除中…' : '删除全部数据'}
          </button>
        )}
        {error && (
          <p className="notice notice-danger" role="alert" style={{ marginTop: 8 }}>
            {error}
          </p>
        )}
      </details>
    </section>
  );
}
