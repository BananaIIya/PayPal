// 首次访问时建表并生成演示数据，让 npm run dev 之后不需要任何额外步骤。
import { paypalConfig } from '@/paypal/config';
import { db } from './db';

const SYNC_INTERVAL_MS = 60_000;
const g = globalThis as unknown as { __verdictReady?: Promise<void>; __verdictSyncTimer?: NodeJS.Timeout };

/**
 * 每次都要检查，不能放进只跑一次的初始化里：
 * 用户可能在服务运行时才填好 .env.local，Next 会重新加载环境变量。
 */
function ensureSandboxSync(): void {
  if (g.__verdictSyncTimer || paypalConfig().state !== 'ready') return;
  const run = () =>
    ready()
      .then(() => import('./paypal-sync'))
      .then((m) => m.syncSandboxDisputes())
      .catch((e) => console.error('[verdict] PayPal 同步失败', e instanceof Error ? e.message : e));
  g.__verdictSyncTimer = setInterval(run, SYNC_INTERVAL_MS);
  g.__verdictSyncTimer.unref?.();
  void run();
}

export function ready(): Promise<void> {
  ensureSandboxSync();
  g.__verdictReady ??= (async () => {
    const row = db().prepare('SELECT COUNT(*) AS n FROM merchants').get() as { n: number };
    if (row.n === 0) {
      const { seedDemo } = await import('@/demo/seed');
      await seedDemo();
    }
  })().catch((e) => {
    g.__verdictReady = undefined;
    throw e;
  });
  return g.__verdictReady;
}

export const CURRENT_USER = { id: 'demo-owner', name: '店主（演示账号）', role: 'owner' as const };
