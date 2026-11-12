// 索赔页 token：HMAC 签名，含过期时间与最大提交次数；已用次数存在服务端。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, db, newId } from './db';

function secret(): string {
  if (process.env.PORTAL_TOKEN_SECRET) return process.env.PORTAL_TOKEN_SECRET;
  const file = path.join(dataDir(), 'portal-secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8');
}

export interface PortalTokenPayload {
  jti: string;
  merchantId: string;
  orderId: string;
  claimId: string;
  exp: number;
  max: number;
}

function sign(body: string): string {
  return crypto.createHmac('sha256', secret()).update(body).digest('base64url');
}

export function issuePortalToken(
  input: { merchantId: string; orderId: string; claimId: string },
  opts: { ttlMs?: number; maxSubmissions?: number } = {},
): string {
  const payload: PortalTokenPayload = {
    jti: newId(),
    ...input,
    exp: Date.now() + (opts.ttlMs ?? 7 * 24 * 3600 * 1000),
    max: opts.maxSubmissions ?? 3,
  };
  db().prepare('INSERT INTO portal_tokens (id, claim_id, used) VALUES (?, ?, 0)').run(payload.jti, input.claimId);
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

export type TokenCheck =
  | { ok: true; payload: PortalTokenPayload; used: number }
  | { ok: false; status: 401 | 410; error: string };

export function checkPortalToken(token: string): TokenCheck {
  const [body, mac] = token.split('.');
  if (!body || !mac) return { ok: false, status: 401, error: 'Invalid link' };
  const expected = Buffer.from(sign(body));
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return { ok: false, status: 401, error: 'Invalid link' };
  }
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as PortalTokenPayload;
  if (Date.now() > payload.exp) return { ok: false, status: 410, error: 'This link has expired. Contact the merchant for a new one.' };
  const row = db().prepare('SELECT used FROM portal_tokens WHERE id = ?').get(payload.jti) as { used: number } | undefined;
  if (!row) return { ok: false, status: 401, error: 'Invalid link' };
  if (row.used >= payload.max) return { ok: false, status: 410, error: 'This link has no submissions left. Contact the merchant.' };
  return { ok: true, payload, used: row.used };
}

export function consumePortalToken(jti: string): void {
  db().prepare('UPDATE portal_tokens SET used = used + 1 WHERE id = ?').run(jti);
}
