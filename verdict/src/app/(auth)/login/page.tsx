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
      <h1>Sign in to the console</h1>
      {userCount() === 0 ? (
        <>
          <p style={{ marginBottom: 8 }}>No console accounts yet.</p>
          <p className="muted small">
            To get started, open the setup link printed in the server terminal and create the owner account. If you cannot find it, run <code>npm run account-link</code> in the project directory to print it again.
          </p>
        </>
      ) : (
        <LoginForm next={safeNext(next)} />
      )}
    </section>
  );
}
