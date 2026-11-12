// A fresh rehearsal environment: never load the merchant's persistent data or credentials.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const production = process.argv.includes('--production');
const port = process.env.DEMO_PORT || '3000';
if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) {
  console.error('DEMO_PORT must be an integer between 1024 and 65535.');
  process.exit(1);
}
if (production && !existsSync(path.join(root, '.next', 'BUILD_ID'))) {
  console.error('Run npm run build before npm run demo -- --production.');
  process.exit(1);
}
const dataDir = mkdtempSync(path.join(tmpdir(), 'verdict-demo-'));
const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), production ? 'start' : 'dev', '-H', '127.0.0.1', '-p', port], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    VERDICT_DATA_DIR: dataDir,
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    PAYPAL_ENV: '',
    PAYPAL_CLIENT_ID: '',
    PAYPAL_CLIENT_SECRET: '',
    PAYPAL_WEBHOOK_ID: '',
    APP_ENCRYPTION_KEY: '',
    LLM_PROVIDER: '',
    LLM_API_KEY: '',
    PORTAL_TOKEN_SECRET: '',
    VERDICT_API_KEY: '',
  },
});
console.log(`[demo] Fresh offline practice data: ${dataDir}`);
console.log(`[demo] Open http://127.0.0.1:${port}; then use the setup link printed by the server.`);
console.log('[demo] PayPal calls are simulated; prepared visual observations are replayed. Restart for a clean demo.');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => {
  console.error(`[demo] Could not start Next.js: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1); });
