// 首次访问时建表并生成演示数据，让 npm run dev 之后不需要任何额外步骤。
import { paypalConfig } from '@/paypal/config';
import { setupToken } from './auth';
import { db } from './db';

const SYNC_INTERVAL_MS = 60_000;
const g = globalThis as unknown as { __verdictReady?: Promise<void>; __verdictSyncTimer?: NodeJS.Timeout; __verdictSetupLogged?: boolean };

/**
 * 还没有任何账号时，把创建店主用的一次性链接打印到服务端终端。
 * 链接不经过网页返回，只有能看到终端或数据目录的人才拿得到。
 */
function logSetupLink(): void {
  if (g.__verdictSetupLogged || process.env.VITEST) return;
  const token = setupToken();
  if (!token) return;
  g.__verdictSetupLogged = true;
  const base = process.env.PUBLIC_URL?.replace(/\/+$/, '') || `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  console.log(`\n[verdict] No console account yet. Open this link to create the owner account (run npm run account-link to see it again):\n[verdict] ${base}/setup?token=${token}\n`);
}

/**
 * 每次都要检查，不能放进只跑一次的初始化里：
 * 用户可能在服务运行时才填好 .env.local，Next 会重新加载环境变量。
 */
function ensureSandboxSync(): void {
  if (g.__verdictSyncTimer || paypalConfig().state !== 'ready') return;
  // 凭证可能在运行中被删掉（设置页），这时跳过，不要每分钟报一次错。
  const run = () =>
    ready()
      .then(() => (paypalConfig().state === 'ready' ? import('./paypal-sync').then((m) => m.syncSandboxDisputes()) : null))
      .catch((e) => console.error('[verdict] PayPal sync failed', e instanceof Error ? e.message : e));
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
    logSetupLink();
  })().catch((e) => {
    g.__verdictReady = undefined;
    throw e;
  });
  // 证据保留期：每次请求都检查，purgeIfDue 自己限制一小时最多执行一次。
  void g.__verdictReady
    .then(() => import('./data-retention'))
    .then((m) => m.purgeIfDue())
    .catch((e) => console.error('[verdict] Retention check failed', e instanceof Error ? e.message : e));
  return g.__verdictReady;
}
