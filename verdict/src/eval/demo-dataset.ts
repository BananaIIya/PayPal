// 内置评估集：18 个验收场景，按开发文档的四类标注。
// 只有存在可核实的反证（物流、留底、序列号、记录）或当事人承认时才标“已确认滥用”，
// AI 痕迹、检测器概率、画面矛盾这类只能说明可疑的，标“疑似异常”。
import { resetDemo } from '@/demo/seed';
import type { Dataset, DatasetSample } from './dataset';
import type { Label } from './metrics';

const LABELS: Record<string, { label: Label; note: string }> = {
  genuine_damage: { label: 'legit', note: '现场拍摄，序列号和留底一致' },
  ai_watermark: { label: 'suspicious', note: '图片声明经 AI 生成或编辑，但也可能只是加了标注圈，没有反证' },
  reused_image: { label: 'confirmed_abuse', note: '同一张图已作为另一笔订单的证据提交过（历史证据反证）' },
  identity_mismatch: { label: 'confirmed_abuse', note: '序列号和发货留底不同（留底、序列号反证）' },
  cross_contradiction: { label: 'suspicious', note: '两张整体照的数量不一致，没有外部反证' },
  fake_chat: { label: 'confirmed_abuse', note: '截图里的客服回复在商家消息记录里不存在（记录反证）' },
  synthetic_no_watermark: { label: 'suspicious', note: '只有检测器概率偏高' },
  narrative_conflict: { label: 'suspicious', note: '陈述和画面冲突，可能是买家表述不准' },
  screen_recapture: { label: 'suspicious', note: '翻拍特征，没有反证' },
  delivered_not_received: { label: 'suspicious', note: '签收到订单地址，但签收不等于本人收到' },
  partial_missing: { label: 'suspicious', note: '称重和两件一致，但包装重量有误差' },
  insufficient: { label: 'insufficient', note: '只有一张相册近景' },
  seller_bad_tracking: { label: 'legit', note: '商家单号的签收邮编和买家地址不同' },
  batch_quality: { label: 'legit', note: '同批次已确认质量问题' },
  listing_changed: { label: 'legit', note: '商家在下单后改了描述' },
  perishable: { label: 'legit', note: '生鲜签收后很快变质' },
  prompt_injection: { label: 'legit', note: '照片真实，描述里夹带针对模型的指令' },
  detectors_down: { label: 'legit', note: '照片真实，但检测服务不可用' },
};

/** 套图场景用的就是“真实损坏”那张图，两者必须在同一个集合里。 */
const IMAGE_GROUP: Record<string, string> = { reused_image: 'genuine_damage' };

export function demoDataset(): Dataset {
  const samples: DatasetSample[] = Object.entries(LABELS).map(([id, { label, note }]) => ({
    id,
    label,
    // 这些场景就是规则和权重设计时对照的验收场景，属于调参集。
    split: 'tune',
    groups: { images: [IMAGE_GROUP[id] ?? id], buyer: id, sku: id },
    note,
  }));
  return {
    name: '内置验收场景',
    source: 'demo',
    samples,
    notes: [
      '内置样本就是规则和权重设计时对照的 18 个验收场景，属于调参集，指标会偏乐观，只能当回归基线。实际效果要用独立标注的测试集（--dataset）衡量。',
      '演示图片是程序生成的插画；LLM 和检测器的结果是录制回放。',
    ],
    async run(input) {
      if (input.live) throw new Error('内置样本的 LLM 和检测器结果是录制回放，不能用 --live 跑');
      const seeded = await resetDemo({ transform: input.transform });
      return new Map(seeded.map((c) => [c.key, { claimId: c.claimId, analysisMs: c.analysisMs }]));
    },
  };
}
