import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/AuthForms';
import { userCount } from '@/server/auth';
import { ready } from '@/server/bootstrap';
import { optionalPageUser, safeNext } from '@/server/guard';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  await ready();
  const { next } = await searchParams;
  if (await optionalPageUser()) redirect(safeNext(next));
  return (
    <section className="card card-pad auth-card">
      <h1>登录控制台</h1>
      {userCount() === 0 ? (
        <>
          <p style={{ marginBottom: 8 }}>还没有控制台账号。</p>
          <p className="muted small">
            首次使用请打开服务端终端里打印的设置链接，用它创建店主账号。找不到时，在项目目录运行 <code>npm run account-link</code> 再打印一次。
          </p>
        </>
      ) : (
        <LoginForm next={safeNext(next)} />
      )}
    </section>
  );
}
