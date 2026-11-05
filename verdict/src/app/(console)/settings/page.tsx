import { DEFAULT_CONFIG, SOURCE_LABEL, STRENGTH_LABEL } from '@/core/catalog';
import type { SourceMark, Strength } from '@/core/types';
import { PayPalSandboxCard } from '@/components/PayPalSandboxCard';
import { ResetDemo } from '@/components/ResetDemo';
import { publicPayPalStatus } from '@/paypal/config';
import { providerStatus } from '@/providers/registry';
import { ready } from '@/server/bootstrap';
import { lastSync } from '@/server/paypal-sync';

export const dynamic = 'force-dynamic';

const STATE = {
  active: { text: '已启用', cls: 'level-low' },
  off: { text: '未启用', cls: 'badge-warn' },
  simulated: { text: '模拟', cls: 'badge-sim' },
} as const;

export default async function SettingsPage() {
  await ready();
  const cfg = DEFAULT_CONFIG;
  const sandbox = publicPayPalStatus();
  const services = providerStatus().map((p) => {
    if (p.category !== 'PayPal' || sandbox.state === 'off') return p;
    return sandbox.state === 'ready'
      ? { ...p, state: 'active' as const, detail: '沙箱已配置。沙箱订单调用 PayPal 沙箱，18 个演示场景仍走模拟器' }
      : { ...p, state: 'off' as const, detail: sandbox.error ?? '配置有误' };
  });
  return (
    <>
      <div className="page-head">
        <div>
          <h1>设置</h1>
          <p className="muted">MVP 里这一页只读。真实密钥通过环境变量配置，参见 .env.example。</p>
        </div>
      </div>
      <div className="two-col">
        <section className="card card-pad">
          <h2>外部服务</h2>
          {services.map((p) => (
            <div key={p.category} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
              <div className="between">
                <strong>{p.category}</strong>
                <span className={`badge ${STATE[p.state].cls}`}>{STATE[p.state].text}</span>
              </div>
              <div className="muted small">{p.detail}</div>
            </div>
          ))}
        </section>
        <div className="stack" style={{ gap: 14 }}>
          <PayPalSandboxCard status={sandbox} lastSync={lastSync()} />
          <section className="card card-pad">
            <h2>判定权重与阈值</h2>
            <dl className="kv">
              {(Object.keys(cfg.strengthWeight) as Strength[]).map((k) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>强度 {STRENGTH_LABEL[k]}</dt>
                  <dd className="num">{cfg.strengthWeight[k]}</dd>
                </div>
              ))}
              {(['live_capture', 'paypal_dispute', 'uploaded', 'narrative'] as SourceMark[]).map((k) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{SOURCE_LABEL[k]}</dt>
                  <dd className="num">{cfg.sourceWeight[k]}</dd>
                </div>
              ))}
              <dt>中风险阈值</dt>
              <dd className="num">R ≥ {cfg.riskMedium}</dd>
              <dt>高风险阈值</dt>
              <dd className="num">R ≥ {cfg.riskHigh}</dd>
              <dt>Q 充足</dt>
              <dd className="num">Q ≥ {cfg.minDataConfidence}（文档未定义，MVP 暂定）</dd>
              <dt>M 高</dt>
              <dd className="num">M ≥ {cfg.merchantRiskHigh}（文档未定义，MVP 暂定）</dd>
            </dl>
          </section>
          <section className="card card-pad">
            <h2>演示数据</h2>
            <p className="muted" style={{ marginBottom: 10 }}>
              清空你的操作和新建的索赔，恢复到 18 个初始场景。沙箱订单的本地记录也会被清除，PayPal 上的交易不受影响，还在进行的争议之后会重新同步过来。
            </p>
            <ResetDemo />
          </section>
        </div>
      </div>
    </>
  );
}
