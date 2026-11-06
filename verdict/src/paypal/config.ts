// PayPal 沙箱配置。优先用店主在设置页保存的凭证（secret 以 AES-256-GCM 加密存库），
// 没有时退回环境变量。secret 只在服务端使用，不写日志、不发给前端。
import { db } from '@/server/db';
import { decryptSecret } from '@/server/secrets';

export type PayPalSource = 'database' | 'env';

export type PayPalConfig =
  | { state: 'off' }
  | { state: 'invalid'; error: string; source: PayPalSource }
  | { state: 'ready'; clientId: string; clientSecret: string; webhookId: string | null; source: PayPalSource };

/** 密文绑定到商家和字段，挪到别的行会解密失败。 */
export function credentialAad(merchantId: string): string {
  return `paypal_credentials:${merchantId}:client_secret`;
}

interface CredentialRow {
  merchant_id: string;
  client_id: string;
  secret_enc: string;
  webhook_id: string | null;
  updated_at: string;
}

// 每次调用都会走到这里（ready()、取客户端），解密结果按“行内容 + 密钥”缓存。
let memo: { key: string; cfg: PayPalConfig } | null = null;

function storedConfig(): PayPalConfig | null {
  // MVP 只有一个商家。
  const row = db().prepare('SELECT merchant_id, client_id, secret_enc, webhook_id, updated_at FROM paypal_credentials ORDER BY updated_at DESC LIMIT 1').get() as
    | CredentialRow
    | undefined;
  if (!row) return null;
  const key = [row.merchant_id, row.client_id, row.secret_enc, row.webhook_id ?? '', process.env.APP_ENCRYPTION_KEY ?? ''].join('\n');
  if (memo?.key === key) return memo.cfg;
  let cfg: PayPalConfig;
  try {
    const clientSecret = decryptSecret(row.secret_enc, credentialAad(row.merchant_id));
    cfg = { state: 'ready', clientId: row.client_id, clientSecret, webhookId: row.webhook_id, source: 'database' };
  } catch (e) {
    cfg = { state: 'invalid', source: 'database', error: `设置页保存的 PayPal 凭证无法解密：${e instanceof Error ? e.message : String(e)}` };
  }
  memo = { key, cfg };
  return cfg;
}

export function envPayPalConfig(): PayPalConfig {
  const env = process.env.PAYPAL_ENV?.trim();
  const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();
  const webhookId = process.env.PAYPAL_WEBHOOK_ID?.trim() || null;

  if (!env && !clientId && !clientSecret) return { state: 'off' };
  if (env === 'live') {
    return { state: 'invalid', source: 'env', error: 'PAYPAL_ENV=live 不受支持：这个版本只对接沙箱，不会动用真实资金。' };
  }
  if (env !== 'sandbox') return { state: 'invalid', source: 'env', error: 'PAYPAL_ENV 必须设为 sandbox。' };
  if (!clientId || !clientSecret) return { state: 'invalid', source: 'env', error: '缺少 PAYPAL_CLIENT_ID 或 PAYPAL_CLIENT_SECRET。' };
  return { state: 'ready', clientId, clientSecret, webhookId, source: 'env' };
}

export function paypalConfig(): PayPalConfig {
  return storedConfig() ?? envPayPalConfig();
}

/** 可以给前端看的状态：不含 secret，Client ID 只露尾号。 */
export function publicPayPalStatus() {
  const cfg = paypalConfig();
  if (cfg.state === 'ready') {
    return { state: 'ready' as const, source: cfg.source, clientIdTail: cfg.clientId.slice(-4), webhookConfigured: !!cfg.webhookId, error: null };
  }
  return {
    state: cfg.state,
    source: cfg.state === 'off' ? null : cfg.source,
    clientIdTail: null,
    webhookConfigured: false,
    error: cfg.state === 'invalid' ? cfg.error : null,
  };
}
