import Link from 'next/link';
import { LogoutButton } from '@/components/AuthForms';
import { Brand } from '@/components/Brand';
import { ShellNav } from '@/components/ShellNav';
import { ROLE_LABEL } from '@/core/types';
import { publicPayPalStatus } from '@/paypal/config';
import { ready } from '@/server/bootstrap';
import { pageUser } from '@/server/guard';

const ENV = {
  off: { title: 'Demo environment', detail: 'PayPal and shipping are simulated. No real money.' },
  ready: { title: 'PayPal sandbox configured', detail: 'Demo orders still use the simulator. No real money.' },
  invalid: { title: 'PayPal sandbox misconfigured', detail: 'Running as demo environment. See Settings.' },
};

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  await ready();
  // 布局在客户端导航时不一定重新渲染，所以每个页面和接口还会各自校验；这里负责显示当前用户。
  const user = await pageUser();
  const state = publicPayPalStatus().state;
  return (
    <div className="shell">
      <aside className="rail">
        <Link href="/claims" className="brand">
          <Brand />
        </Link>
        <ShellNav owner={user.role === 'owner'} />
        <div className="rail-foot">
          <div className={`env env-${state}`}>
            <i className="env-dot" aria-hidden="true" />
            <div>
              <b>{ENV[state].title}</b>
              <span>{ENV[state].detail}</span>
            </div>
          </div>
          <div className="rail-user">
            <span className="avatar" aria-hidden="true">
              {user.name.trim().slice(0, 1).toUpperCase()}
            </span>
            <span className="rail-user-name">
              <b>{user.name}</b>
              <span>{ROLE_LABEL[user.role]}</span>
            </span>
            <LogoutButton />
          </div>
        </div>
      </aside>
      <main className="page">{children}</main>
    </div>
  );
}
