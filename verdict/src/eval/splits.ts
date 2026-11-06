// 样本隔离（开发文档“同一张图、同一买家、同一 SKU 的样本只出现在训练、调参、测试中的一个集合里”）。
// 共享任意一个分组键的样本连成一组，整组只能落在一个集合里。
import crypto from 'node:crypto';

export const SPLITS = ['tune', 'test'] as const;
export type Split = (typeof SPLITS)[number];
export const SPLIT_TEXT: Record<Split, string> = { tune: '调参集', test: '测试集' };

export interface GroupKeys {
  /** 图片分组：同一张图或近似图（重新压缩、裁剪后）用同一个键。 */
  images: string[];
  buyer?: string | null;
  sku?: string | null;
}

/** 按共享的分组键把样本连成组（并查集）。返回每组的样本 id，组内和组间都按 id 排序。 */
export function groupComponents(samples: { id: string; groups: GroupKeys }[]): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const s of samples) parent.set(`id:${s.id}`, `id:${s.id}`);
  for (const s of samples) {
    const keys = [...s.groups.images.map((i) => `img:${i}`), s.groups.buyer ? `buyer:${s.groups.buyer}` : null, s.groups.sku ? `sku:${s.groups.sku}` : null];
    for (const k of keys) {
      if (!k) continue;
      if (!parent.has(k)) parent.set(k, k);
      union(`id:${s.id}`, k);
    }
  }
  const groups = new Map<string, string[]>();
  for (const s of samples) {
    const root = find(`id:${s.id}`);
    groups.set(root, [...(groups.get(root) ?? []), s.id]);
  }
  return [...groups.values()].map((g) => g.sort()).sort((a, b) => a[0].localeCompare(b[0]));
}

/** 同一组的样本被标到了不同集合。 */
export function findLeaks(samples: { id: string; groups: GroupKeys; split: Split }[]): { ids: string[]; splits: Split[] }[] {
  const splitOf = new Map(samples.map((s) => [s.id, s.split]));
  return groupComponents(samples)
    .map((ids) => ({ ids, splits: [...new Set(ids.map((id) => splitOf.get(id)!))].sort() }))
    .filter((g) => g.splits.length > 1);
}

/** 没有标集合的样本按组分配：组内第一个 id 的哈希决定整组去向，结果稳定，和样本顺序无关。 */
export function assignSplits(samples: { id: string; groups: GroupKeys }[], tuneFraction = 0.3): Map<string, Split> {
  const out = new Map<string, Split>();
  for (const ids of groupComponents(samples)) {
    const h = crypto.createHash('sha256').update(ids[0]).digest().readUInt32BE(0) / 2 ** 32;
    const split: Split = h < tuneFraction ? 'tune' : 'test';
    for (const id of ids) out.set(id, split);
  }
  return out;
}
