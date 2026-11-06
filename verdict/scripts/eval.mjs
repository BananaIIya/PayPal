// 运行评估集：npm run eval -- [选项]，说明见 npm run eval -- --help。
// 源码是 TypeScript 并使用 @/ 路径别名，这里借 Vite 的模块运行器直接执行，不需要先编译。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, createServerModuleRunner } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, ws: false },
  resolve: { alias: { '@': path.join(root, 'src') } },
});
const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
let code = 1;
try {
  const cli = await runner.import(path.join(root, 'src/eval/cli.ts'));
  code = await cli.main(process.argv.slice(2));
} finally {
  await runner.close();
  await server.close();
}
process.exit(code);
