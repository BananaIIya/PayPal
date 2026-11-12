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
  active: { text: 'Active', cls: 'level-low' },
  off: { text: 'Off', cls: 'badge-warn' },
  simulated: { text: 'Simulated', cls: 'badge-sim' },
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
      ? { ...p, state: 'active' as const, detail: 'Sandbox configured. Sandbox orders call the PayPal sandbox. The 18 demo cases still use the simulator.' }
      : { ...p, state: 'off' as const, detail: sandbox.error ?? 'Misconfigured' };
  });
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          {!isOwner && <p className="muted">Members, PayPal credentials and verdict settings are managed by the owner.</p>}
        </div>
      </div>
      <div className="two-col">
        <section className="card card-pad">
          <h2>External services</h2>
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
              <h2>Demo data</h2>
              <p className="muted" style={{ marginBottom: 10 }}>
                Clears your actions and new claims and restores the 18 original demo cases. Local records of sandbox orders are also cleared. Transactions on PayPal are not affected, and open disputes will sync again. Verdict settings are reset to defaults. Accounts and PayPal credentials are kept.
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
