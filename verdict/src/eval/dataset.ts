import type { Label } from './metrics';
import type { GroupKeys, Split } from './splits';

export interface DatasetSample {
  id: string;
  label: Label;
  split: Split;
  groups: GroupKeys;
  /** 为什么这样标注。 */
  note?: string;
}

export interface RunInput {
  /** 对每张买家图片做的形式变换；不填是原样。 */
  transform?: (buf: Buffer) => Promise<Buffer>;
  /** 允许调用已配置的 LLM 和检测器（会产生费用）。不开时只用录制回放和本地分析器。 */
  live: boolean;
}

export interface Dataset {
  name: string;
  source: string;
  samples: DatasetSample[];
  notes: string[];
  /** 在清空的库里导入全部样本并跑完核验管线，返回样本 id → 索赔 id 和管线耗时。 */
  run(input: RunInput): Promise<Map<string, { claimId: string; analysisMs: number }>>;
}
