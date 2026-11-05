'use client';

import { useState } from 'react';

const TOOLS = [
  { tool: 'require_evidence', value: 'SELLER_EVIDENCE', label: '要求商家举证', link: 'requireEvidence' },
  { tool: 'require_evidence', value: 'BUYER_EVIDENCE', label: '要求买家举证', link: 'requireEvidence' },
  { tool: 'adjudicate', value: 'SELLER_FAVOR', label: '裁决：商家胜', link: 'adjudicate' },
  { tool: 'adjudicate', value: 'BUYER_FAVOR', label: '裁决：买家胜', link: 'adjudicate' },
] as const;

export function SandboxTools(p: {
  claimId: string;
  links: { requireEvidence: boolean; adjudicate: boolean };
  onDone: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = TOOLS.filter((t) => p.links[t.link]);

  async function run(t: (typeof TOOLS)[number]) {
    if (!window.confirm(`在 PayPal 沙箱里执行“${t.label}”？这会改变这笔争议的状态，无法撤回。`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/paypal/sandbox-tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimId: p.claimId, tool: t.tool, value: t.value, confirm: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setError(body.error ?? '执行失败');
      await p.onDone();
    } catch {
      setError('请求没有发出去，请重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card card-pad no-print">
      <h2>沙箱测试工具</h2>
      <p className="muted small" style={{ marginBottom: 10 }}>
        PayPal 只在沙箱提供这些接口，用来把争议推进到要测试的状态。
      </p>
      {available.length === 0 ? (
        <p className="muted small">PayPal 现在没有给这笔争议提供测试接口。新争议一般要等几分钟才会出现。</p>
      ) : (
        <div className="row">
          {available.map((t) => (
            <button key={t.value} className="btn" disabled={busy} onClick={() => run(t)}>
              {t.label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="notice notice-danger small" style={{ marginTop: 10 }}>
          {error}
        </p>
      )}
    </section>
  );
}
