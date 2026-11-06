import Link from 'next/link';
import { LogoutButton } from '@/components/AuthForms';
import { ROLE_LABEL } from '@/core/types';
import { publicPayPalStatus } from '@/paypal/config';
import { ready } from '@/server/bootstrap';
import { pageUser } from '@/server/guard';

const PILL = {
  off: '演示环境 · PayPal 与物流均为模拟，无真实资金',
  ready: 'PayPal 沙箱已配置 · 演示订单仍走模拟器 · 无真实资金',
  invalid: '演示环境 · PayPal 沙箱配置有误，见设置页',
};

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  await ready();
  // 布局在客户端导航时不一定重新渲染，所以每个页面和接口还会各自校验；这里负责显示当前用户。
  const user = await pageUser();
  return (
    <>
      <header className="shell-top">
        <Link href="/claims" className="brand">
          Verdict
        </Link>
        <nav aria-label="主导航">
          <Link href="/claims">索赔</Link>
          <Link href="/orders">订单与留底</Link>
          {user.role === 'owner' && <Link href="/shadow">影子对照</Link>}
          <Link href="/settings">设置</Link>
        </nav>
        <span className="sim-pill">{PILL[publicPayPalStatus().state]}</span>
        <span className="shell-user">
          {user.name}
          <span className="role">{ROLE_LABEL[user.role]}</span>
          <LogoutButton />
        </span>
      </header>
      <main className="page">{children}</main>
    </>
  );
}
