import { redirect } from 'next/navigation';
import { SetupForm } from '@/components/AuthForms';
import { checkSetupToken, userCount } from '@/server/auth';
import { ready } from '@/server/bootstrap';

export const dynamic = 'force-dynamic';

export default async function SetupPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  await ready();
  if (userCount() > 0) redirect('/login');
  const { token } = await searchParams;
  return (
    <section className="card card-pad auth-card">
      <h1>创建店主账号</h1>
      {token && checkSetupToken(token) ? (
        <>
          <p className="muted small" style={{ marginBottom: 14 }}>
            店主可以确认退款、接受索赔等资金动作，管理成员和 PayPal 凭证。之后可以在设置页添加客服账号。
          </p>
          <SetupForm token={token} />
        </>
      ) : (
        <p className="notice notice-danger">
          设置链接不对。请使用服务端终端里打印的链接，或在项目目录运行 <code>npm run account-link</code> 获取。
        </p>
      )}
    </section>
  );
}
