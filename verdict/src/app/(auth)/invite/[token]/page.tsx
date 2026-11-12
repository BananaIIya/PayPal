import { SetPasswordForm } from '@/components/AuthForms';
import { ROLE_LABEL } from '@/core/types';
import { peekPasswordLink } from '@/server/auth';
import { ready } from '@/server/bootstrap';

export const dynamic = 'force-dynamic';

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  await ready();
  const { token } = await params;
  const link = peekPasswordLink(token);
  if (!link) {
    return (
      <section className="card card-pad auth-card">
        <h1>Set password</h1>
        <p className="notice notice-danger">This link has expired or was already used. Ask the owner to create a new one in Settings.</p>
      </section>
    );
  }
  return (
    <section className="card card-pad auth-card">
      <h1>{link.purpose === 'invite' ? 'Join Verdict' : 'Reset password'}</h1>
      <p className="muted small" style={{ marginBottom: 14 }}>
        {link.name} ({link.email}) · {ROLE_LABEL[link.role]}
        {link.purpose === 'reset' ? '. Setting a new password signs you out on other devices.' : ''}
      </p>
      <SetPasswordForm token={token} email={link.email} />
    </section>
  );
}
