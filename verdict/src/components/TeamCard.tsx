'use client';

import { useState } from 'react';
import { ROLE_LABEL, type Role } from '@/core/types';
import type { TeamMember } from '@/server/auth';
import { fmtDateTime } from './format';

const STATUS: Record<TeamMember['status'], { text: string; cls: string }> = {
  active: { text: '可用', cls: 'level-low' },
  invited: { text: '待设置密码', cls: 'badge-warn' },
  disabled: { text: '已停用', cls: 'badge-sim' },
};

async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { ok: res.ok, data: await res.json().catch(() => ({})) };
  } catch {
    return { ok: false, data: { error: '请求没有发出去，请重试' } };
  }
}

function LinkBox({ link, note }: { link: string; note: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="notice notice-info" style={{ marginTop: 10 }}>
      <div className="small">{note}</div>
      <div className="link-box">
        <input type="text" readOnly value={link} aria-label="设置密码链接" onFocus={(e) => e.currentTarget.select()} />
        <button
          className="btn"
          onClick={() => {
            void navigator.clipboard?.writeText(link).then(() => setCopied(true));
          }}
        >
          {copied ? '已复制' : '复制'}
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
    if (!ok) return setError(String(data.error ?? '添加失败'));
    const member = data.member as TeamMember;
    setMembers((m) => [...m, member]);
    setLink({ link: String(data.link), note: `把这个链接发给 ${member.name}，对方打开后设置密码即可登录。72 小时内有效，只能用一次，关闭后不会再显示。` });
    setName('');
    setEmail('');
  }

  async function toggle(m: TeamMember) {
    const disabling = m.status !== 'disabled';
    if (disabling && !window.confirm(`停用 ${m.name}？对方所有设备上的登录会立即失效。`)) return;
    setBusy(true);
    setError(null);
    const { ok, data } = await call(`/api/team/${m.id}`, 'PATCH', { disabled: disabling });
    setBusy(false);
    if (!ok) return setError(String(data.error ?? '操作失败'));
    const updated = data.member as TeamMember;
    setMembers((list) => list.map((x) => (x.id === updated.id ? updated : x)));
  }

  async function reissue(m: TeamMember) {
    const text = m.status === 'invited' ? `重新生成 ${m.name} 的邀请链接？之前的链接会失效。` : `给 ${m.name} 生成重置密码链接？对方设置新密码后，旧密码和已登录的设备都会失效。`;
    if (!window.confirm(text)) return;
    setBusy(true);
    setError(null);
    setLink(null);
    const { ok, data } = await call(`/api/team/${m.id}/link`, 'POST');
    setBusy(false);
    if (!ok) return setError(String(data.error ?? '生成失败'));
    setLink({ link: String(data.link), note: `把这个链接发给 ${m.name}。72 小时内有效，只能用一次，关闭后不会再显示。` });
  }

  return (
    <section className="card card-pad">
      <h2>成员</h2>
      <p className="muted small" style={{ marginBottom: 10 }}>
        店主可以确认退款、接受索赔、和解、确认收到退货，管理成员、PayPal 凭证和判定设置。客服可以查看索赔、发消息、提交证据、升级和申诉，不能确认资金动作。
      </p>
      {/* 卡片在两栏布局里很窄，用列表而不是表格，避免右侧的操作被挤出可视区。 */}
      <ul className="member-list">
        {members.map((m) => (
          <li key={m.id} className="member-row">
            <div>
              <div>
                {m.name}
                {m.id === selfId && <span className="muted small">（你）</span>}
              </div>
              <div className="muted small">
                {m.email} · 最近登录 {m.lastLoginAt ? fmtDateTime(m.lastLoginAt) : '—'}
              </div>
            </div>
            <div className="row">
              <span className="small">{ROLE_LABEL[m.role]}</span>
              <span className={`badge ${STATUS[m.status].cls}`}>{STATUS[m.status].text}</span>
              {m.id !== selfId && m.status !== 'disabled' && (
                <button className="btn-link small" disabled={busy} onClick={() => reissue(m)}>
                  {m.status === 'invited' ? '重新邀请' : '重置密码'}
                </button>
              )}
              {m.id !== selfId && (
                <button className="btn-link small" disabled={busy} onClick={() => toggle(m)}>
                  {m.status === 'disabled' ? '启用' : '停用'}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {link && <LinkBox link={link.link} note={link.note} />}
      <form onSubmit={invite} style={{ marginTop: 14 }}>
        <h3 style={{ marginBottom: 8 }}>添加成员</h3>
        <div className="settings-grid">
          <label className="field">
            名字
            <input type="text" required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            邮箱（登录用）
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="field">
            角色
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="agent">客服</option>
              <option value="owner">店主</option>
            </select>
          </label>
        </div>
        <button className="btn btn-primary" disabled={busy}>
          {busy ? '处理中…' : '添加并生成邀请链接'}
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
