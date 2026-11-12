// 控制台账号、会话和角色（开发文档“凭证与接口”：所有者和客服两种角色，资金动作仅所有者可确认）。
// 这里只有纯逻辑，不依赖 Next 的请求对象，便于测试；接到路由上的部分在 guard.ts。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROLE_LABEL, type Role } from '@/core/types';
import { dataDir, db, newId, nowIso, tx } from './db';

export { SESSION_COOKIE } from './cookie-name';
export const SESSION_MAX_MS = 7 * 24 * 3600_000;
const SESSION_IDLE_MS = 12 * 3600_000;
const TOUCH_INTERVAL_MS = 5 * 60_000;
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60_000;
const LINK_TTL_MS = 72 * 3600_000;
export const MIN_PASSWORD = 10;
const MAX_PASSWORD = 200;
// OWASP 对 scrypt 的最低建议：N=2^17、r=8、p=1，单次约 0.2 秒。参数写进哈希串，以后可以调。
const SCRYPT = { N: 2 ** 17, r: 8, p: 1 };
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

export interface AuthUser {
  id: string;
  merchantId: string;
  email: string;
  name: string;
  role: Role;
}

interface UserRow {
  id: string;
  merchant_id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string | null;
  failed_logins: number;
  locked_until: string | null;
  disabled_at: string | null;
  last_login_at: string | null;
  created_at: string;
}

export type AuthResult<T> = ({ ok: true } & T) | { ok: false; status: number; error: string };

const fail = (status: number, error: string) => ({ ok: false as const, status, error });

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function randomToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function toUser(row: UserRow): AuthUser {
  return { id: row.id, merchantId: row.merchant_id, email: row.email, name: row.name, role: row.role };
}

// ---------- 密码 ----------

function scrypt(password: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password.normalize('NFKC'), salt, 32, { ...params, maxmem: SCRYPT_MAXMEM }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, key] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// 账号不存在时也算一次哈希，让“没有这个邮箱”和“密码不对”耗时一样，不泄漏哪些邮箱注册过。
let dummyHash: Promise<string> | null = null;
async function burnTime(password: string): Promise<void> {
  dummyHash ??= hashPassword('verdict-dummy-password');
  await verifyPassword(password, await dummyHash);
}

export function passwordProblem(password: unknown, email?: string): string | null {
  if (typeof password !== 'string') return 'Enter a password';
  if (password.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters`;
  if (password.length > MAX_PASSWORD) return `Password cannot exceed ${MAX_PASSWORD} characters`;
  if (email && password.trim().toLowerCase() === email.toLowerCase()) return 'Password cannot be the same as your email';
  return null;
}

function normalizeEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null;
  const e = email.trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

function normalizeName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const n = name.trim().replace(/\s+/g, ' ');
  return n.length >= 1 && n.length <= 40 ? n : null;
}

// ---------- 账号 ----------

function userRow(id: string): UserRow | undefined {
  return db().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function userCount(): number {
  return (db().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

export function getUser(id: string): AuthUser | null {
  const row = userRow(id);
  return row ? toUser(row) : null;
}

export interface TeamMember extends AuthUser {
  status: 'active' | 'invited' | 'disabled';
  lastLoginAt: string | null;
  createdAt: string;
}

export function listMembers(merchantId: string): TeamMember[] {
  const rows = db().prepare("SELECT * FROM users WHERE merchant_id = ? ORDER BY role = 'owner' DESC, created_at").all(merchantId) as unknown as UserRow[];
  return rows.map((r) => ({
    ...toUser(r),
    status: r.disabled_at ? 'disabled' : r.password_hash ? 'active' : 'invited',
    lastLoginAt: r.last_login_at,
    createdAt: r.created_at,
  }));
}

/** 审计记录里显示的确认人。早期版本的动作记的是固定的演示账号。 */
export function actorLabel(id: string): string {
  if (id === 'demo-owner') return 'Owner (demo account from before sign-in existed)';
  const row = userRow(id);
  return row ? `${row.name} (${ROLE_LABEL[row.role]})` : id;
}

// ---------- 首次设置 ----------

// 第一个店主账号凭一次性设置码创建。设置码只写在数据目录和服务端日志里，不经过网页返回：
// 否则同一网络里的人，或者借 DNS 重绑定伪装成本机的网页，都能抢先注册店主。
function setupFile(): string {
  return path.join(dataDir(), 'setup-token');
}

/** 还没有任何账号时返回设置码（没有就生成），有账号后删除文件并返回 null。 */
export function setupToken(): string | null {
  const file = setupFile();
  if (userCount() > 0) {
    fs.rmSync(file, { force: true });
    return null;
  }
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // 没有文件，下面生成。
  }
  const token = randomToken();
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

export function checkSetupToken(token: unknown): boolean {
  if (typeof token !== 'string' || userCount() > 0) return false;
  const expected = setupToken();
  if (!expected) return false;
  const a = Buffer.from(sha256(token));
  const b = Buffer.from(sha256(expected));
  return crypto.timingSafeEqual(a, b);
}

export async function createFirstOwner(input: {
  token: unknown;
  merchantId: string;
  name: unknown;
  email: unknown;
  password: unknown;
}): Promise<AuthResult<{ user: AuthUser; sessionToken: string }>> {
  if (!checkSetupToken(input.token)) return fail(403, userCount() > 0 ? 'The owner account already exists. Sign in instead.' : 'Invalid setup code. Use the link printed in the server terminal.');
  const name = normalizeName(input.name);
  if (!name) return fail(400, 'Enter a name (up to 40 characters)');
  const email = normalizeEmail(input.email);
  if (!email) return fail(400, 'Invalid email format');
  const problem = passwordProblem(input.password, email);
  if (problem) return fail(400, problem);
  const hash = await hashPassword(input.password as string);
  const id = newId();
  const created = tx(() => {
    // 哈希期间可能有另一个请求先建好了，进事务后再查一次。
    if (userCount() > 0) return false;
    db()
      .prepare("INSERT INTO users (id, merchant_id, email, name, role, password_hash, created_at, last_login_at) VALUES (?, ?, ?, ?, 'owner', ?, ?, ?)")
      .run(id, input.merchantId, email, name, hash, nowIso(), nowIso());
    return true;
  });
  if (!created) return fail(409, 'The owner account already exists. Sign in instead.');
  fs.rmSync(setupFile(), { force: true });
  return { ok: true, user: getUser(id)!, sessionToken: createSession(id) };
}

// ---------- 登录与会话 ----------

export async function login(emailInput: unknown, password: unknown, now = Date.now()): Promise<AuthResult<{ user: AuthUser; sessionToken: string }>> {
  const email = normalizeEmail(emailInput);
  const pw = typeof password === 'string' ? password.slice(0, MAX_PASSWORD) : '';
  const row = email ? (db().prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined) : undefined;
  if (!row || !row.password_hash) {
    await burnTime(pw);
    return fail(401, 'Incorrect email or password');
  }
  if (row.locked_until && new Date(row.locked_until).getTime() > now) {
    const minutes = Math.ceil((new Date(row.locked_until).getTime() - now) / 60_000);
    return fail(429, `Too many failed attempts. Try again in ${minutes} min.`);
  }
  if (!(await verifyPassword(pw, row.password_hash))) {
    const failed = row.failed_logins + 1;
    if (failed >= MAX_FAILED_LOGINS) {
      db().prepare('UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?').run(new Date(now + LOCK_MS).toISOString(), row.id);
    } else {
      db().prepare('UPDATE users SET failed_logins = ? WHERE id = ?').run(failed, row.id);
    }
    return fail(401, 'Incorrect email or password');
  }
  // 停用的账号在密码正确之后才告诉对方，避免拿来探测账号状态。
  if (row.disabled_at) return fail(403, 'This account is disabled. Contact the owner.');
  db().prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(new Date(now).toISOString(), row.id);
  return { ok: true, user: toUser(row), sessionToken: createSession(row.id, now) };
}

export function createSession(userId: string, now = Date.now()): string {
  const token = randomToken();
  const at = new Date(now).toISOString();
  db()
    .prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(sha256(token), userId, at, at, new Date(now + SESSION_MAX_MS).toISOString());
  return token;
}

/** 会话最长 7 天，连续 12 小时没有操作也会失效。账号停用后立即失效。 */
export function sessionUser(token: string | null | undefined, now = Date.now()): AuthUser | null {
  if (!token || token.length > 100) return null;
  const hash = sha256(token);
  const row = db()
    .prepare(
      `SELECT s.last_seen_at, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    )
    .get(hash) as (UserRow & { last_seen_at: string; expires_at: string }) | undefined;
  if (!row) return null;
  const lastSeen = new Date(row.last_seen_at).getTime();
  if (row.disabled_at || new Date(row.expires_at).getTime() <= now || now - lastSeen > SESSION_IDLE_MS) {
    db().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return null;
  }
  if (now - lastSeen > TOUCH_INTERVAL_MS) {
    db().prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(new Date(now).toISOString(), hash);
  }
  return toUser(row);
}

export function destroySession(token: string | null | undefined): void {
  if (token) db().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function destroyUserSessions(userId: string, keepToken?: string): void {
  if (keepToken) db().prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, sha256(keepToken));
  else db().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// ---------- 设置密码链接（邀请与重置） ----------

/** 生成新链接时，这个账号之前没用过的链接一并作废。 */
export function issuePasswordLink(userId: string, purpose: 'invite' | 'reset', now = Date.now()): string {
  const token = randomToken();
  tx(() => {
    db().prepare('UPDATE password_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(new Date(now).toISOString(), userId);
    db()
      .prepare('INSERT INTO password_tokens (token_hash, user_id, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(sha256(token), userId, purpose, new Date(now).toISOString(), new Date(now + LINK_TTL_MS).toISOString());
  });
  return token;
}

interface LinkRow {
  user_id: string;
  purpose: 'invite' | 'reset';
  expires_at: string;
  used_at: string | null;
}

function liveLink(token: unknown, now: number): (LinkRow & { user: UserRow }) | null {
  if (typeof token !== 'string' || token.length > 100) return null;
  const link = db().prepare('SELECT * FROM password_tokens WHERE token_hash = ?').get(sha256(token)) as LinkRow | undefined;
  if (!link || link.used_at || new Date(link.expires_at).getTime() <= now) return null;
  const user = userRow(link.user_id);
  if (!user || user.disabled_at) return null;
  return { ...link, user };
}

/** 设置密码页显示用：只给名字、邮箱和角色。 */
export function peekPasswordLink(token: unknown, now = Date.now()): { name: string; email: string; role: Role; purpose: 'invite' | 'reset' } | null {
  const link = liveLink(token, now);
  return link ? { name: link.user.name, email: link.user.email, role: link.user.role, purpose: link.purpose } : null;
}

export async function setPasswordWithLink(token: unknown, password: unknown, now = Date.now()): Promise<AuthResult<{ user: AuthUser; sessionToken: string }>> {
  const link = liveLink(token, now);
  if (!link) return fail(410, 'This link has expired or was already used. Ask the owner for a new one.');
  const problem = passwordProblem(password, link.user.email);
  if (problem) return fail(400, problem);
  const hash = await hashPassword(password as string);
  const ok = tx(() => {
    const again = liveLink(token, now);
    if (!again) return false;
    db().prepare('UPDATE password_tokens SET used_at = ? WHERE token_hash = ?').run(new Date(now).toISOString(), sha256(token as string));
    db()
      .prepare('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?')
      .run(hash, new Date(now).toISOString(), link.user_id);
    // 重置密码说明旧密码可能泄漏了，已登录的设备全部下线。
    destroyUserSessions(link.user_id);
    return true;
  });
  if (!ok) return fail(410, 'This link has expired or was already used. Ask the owner for a new one.');
  return { ok: true, user: toUser(userRow(link.user_id)!), sessionToken: createSession(link.user_id, now) };
}

export async function changePassword(user: AuthUser, current: unknown, next: unknown, keepToken: string): Promise<AuthResult<object>> {
  const row = userRow(user.id);
  if (!row?.password_hash) return fail(401, 'Sign in again');
  if (typeof current !== 'string' || !(await verifyPassword(current.slice(0, MAX_PASSWORD), row.password_hash))) return fail(400, 'Current password is incorrect');
  const problem = passwordProblem(next, row.email);
  if (problem) return fail(400, problem);
  if (next === current) return fail(400, 'New password must differ from the current password');
  db().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(next as string), user.id);
  destroyUserSessions(user.id, keepToken);
  return { ok: true };
}

// ---------- 成员管理（仅店主） ----------

export function inviteMember(input: { merchantId: string; name: unknown; email: unknown; role: unknown }): AuthResult<{ user: AuthUser; token: string }> {
  const name = normalizeName(input.name);
  if (!name) return fail(400, 'Enter a name (up to 40 characters)');
  const email = normalizeEmail(input.email);
  if (!email) return fail(400, 'Invalid email format');
  if (input.role !== 'owner' && input.role !== 'agent') return fail(400, 'Role must be Owner or Agent');
  if (db().prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return fail(409, 'An account with this email already exists');
  const id = newId();
  db().prepare('INSERT INTO users (id, merchant_id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, input.merchantId, email, name, input.role, nowIso());
  return { ok: true, user: getUser(id)!, token: issuePasswordLink(id, 'invite') };
}

function activeOwners(merchantId: string): number {
  return (
    db().prepare("SELECT COUNT(*) AS n FROM users WHERE merchant_id = ? AND role = 'owner' AND disabled_at IS NULL AND password_hash IS NOT NULL").get(merchantId) as {
      n: number;
    }
  ).n;
}

export function setMemberDisabled(actor: AuthUser, targetId: string, disabled: boolean): AuthResult<{ member: TeamMember }> {
  const target = userRow(targetId);
  if (!target || target.merchant_id !== actor.merchantId) return fail(404, 'Member not found');
  if (target.id === actor.id) return fail(400, 'You cannot disable your own account');
  if (disabled && target.role === 'owner' && !target.disabled_at && target.password_hash && activeOwners(actor.merchantId) <= 1) {
    return fail(400, 'At least one active owner account is required');
  }
  tx(() => {
    db().prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(disabled ? nowIso() : null, target.id);
    if (disabled) {
      destroyUserSessions(target.id);
      db().prepare('UPDATE password_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(nowIso(), target.id);
    }
  });
  return { ok: true, member: listMembers(actor.merchantId).find((m) => m.id === target.id)! };
}

/** 重新生成设置密码链接：给还没设置密码的成员补发邀请，或给忘记密码的成员重置。 */
export function reissueLink(actor: AuthUser, targetId: string): AuthResult<{ token: string; purpose: 'invite' | 'reset' }> {
  const target = userRow(targetId);
  if (!target || target.merchant_id !== actor.merchantId) return fail(404, 'Member not found');
  if (target.disabled_at) return fail(400, 'This account is disabled. Enable it before generating a link.');
  if (target.id === actor.id) return fail(400, 'To change your own password, use "Change password"');
  const purpose = target.password_hash ? 'reset' : 'invite';
  return { ok: true, token: issuePasswordLink(target.id, purpose), purpose };
}
