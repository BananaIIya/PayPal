// 店主在设置页保存 PayPal 沙箱凭证。secret 加密后存库，任何接口都不返回明文，Client ID 只露尾号。
import { envPayPalConfig, credentialAad, paypalConfig } from '@/paypal/config';
import { SANDBOX_API_BASE } from '@/paypal/sandbox';
import { actorLabel, type AuthUser } from './auth';
import { db, nowIso } from './db';
import { encryptSecret, encryptionKeyState } from './secrets';

const CREDENTIAL = /^[A-Za-z0-9_-]{20,128}$/;
const WEBHOOK_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface PayPalCredentialView {
  /** 当前生效的来源。 */
  source: 'database' | 'env' | 'none';
  stored: { clientIdTail: string; webhookId: string | null; updatedAt: string; updatedBy: string } | null;
  envConfigured: boolean;
  encryption: { configured: boolean; error: string | null };
  /** 生效配置有误时的说明。 */
  error: string | null;
}

interface Row {
  client_id: string;
  webhook_id: string | null;
  updated_at: string;
  updated_by: string;
}

function storedRow(merchantId: string): Row | undefined {
  return db().prepare('SELECT client_id, webhook_id, updated_at, updated_by FROM paypal_credentials WHERE merchant_id = ?').get(merchantId) as Row | undefined;
}

export function paypalCredentialView(merchantId: string): PayPalCredentialView {
  const row = storedRow(merchantId);
  const active = paypalConfig();
  return {
    source: active.state === 'off' ? 'none' : active.source,
    stored: row
      ? { clientIdTail: row.client_id.slice(-4), webhookId: row.webhook_id, updatedAt: row.updated_at, updatedBy: actorLabel(row.updated_by) }
      : null,
    envConfigured: envPayPalConfig().state !== 'off',
    encryption: encryptionKeyState(),
    error: active.state === 'invalid' ? active.error : null,
  };
}

export type VerifyResult = { ok: true } | { ok: false; status: number; error: string };
export type Verifier = (clientId: string, clientSecret: string) => Promise<VerifyResult>;

/** 保存前先向 PayPal 沙箱换一次令牌，填错的凭证不入库。 */
export const verifyWithPayPal: Verifier = async (clientId, clientSecret) => {
  let res: Response;
  try {
    res = await fetch(`${SANDBOX_API_BASE}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return { ok: false, status: 502, error: `连不上 PayPal 沙箱，凭证没有保存：${e instanceof Error ? e.message : String(e)}` };
  }
  if (res.status === 400 || res.status === 401) return { ok: false, status: 400, error: 'PayPal 拒绝了这组凭证。请确认是沙箱应用（Sandbox）的 Client ID 和 Secret。' };
  if (!res.ok) return { ok: false, status: 502, error: `PayPal 沙箱返回 HTTP ${res.status}，凭证没有保存，请稍后再试` };
  return { ok: true };
};

export async function savePayPalCredentials(
  actor: AuthUser,
  input: { clientId?: unknown; clientSecret?: unknown; webhookId?: unknown },
  verify: Verifier = verifyWithPayPal,
): Promise<{ ok: true; view: PayPalCredentialView } | { ok: false; status: number; error: string }> {
  const enc = encryptionKeyState();
  if (!enc.configured) return { ok: false, status: 400, error: enc.error ?? '服务端没有配置 APP_ENCRYPTION_KEY，不能保存凭证。' };
  const clientId = typeof input.clientId === 'string' ? input.clientId.trim() : '';
  const clientSecret = typeof input.clientSecret === 'string' ? input.clientSecret.trim() : '';
  const webhookId = typeof input.webhookId === 'string' && input.webhookId.trim() ? input.webhookId.trim() : null;
  if (!CREDENTIAL.test(clientId)) return { ok: false, status: 400, error: 'Client ID 格式不对' };
  if (!CREDENTIAL.test(clientSecret)) return { ok: false, status: 400, error: 'Secret 格式不对' };
  if (webhookId && !WEBHOOK_ID.test(webhookId)) return { ok: false, status: 400, error: 'Webhook ID 格式不对' };

  const checked = await verify(clientId, clientSecret);
  if (!checked.ok) return checked;

  const secretEnc = encryptSecret(clientSecret, credentialAad(actor.merchantId));
  db()
    .prepare(
      `INSERT INTO paypal_credentials (merchant_id, env, client_id, secret_enc, webhook_id, updated_by, updated_at)
       VALUES (?, 'sandbox', ?, ?, ?, ?, ?)
       ON CONFLICT(merchant_id) DO UPDATE SET client_id = excluded.client_id, secret_enc = excluded.secret_enc,
         webhook_id = excluded.webhook_id, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .run(actor.merchantId, clientId, secretEnc, webhookId, actor.id, nowIso());
  return { ok: true, view: paypalCredentialView(actor.merchantId) };
}

/** 删除后退回环境变量里的配置；环境变量也没有时回到模拟器。 */
export function deletePayPalCredentials(merchantId: string): PayPalCredentialView {
  db().prepare('DELETE FROM paypal_credentials WHERE merchant_id = ?').run(merchantId);
  return paypalCredentialView(merchantId);
}
