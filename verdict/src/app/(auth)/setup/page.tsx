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
      <h1>Create owner account</h1>
      {token && checkSetupToken(token) ? (
        <SetupForm token={token} />
      ) : (
        <p className="notice notice-danger">
          Invalid setup link. Use the link printed in the server terminal, or run <code>npm run account-link</code> in the project directory to get one.
        </p>
      )}
    </section>
  );
}
