// PayPal 沙箱配置。全部来自环境变量，secret 只在服务端使用，不写日志、不发给前端。
export type PayPalConfig =
  | { state: 'off' }
  | { state: 'invalid'; error: string }
  | { state: 'ready'; clientId: string; clientSecret: string; webhookId: string | null };

export function paypalConfig(): PayPalConfig {
  const env = process.env.PAYPAL_ENV?.trim();
  const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();
  const webhookId = process.env.PAYPAL_WEBHOOK_ID?.trim() || null;

  if (!env && !clientId && !clientSecret) return { state: 'off' };
  if (env === 'live') {
    return { state: 'invalid', error: 'PAYPAL_ENV=live 不受支持：这个版本只对接沙箱，不会动用真实资金。' };
  }
  if (env !== 'sandbox') return { state: 'invalid', error: 'PAYPAL_ENV 必须设为 sandbox。' };
  if (!clientId || !clientSecret) return { state: 'invalid', error: '缺少 PAYPAL_CLIENT_ID 或 PAYPAL_CLIENT_SECRET。' };
  return { state: 'ready', clientId, clientSecret, webhookId };
}

/** 可以给前端看的状态：不含 secret，Client ID 只露尾号。 */
export function publicPayPalStatus() {
  const cfg = paypalConfig();
  if (cfg.state === 'ready') {
    return { state: 'ready' as const, clientIdTail: cfg.clientId.slice(-4), webhookConfigured: !!cfg.webhookId, error: null };
  }
  return { state: cfg.state, clientIdTail: null, webhookConfigured: false, error: cfg.state === 'invalid' ? cfg.error : null };
}
