import { PayPalApiError, type PayPalClient, type PayPalEnv } from './client';
import { getSandboxClient, type PayPalSandbox } from './sandbox';
import { PayPalSimulator } from './simulator';

export function requireSandbox(): PayPalSandbox {
  const client = getSandboxClient();
  if (!client) throw new PayPalApiError('PayPal 沙箱未配置或配置有误，请查看设置页。');
  return client;
}

/** 按订单所属环境选客户端。沙箱订单在没有配置时直接报错，不会退回到模拟器。 */
export function clientForEnv(env: PayPalEnv): PayPalClient {
  return env === 'sandbox' ? requireSandbox() : new PayPalSimulator();
}
