'use client';

import { useState } from 'react';
import { ROLE_LABEL, type Role } from '@/core/types';
import type { TeamMember } from '@/server/auth';
import { fmtDateTime } from './format';

const STATUS: Record<TeamMember['status'], { text: string; cls: string }> = {
  active: { text: 'Active', cls: 'level-low' },
  invited: { text: 'Password not set', cls: 'badge-warn' },
  disabled: { text: 'Disabled', cls: 'badge-sim' },
};

async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, data: { error: 'Request failed to send. Try again.' } };
  }
}

function LinkBox({ link, note }: { link: string; note: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="notice notice-info" style={{ marginTop: 10 }}>
      <div className="small">{note}</div>
      <div className="link-box">
        <input type="text" readOnly value={link} aria-label="Set password link" onFocus={(e) => e.currentTarget.select()} />
        <button
          className="btn"
          onClick={() => {
            void navigator.clipboard?.writeText(link).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

/** 店主管理成员。系统不发邮件：生成的链接由店主自己发给对方，只显示这一次。 */
export function TeamCard({ initial, selfId }: { initial: TeamMember[]; selfId: string }) {
  const [members, setMembers] = useState(initial);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('agent');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ link: string; note: string } | null>(null);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setLink(null);
    const { ok, data } = await call('/api/team', 'POST', { name, email, role });
    setBusy(false);
    if (!ok) return setError(String(data.error ?? 'Could not add member'));
    const member = data.member as TeamMember;
    setMembers((m) => [...m, member]);
    setLink({ link: String(data.link), note: `Send this link to ${member.name}. They can sign in after setting a password. Valid for 72 hours, single use, and not shown again after you close it.` });
    setName('');
    setEmail('');
  }

  async function toggle(m: TeamMember) {
    const disabling = m.status !== 'disabled';
    if (disabling && !window.confirm(`Disable ${m.name}? They will be signed out on all devices immediately.`)) return;
    setBusy(true);
    setError(null);
    const { ok, data } = await call(`/api/team/${m.id}`, 'PATCH', { disabled: disabling });
    setBusy(false);
    if (!ok) return setError(String(data.error ?? 'Action failed'));
    const updated = data.member as TeamMember;
    setMembers((list) => list.map((x) => (x.id === updated.id ? updated : x)));
  }

  async function reissue(m: TeamMember) {
    const text = m.status === 'invited' ? `Create a new invite link for ${m.name}? The previous link will stop working.` : `Create a password reset link for ${m.name}? After they set a new password, the old password and all signed-in devices stop working.`;
    if (!window.confirm(text)) return;
    setBusy(true);
    setError(null);
    setLink(null);
    const { ok, data } = await call(`/api/team/${m.id}/link`, 'POST');
    setBusy(false);
    if (!ok) return setError(String(data.error ?? 'Could not create link'));
    setLink({ link: String(data.link), note: `Send this link to ${m.name}. Valid for 72 hours, single use, and not shown again after you close it.` });
  }

  return (
    <section className="card card-pad">
      <h2>Members</h2>
      <p className="muted small" style={{ marginBottom: 10 }}>
        Owners can confirm refunds, accept claims, make offers, confirm returned items, and manage members, PayPal credentials and verdict settings. Agents can view claims, send messages, submit evidence, escalate and appeal, but cannot confirm money actions.
      </p>
      {/* 卡片在两栏布局里很窄，用列表而不是表格，避免右侧的操作被挤出可视区。 */}
      <ul className="member-list">
        {members.map((m) => (
          <li key={m.id} className="member-row">
            <div>
              <div>
                {m.name}
                {m.id === selfId && <span className="muted small"> (you)</span>}
              </div>
              <div className="muted small">
                {m.email} · Last sign-in {m.lastLoginAt ? fmtDateTime(m.lastLoginAt) : '—'}
              </div>
            </div>
            <div className="row">
              <span className="small">{ROLE_LABEL[m.role]}</span>
              <span className={`badge ${STATUS[m.status].cls}`}>{STATUS[m.status].text}</span>
              {m.id !== selfId && m.status !== 'disabled' && (
                <button className="btn-link small" disabled={busy} onClick={() => reissue(m)}>
                  {m.status === 'invited' ? 'Reinvite' : 'Reset password'}
                </button>
              )}
              {m.id !== selfId && (
                <button className="btn-link small" disabled={busy} onClick={() => toggle(m)}>
                  {m.status === 'disabled' ? 'Enable' : 'Disable'}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {link && <LinkBox link={link.link} note={link.note} />}
      <form onSubmit={invite} style={{ marginTop: 14 }}>
        <h3 style={{ marginBottom: 8 }}>Add member</h3>
        <div className="settings-grid">
          <label className="field">
            Name
            <input type="text" required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            Email (used to sign in)
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="field">
            Role
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="agent">Agent</option>
              <option value="owner">Owner</option>
            </select>
          </label>
        </div>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Working…' : 'Add and create invite link'}
        </button>
      </form>
      {error && (
        <p className="notice notice-danger" role="alert" style={{ marginTop: 10 }}>
          {error}
        </p>
      )}
    </section>
  );
}
