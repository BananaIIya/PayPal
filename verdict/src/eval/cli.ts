// npm run eval 的入口。数据放在临时目录里，跑完删除，不会碰 .data/。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TRANSFORM_NAMES, type TransformName } from './transforms';

const USAGE = `用法：npm run eval -- [选项]

  --dataset <manifest.json>  用外部标注样本（格式见 README“评估集”）；不填用内置 18 个验收场景
  --transforms <列表>         形式变换，逗号分隔：${TRANSFORM_NAMES.join(',')}；all 为全部（默认），none 为不跑
  --live                     调用已配置的 LLM 和检测器（读 .env.local，会产生费用；每种变换都会再调用一遍）
  --out <目录>               报告输出目录，默认 eval-results/<时间>
  --help                     显示这段说明`;

interface Args {
  dataset?: string;
  transforms: TransformName[];
  live: boolean;
  out?: string;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { transforms: [...TRANSFORM_NAMES], live: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} 后面要跟一个值`);
      return v;
    };
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--live') args.live = true;
    else if (a === '--dataset') args.dataset = value();
    else if (a === '--out') args.out = value();
    else if (a === '--transforms') {
      const v = value();
      if (v === 'all') args.transforms = [...TRANSFORM_NAMES];
      else if (v === 'none') args.transforms = [];
      else {
        const names = v.split(',').map((s) => s.trim());
        const bad = names.filter((n) => !TRANSFORM_NAMES.includes(n as TransformName));
        if (bad.length) throw new Error(`不认识的变换：${bad.join('、')}`);
        args.transforms = names as TransformName[];
      }
    } else throw new Error(`不认识的参数：${a}`);
  }
  return args;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    return 1;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.live && fs.existsSync('.env.local')) process.loadEnvFile('.env.local');

  // 必须在载入任何服务端模块之前设置：数据库按这个目录打开。
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-eval-'));
  process.env.VERDICT_DATA_DIR = dataDir;
  try {
    const { runEvaluation } = await import('./run');
    const { renderReport } = await import('./report');
    const result = await runEvaluation({
      dataset: args.dataset,
      transforms: args.transforms,
      live: args.live,
      onProgress: (m) => console.log(`[eval] ${m}`),
    });
    const out = path.resolve(args.out ?? path.join('eval-results', stamp()));
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'report.md'), renderReport(result));
    fs.writeFileSync(path.join(out, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);

    const s = result.summaries.all;
    const p = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
    console.log('');
    console.log(`合法售后误判为中高风险：${p(s.legitFalsePositives.rate)}（${s.legitFalsePositives.count}/${s.legitFalsePositives.total}）`);
    console.log(`已确认滥用：精确率 ${p(s.abuse.precision)}，召回率 ${p(s.abuse.recall)}，PR-AUC ${s.abuse.prAuc === null ? '—' : s.abuse.prAuc.toFixed(2)}`);
    for (const t of result.robustness) console.log(`${t.text}：一致率 ${p(t.rate)}（${t.agree}/${t.applicable}）`);
    console.log(`报告：${path.join(out, 'report.md')}`);
    if (result.leaks.length) {
      console.error(`有 ${result.leaks.length} 组样本跨集合泄漏，分集合指标不可信，详见报告。`);
      return 2;
    }
    return 0;
  } catch (e) {
    console.error(`评估失败：${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
