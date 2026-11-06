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
        <h1>设置密码</h1>
        <p className="notice notice-danger">链接已失效或已经用过。请让店主在设置页重新生成。</p>
      </section>
    );
  }
  return (
    <section className="card card-pad auth-card">
      <h1>{link.purpose === 'invite' ? '加入 Verdict' : '重置密码'}</h1>
      <p className="muted small" style={{ marginBottom: 14 }}>
        {link.name}（{link.email}）· {ROLE_LABEL[link.role]}
        {link.purpose === 'reset' ? '。设置新密码后，其他设备上的登录会失效。' : ''}
      </p>
      <SetPasswordForm token={token} email={link.email} />
    </section>
  );
}
