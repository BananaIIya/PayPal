import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: { alias: { '@': path.resolve(root, 'src') } },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 60000, hookTimeout: 120000, pool: 'forks' },
});
