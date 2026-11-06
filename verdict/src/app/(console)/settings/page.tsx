import { AccountCard } from '@/components/AccountCard';
import { PayPalCredentialsCard } from '@/components/PayPalCredentialsCard';
import { PayPalSandboxCard } from '@/components/PayPalSandboxCard';
import { ResetDemo } from '@/components/ResetDemo';
import { SettingsForm } from '@/components/SettingsForm';
import { TeamCard } from '@/components/TeamCard';
import { publicPayPalStatus } from '@/paypal/config';
import { providerStatus } from '@/providers/registry';
import { listMembers } from '@/server/auth';
import { ready } from '@/server/bootstrap';
import { pageUser } from '@/server/guard';
import { paypalCredentialView } from '@/server/paypal-credentials';
import { lastSync } from '@/server/paypal-sync';
import { defaultMerchantId } from '@/server/repo';
import { settingsView } from '@/server/settings';

export const dynamic = 'force-dynamic';

const STATE = {
  active: { text: '已启用', cls: 'level-low' },
  off: { text: '未启用', cls: 'badge-warn' },
  simulated: { text: '模拟', cls: 'badge-sim' },
} as const;

// node:sqlite 的行没有原型，跨到客户端组件前转成普通对象。
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export default async function SettingsPage() {
  await ready();
  const viewer = await pageUser();
  const isOwner = viewer.role === 'owner';
  const merchantId = defaultMerchantId();
  const settings = merchantId ? plain(settingsView(merchantId)) : null;
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
          <p className="muted">
            {isOwner
              ? '成员、PayPal 凭证、判定权重、类目策略、退货地址和保留期在这里改。检测服务和 LLM 的密钥通过环境变量配置，参见 .env.example。'
              : '你是客服账号：可以修改自己的密码，查看判定设置。成员、PayPal 凭证和判定设置由店主管理。'}
          </p>
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
          {isOwner && merchantId && <PayPalCredentialsCard initial={plain(paypalCredentialView(merchantId))} />}
        </div>
      </div>
      <div className="two-col" style={{ marginTop: 14 }}>
        {isOwner ? <TeamCard initial={plain(listMembers(viewer.merchantId))} selfId={viewer.id} /> : <AccountCard name={viewer.name} email={viewer.email} role={viewer.role} />}
        <div className="stack" style={{ gap: 14 }}>
          {isOwner && <AccountCard name={viewer.name} email={viewer.email} role={viewer.role} />}
          {isOwner && (
            <section className="card card-pad">
              <h2>演示数据</h2>
              <p className="muted" style={{ marginBottom: 10 }}>
                清空你的操作和新建的索赔，恢复到 18 个初始场景。沙箱订单的本地记录也会被清除，PayPal 上的交易不受影响，还在进行的争议之后会重新同步过来。判定设置也会恢复默认；账号和 PayPal 凭证保留。
              </p>
              <ResetDemo />
            </section>
          )}
        </div>
      </div>
      {settings && (
        <div className="stack" style={{ gap: 14, marginTop: 14 }}>
          <SettingsForm initial={settings} readOnly={!isOwner} />
        </div>
      )}
    </>
  );
}
