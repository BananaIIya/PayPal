// 账号与安全：首次设置、登录与锁定、会话过期、邀请与重置、角色限制、凭证加密、限流。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-auth-test-'));
process.env.VERDICT_DATA_DIR = dir;
process.env.DEMO_ANALYZER_DELAY_MS = '0';
for (const k of ['LLM_API_KEY', 'LLM_PROVIDER', 'PAYPAL_ENV', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID', 'APP_ENCRYPTION_KEY', 'TRUST_PROXY_HOPS']) delete process.env[k];

let auth: typeof import('@/server/auth');
let guard: typeof import('@/server/guard');
let secrets: typeof import('@/server/secrets');
let rate: typeof import('@/server/rate-limit');
let creds: typeof import('@/server/paypal-credentials');
let config: typeof import('@/paypal/config');
let actions: typeof import('@/server/actions');
let repo: typeof import('@/server/repo');
let db: typeof import('@/server/db');
let proxy: typeof import('@/proxy');
let merchantId: string;

const OWNER_PW = 'owner-pass-' + crypto.randomBytes(6).toString('hex');
const AGENT_PW = 'agent-pass-' + crypto.randomBytes(6).toString('hex');
const KEY_A = crypto.randomBytes(32).toString('hex');
const KEY_B = crypto.randomBytes(32).toString('hex');

beforeAll(async () => {
  const { seedDemo } = await import('@/demo/seed');
  auth = await import('@/server/auth');
  guard = await import('@/server/guard');
  secrets = await import('@/server/secrets');
  rate = await import('@/server/rate-limit');
  creds = await import('@/server/paypal-credentials');
  config = await import('@/paypal/config');
  actions = await import('@/server/actions');
  repo = await import('@/server/repo');
  db = await import('@/server/db');
  proxy = await import('@/proxy');
  await seedDemo();
  merchantId = repo.defaultMerchantId()!;
}, 120000);

afterAll(() => {
  delete process.env.APP_ENCRYPTION_KEY;
  fs.rmSync(dir, { recursive: true, force: true });
});

function request(url: string, opts: { cookie?: string; method?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { host: '127.0.0.1:3000', ...opts.headers };
  if (opts.cookie) headers.cookie = `verdict_session=${opts.cookie}`;
  return new NextRequest(`http://127.0.0.1:3000${url}`, { method: opts.method ?? 'GET', headers });
}

describe('密码', () => {
  it('scrypt 哈希可以验证，不同盐结果不同，错误密码不通过', async () => {
    const a = await auth.hashPassword('correct horse battery');
    const b = await auth.hashPassword('correct horse battery');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$131072$8$1$')).toBe(true);
    expect(await auth.verifyPassword('correct horse battery', a)).toBe(true);
    expect(await auth.verifyPassword('correct horse batterx', a)).toBe(false);
    expect(await auth.verifyPassword('x', 'garbage')).toBe(false);
  });

  it('密码规则：至少 10 位，不能和邮箱一样', () => {
    expect(auth.passwordProblem('short')).toContain('至少');
    expect(auth.passwordProblem('a@b.example', 'A@B.example')).toContain('邮箱');
    expect(auth.passwordProblem('long-enough-password')).toBeNull();
  });
});

describe('首次设置', () => {
  it('没有账号时生成设置码文件，设置码不对不能建店主', async () => {
    expect(auth.userCount()).toBe(0);
    const token = auth.setupToken()!;
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(fs.statSync(path.join(dir, 'setup-token')).mode & 0o777).toBe(0o600);
    expect(auth.setupToken()).toBe(token);
    const bad = await auth.createFirstOwner({ token: 'nope', merchantId, name: '店主', email: 'owner@example.test', password: OWNER_PW });
    expect(bad).toMatchObject({ ok: false, status: 403 });
    expect(auth.userCount()).toBe(0);
  });

  it('设置码正确时创建店主并登录；之后设置码作废，不能再建第二个', async () => {
    const token = auth.setupToken()!;
    const res = await auth.createFirstOwner({ token, merchantId, name: '店主小王', email: 'Owner@Example.test', password: OWNER_PW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.user).toMatchObject({ role: 'owner', email: 'owner@example.test' });
    expect(auth.sessionUser(res.sessionToken)?.id).toBe(res.user.id);
    expect(fs.existsSync(path.join(dir, 'setup-token'))).toBe(false);
    expect(auth.setupToken()).toBeNull();
    const again = await auth.createFirstOwner({ token, merchantId, name: 'x', email: 'x@example.test', password: OWNER_PW });
    expect(again).toMatchObject({ ok: false, status: 403 });
  });

  it('密码哈希入库，库里没有明文', () => {
    const row = db.db().prepare("SELECT password_hash FROM users WHERE email = 'owner@example.test'").get() as { password_hash: string };
    expect(row.password_hash).not.toContain(OWNER_PW);
    expect(JSON.stringify(db.db().prepare('SELECT * FROM users').all())).not.toContain(OWNER_PW);
  });
});

describe('登录与会话', () => {
  it('邮箱不存在和密码不对给同样的提示', async () => {
    const a = await auth.login('nobody@example.test', OWNER_PW);
    const b = await auth.login('owner@example.test', 'wrong-password-123');
    expect(a).toEqual({ ok: false, status: 401, error: '邮箱或密码不对' });
    expect(b).toEqual(a);
  });

  it('连续 5 次密码错误锁定 15 分钟，锁定期间正确密码也不行，过期后恢复', async () => {
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) expect((await auth.login('owner@example.test', `wrong-password-${i}`, t0)).ok).toBe(false);
    const locked = await auth.login('owner@example.test', OWNER_PW, t0 + 1000);
    expect(locked).toMatchObject({ ok: false, status: 429 });
    const after = await auth.login('owner@example.test', OWNER_PW, t0 + 16 * 60_000);
    expect(after.ok).toBe(true);
  });

  it('连续 12 小时没有操作会话失效；最长 7 天', async () => {
    const owner = (await auth.login('owner@example.test', OWNER_PW)) as { ok: true; sessionToken: string; user: { id: string } };
    const t0 = Date.now();
    const idle = auth.createSession(owner.user.id, t0);
    expect(auth.sessionUser(idle, t0 + 11 * 3600_000)).not.toBeNull();
    expect(auth.sessionUser(idle, t0 + 11 * 3600_000 + 13 * 3600_000)).toBeNull();
    const active = auth.createSession(owner.user.id, t0);
    // 每 10 小时用一次，不会因为空闲失效，但 7 天后仍然到期。
    for (let h = 10; h < 7 * 24; h += 10) expect(auth.sessionUser(active, t0 + h * 3600_000)).not.toBeNull();
    expect(auth.sessionUser(active, t0 + 7 * 24 * 3600_000 + 1)).toBeNull();
  });

  it('退出后会话失效', async () => {
    const res = (await auth.login('owner@example.test', OWNER_PW)) as { ok: true; sessionToken: string };
    auth.destroySession(res.sessionToken);
    expect(auth.sessionUser(res.sessionToken)).toBeNull();
    expect(auth.sessionUser('not-a-token')).toBeNull();
  });
});

describe('成员：邀请、停用、重置', () => {
  let owner: import('@/server/auth').AuthUser;
  let agentId: string;

  beforeAll(async () => {
    owner = ((await auth.login('owner@example.test', OWNER_PW)) as { ok: true; user: import('@/server/auth').AuthUser }).user;
  });

  it('邀请客服：链接只能用一次，用后直接登录', async () => {
    const res = auth.inviteMember({ merchantId, name: '客服小李', email: 'agent@example.test', role: 'agent' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    agentId = res.user.id;
    expect(auth.listMembers(merchantId).find((m) => m.id === agentId)?.status).toBe('invited');
    expect(auth.peekPasswordLink(res.token)).toMatchObject({ email: 'agent@example.test', role: 'agent', purpose: 'invite' });
    expect((await auth.login('agent@example.test', AGENT_PW)).ok).toBe(false);
    const set = await auth.setPasswordWithLink(res.token, AGENT_PW);
    expect(set.ok).toBe(true);
    expect((await auth.setPasswordWithLink(res.token, AGENT_PW)).ok).toBe(false);
    expect(auth.peekPasswordLink(res.token)).toBeNull();
    expect((await auth.login('agent@example.test', AGENT_PW)).ok).toBe(true);
  });

  it('同一邮箱不能重复添加；链接 72 小时后失效', async () => {
    expect(auth.inviteMember({ merchantId, name: 'x', email: 'AGENT@example.test', role: 'agent' })).toMatchObject({ ok: false, status: 409 });
    const res = auth.inviteMember({ merchantId, name: '临时', email: 'temp@example.test', role: 'agent' });
    if (!res.ok) throw new Error(res.error);
    expect((await auth.setPasswordWithLink(res.token, AGENT_PW, Date.now() + 73 * 3600_000)).ok).toBe(false);
  });

  it('停用后所有登录立即失效，再登录提示已停用；启用后恢复', async () => {
    const s = (await auth.login('agent@example.test', AGENT_PW)) as { ok: true; sessionToken: string };
    expect(auth.setMemberDisabled(owner, agentId, true).ok).toBe(true);
    expect(auth.sessionUser(s.sessionToken)).toBeNull();
    expect(await auth.login('agent@example.test', AGENT_PW)).toMatchObject({ ok: false, status: 403 });
    expect(auth.setMemberDisabled(owner, agentId, false).ok).toBe(true);
    expect((await auth.login('agent@example.test', AGENT_PW)).ok).toBe(true);
  });

  it('不能停用自己，也不能停用最后一个可用的店主', () => {
    expect(auth.setMemberDisabled(owner, owner.id, true)).toMatchObject({ ok: false, status: 400 });
    const agent = auth.getUser(agentId)!;
    expect(auth.setMemberDisabled(agent, owner.id, true)).toMatchObject({ ok: false, status: 400 });
  });

  it('重置密码：链接用掉之前旧密码仍可用，用掉后旧密码和旧会话都失效', async () => {
    const old = (await auth.login('agent@example.test', AGENT_PW)) as { ok: true; sessionToken: string };
    const link = auth.reissueLink(owner, agentId);
    expect(link).toMatchObject({ ok: true, purpose: 'reset' });
    if (!link.ok) return;
    expect((await auth.login('agent@example.test', AGENT_PW)).ok).toBe(true);
    const NEW_PW = AGENT_PW + '-new';
    expect((await auth.setPasswordWithLink(link.token, NEW_PW)).ok).toBe(true);
    expect(auth.sessionUser(old.sessionToken)).toBeNull();
    expect((await auth.login('agent@example.test', AGENT_PW)).ok).toBe(false);
    expect((await auth.login('agent@example.test', NEW_PW)).ok).toBe(true);
    // 改回去，后面的测试接着用。
    const back = auth.reissueLink(owner, agentId);
    if (back.ok) await auth.setPasswordWithLink(back.token, AGENT_PW);
  });

  it('修改自己的密码：当前密码要对；其他设备下线，当前这台保留', async () => {
    const here = (await auth.login('agent@example.test', AGENT_PW)) as { ok: true; sessionToken: string; user: import('@/server/auth').AuthUser };
    const other = (await auth.login('agent@example.test', AGENT_PW)) as { ok: true; sessionToken: string };
    expect(await auth.changePassword(here.user, 'wrong-current-pw', AGENT_PW + 'x', here.sessionToken)).toMatchObject({ ok: false, status: 400 });
    expect((await auth.changePassword(here.user, AGENT_PW, AGENT_PW + 'x', here.sessionToken)).ok).toBe(true);
    expect(auth.sessionUser(here.sessionToken)).not.toBeNull();
    expect(auth.sessionUser(other.sessionToken)).toBeNull();
    expect((await auth.changePassword(here.user, AGENT_PW + 'x', AGENT_PW, here.sessionToken)).ok).toBe(true);
  });

  it('审计记录里显示名字和角色', () => {
    expect(auth.actorLabel(agentId)).toBe('客服小李（客服）');
    expect(auth.actorLabel('demo-owner')).toContain('演示账号');
  });

  it('演示重置不清账号', async () => {
    const before = auth.userCount();
    const { resetDemo } = await import('@/demo/seed');
    await resetDemo();
    expect(auth.userCount()).toBe(before);
    expect((await auth.login('owner@example.test', OWNER_PW)).ok).toBe(true);
  }, 120000);
});

describe('接口与页面的登录校验', () => {
  let ownerToken: string;
  let agentToken: string;

  beforeAll(async () => {
    ownerToken = ((await auth.login('owner@example.test', OWNER_PW)) as { ok: true; sessionToken: string }).sessionToken;
    agentToken = ((await auth.login('agent@example.test', AGENT_PW)) as { ok: true; sessionToken: string }).sessionToken;
  });

  it('没登录 401，客服做店主的事 403，跨站写请求 403', async () => {
    const none = guard.authorize(request('/api/claims'));
    expect(none).toBeInstanceOf(Response);
    expect((none as Response).status).toBe(401);
    expect(guard.authorize(request('/api/claims', { cookie: ownerToken }))).toMatchObject({ role: 'owner' });
    const denied = guard.authorize(request('/api/settings', { cookie: agentToken, method: 'PUT' }), { write: true, owner: true, ownerReason: '只有店主' });
    expect((denied as Response).status).toBe(403);
    expect(await (denied as Response).json()).toEqual({ error: '只有店主' });
    const cross = guard.authorize(request('/api/claims', { cookie: ownerToken, method: 'POST', headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } }), { write: true });
    expect((cross as Response).status).toBe(403);
  });

  it('proxy：公开路径放行；没有 cookie 的页面跳登录页并带上原地址，接口返回 401', () => {
    for (const p of ['/login', '/setup', '/invite/abc', '/c/abc', '/api/portal/abc', '/api/auth/login', '/webhooks/paypal', '/api/orders']) {
      expect(proxy.proxy(request(p)).headers.get('location'), p).toBeNull();
      expect(proxy.proxy(request(p)).status, p).toBe(200);
    }
    const page = proxy.proxy(request('/claims/abc?x=1'));
    expect(page.status).toBe(307);
    expect(new URL(page.headers.get('location')!).searchParams.get('next')).toBe('/claims/abc?x=1');
    expect(proxy.proxy(request('/api/orders/abc/weight', { method: 'POST' })).status).toBe(401);
    expect(proxy.proxy(request('/api/settings', { cookie: 'anything' })).status).toBe(200);
  });

  it('登录后的跳转地址只接受站内路径', () => {
    expect(guard.safeNext('/claims/1')).toBe('/claims/1');
    expect(guard.safeNext('//evil.example')).toBe('/claims');
    expect(guard.safeNext('/\\evil.example')).toBe('/claims');
    expect(guard.safeNext('https://evil.example')).toBe('/claims');
    expect(guard.safeNext('/login')).toBe('/claims');
  });
});

describe('资金动作只有店主能确认', () => {
  const agent = { id: 'agent-x', role: 'agent' as const };
  const base = { claimId: 'missing', verdictId: 'v', confirm: true, idempotencyKey: 'k', origin: 'http://127.0.0.1:3000', payload: {} };

  it.each(['refund', 'accept_claim', 'make_offer', 'acknowledge_return_item'] as const)('客服执行 %s 返回 403', async (type) => {
    const out = await actions.executeAction({ ...base, idempotencyKey: crypto.randomUUID(), type, actor: agent });
    expect(out.status).toBe(403);
  });

  it('客服可以发消息、交证据、升级、申诉（这里因为索赔不存在返回 404，不是 403）', async () => {
    for (const type of ['send_message', 'provide_evidence', 'escalate', 'appeal', 'provide_supporting_info'] as const) {
      expect((await actions.executeAction({ ...base, idempotencyKey: crypto.randomUUID(), type, actor: agent })).status).toBe(404);
    }
  });

  it('结果不明的资金动作，客服不能核对，店主可以', () => {
    const claim = repo.listClaims().find((c) => c.level)!;
    const verdict = repo.latestVerdict(claim.id)!;
    const actionId = crypto.randomUUID();
    db.db()
      .prepare(
        "INSERT INTO actions (id, claim_id, verdict_id, type, payload, confirmed_by, confirmed_at, paypal_request_id, status) VALUES (?, ?, ?, 'refund', '{}', 'x', ?, ?, 'unknown')",
      )
      .run(actionId, claim.id, verdict.id, new Date().toISOString(), crypto.randomUUID());
    expect(actions.resolveAction({ claimId: claim.id, actionId, outcome: 'failed', confirm: true, actor: agent }).status).toBe(403);
    expect(actions.resolveAction({ claimId: claim.id, actionId, outcome: 'failed', confirm: true, actor: { id: 'o', role: 'owner' } }).status).toBe(200);
  });
});

describe('凭证加密', () => {
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY_A;
  });

  it('AES-GCM 加解密；换密钥、改密文、挪到别的商家都解不开', () => {
    const enc = secrets.encryptSecret('top-secret-value', 'aad-1');
    expect(enc.startsWith('v1.')).toBe(true);
    expect(enc).not.toContain('top-secret');
    expect(secrets.encryptSecret('top-secret-value', 'aad-1')).not.toBe(enc);
    expect(secrets.decryptSecret(enc, 'aad-1')).toBe('top-secret-value');
    expect(() => secrets.decryptSecret(enc, 'aad-2')).toThrow(secrets.EncryptionKeyError);
    const parts = enc.split('.');
    const flipped = Buffer.from(parts[3], 'base64url');
    flipped[0] ^= 1;
    expect(() => secrets.decryptSecret([parts[0], parts[1], parts[2], flipped.toString('base64url')].join('.'), 'aad-1')).toThrow();
    process.env.APP_ENCRYPTION_KEY = KEY_B;
    expect(() => secrets.decryptSecret(enc, 'aad-1')).toThrow(secrets.EncryptionKeyError);
  });

  it('密钥格式不对或没配置时说明原因', () => {
    process.env.APP_ENCRYPTION_KEY = 'too-short';
    expect(secrets.encryptionKeyState()).toMatchObject({ configured: false });
    expect(secrets.encryptionKeyState().error).toContain('32 字节');
    delete process.env.APP_ENCRYPTION_KEY;
    expect(secrets.encryptionKeyState()).toEqual({ configured: false, error: null });
  });

  it('保存 PayPal 凭证：先验证，失败不入库；成功后加密存储，接口不返回 secret', async () => {
    const owner = auth.getUser((db.db().prepare("SELECT id FROM users WHERE email = 'owner@example.test'").get() as { id: string }).id)!;
    const clientId = 'A' + crypto.randomBytes(20).toString('hex');
    const secret = 'E' + crypto.randomBytes(20).toString('hex');

    delete process.env.APP_ENCRYPTION_KEY;
    expect(await creds.savePayPalCredentials(owner, { clientId, clientSecret: secret }, async () => ({ ok: true }))).toMatchObject({ ok: false, status: 400 });

    process.env.APP_ENCRYPTION_KEY = KEY_A;
    const rejected = await creds.savePayPalCredentials(owner, { clientId, clientSecret: secret }, async () => ({ ok: false, status: 400, error: 'PayPal 拒绝了这组凭证' }));
    expect(rejected).toMatchObject({ ok: false, status: 400 });
    expect(db.db().prepare('SELECT COUNT(*) AS n FROM paypal_credentials').get()).toEqual({ n: 0 });

    let verified: [string, string] | null = null;
    const saved = await creds.savePayPalCredentials(owner, { clientId, clientSecret: secret, webhookId: 'WH-123' }, async (id, s) => {
      verified = [id, s];
      return { ok: true };
    });
    expect(saved.ok).toBe(true);
    expect(verified).toEqual([clientId, secret]);
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(JSON.stringify(db.db().prepare('SELECT * FROM paypal_credentials').all())).not.toContain(secret);
    if (saved.ok) expect(saved.view).toMatchObject({ source: 'database', stored: { clientIdTail: clientId.slice(-4), webhookId: 'WH-123' } });

    const cfg = config.paypalConfig();
    expect(cfg).toMatchObject({ state: 'ready', source: 'database', clientId, clientSecret: secret, webhookId: 'WH-123' });
    expect(JSON.stringify(config.publicPayPalStatus())).not.toContain(secret);

    // 换了密钥就解不开，状态变成配置有误，不会拿乱码去调 PayPal。
    process.env.APP_ENCRYPTION_KEY = KEY_B;
    expect(config.paypalConfig()).toMatchObject({ state: 'invalid', source: 'database' });

    // 删除后退回环境变量；环境变量也没有时回到模拟器。
    process.env.PAYPAL_ENV = 'sandbox';
    process.env.PAYPAL_CLIENT_ID = 'env-client-id-0000000000';
    process.env.PAYPAL_CLIENT_SECRET = 'env-secret-000000000000000';
    expect(creds.deletePayPalCredentials(merchantId)).toMatchObject({ source: 'env', stored: null });
    for (const k of ['PAYPAL_ENV', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET']) delete process.env[k];
    expect(config.paypalConfig()).toEqual({ state: 'off' });
  });

  it('格式不对的凭证直接拒绝，不去调 PayPal', async () => {
    const owner = auth.getUser((db.db().prepare("SELECT id FROM users WHERE email = 'owner@example.test'").get() as { id: string }).id)!;
    let called = false;
    const verify = async () => {
      called = true;
      return { ok: true as const };
    };
    expect(await creds.savePayPalCredentials(owner, { clientId: 'short', clientSecret: 'x'.repeat(30) }, verify)).toMatchObject({ ok: false, status: 400 });
    expect(await creds.savePayPalCredentials(owner, { clientId: 'A'.repeat(30), clientSecret: 'bad secret with spaces!!' }, verify)).toMatchObject({ ok: false });
    expect(called).toBe(false);
  });
});

describe('限流', () => {
  beforeEach(() => rate.resetRateLimits());

  it('滑动窗口：超出后返回需要等待的秒数，窗口过去后恢复', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) expect(rate.hit('k', 3, 60_000, t0 + i).ok).toBe(true);
    const blocked = rate.hit('k', 3, 60_000, t0 + 10);
    expect(blocked).toEqual({ ok: false, retryAfter: 60 });
    expect(rate.hit('k', 3, 60_000, t0 + 60_001).ok).toBe(true);
  });

  it('索赔页按 token 限流：同一个 token 提交过多返回 429，换个 token 不受影响', async () => {
    const r = (ip: string) => request('/api/portal/t/submit', { method: 'POST', headers: { 'x-forwarded-for': ip } });
    for (let i = 0; i < 5; i++) expect(rate.limitPortal(r(`10.0.0.${i}`), 'token-a', 'submit')).toBeNull();
    const limited = rate.limitPortal(r('10.0.0.99'), 'token-a', 'submit')!;
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await limited.json()).error).toContain('太频繁');
    expect(rate.limitPortal(r('10.0.0.100'), 'token-b', 'submit')).toBeNull();
  });

  it('索赔页按 IP 限流：同一个 IP 换着 token 刷也会被挡住', () => {
    const r = request('/api/portal/t/submit', { method: 'POST', headers: { 'x-forwarded-for': '10.1.1.1' } });
    for (let i = 0; i < 10; i++) expect(rate.limitPortal(r, `token-${i}`, 'submit')).toBeNull();
    expect(rate.limitPortal(r, 'token-new', 'submit')?.status).toBe(429);
  });

  it('客户端 IP：默认取 X-Forwarded-For 最后一段；TRUST_PROXY_HOPS 按代理层数取', () => {
    const r = request('/x', { headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' } });
    expect(rate.clientIp(r)).toBe('3.3.3.3');
    process.env.TRUST_PROXY_HOPS = '2';
    expect(rate.clientIp(r)).toBe('2.2.2.2');
    delete process.env.TRUST_PROXY_HOPS;
    expect(rate.clientIp(request('/x'))).toBe('unknown');
  });
});
