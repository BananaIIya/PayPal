import Link from 'next/link';
import { publicPayPalStatus } from '@/paypal/config';

const PILL = {
  off: '演示环境 · PayPal 与物流均为模拟，无真实资金',
  ready: 'PayPal 沙箱已配置 · 演示订单仍走模拟器 · 无真实资金',
  invalid: '演示环境 · PayPal 沙箱配置有误，见设置页',
};

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="shell-top">
        <Link href="/claims" className="brand">
          Verdict
        </Link>
        <nav aria-label="主导航">
          <Link href="/claims">索赔</Link>
          <Link href="/orders">订单与留底</Link>
          <Link href="/settings">设置</Link>
        </nav>
        <span className="sim-pill">{PILL[publicPayPalStatus().state]}</span>
      </header>
      <main className="page">{children}</main>
    </>
  );
}
