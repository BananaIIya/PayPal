// 外部评估集：一个 manifest.json 加上它引用的图片和视频。格式见 README“评估集”。
// 样本按 manifest 里的顺序导入同一个库：后面的样本能查到前面样本的图片，跨订单套图检测和真实环境一样生效。
import fs from 'node:fs';
import path from 'node:path';
import type { ClaimOrigin, ClaimType } from '@/core/types';
import { wipeData } from '@/demo/seed';
import type { TrackingResult } from '@/providers/types';
import { db, newId } from '@/server/db';
import { createClaim } from '@/server/ingest';
import { parseOrderPush, pushOrder } from '@/server/order-push';
import { runAnalysis } from '@/server/pipeline';
import { addEvidence } from '@/server/repo';
import { hammingDistance, isInformativeHash, perceptualHash, REUSE_DISTANCE, sha256, sniffImageType, sniffVideoType } from '@/server/storage';
import { addVideoEvidence } from '@/server/video';
import type { Dataset, DatasetSample } from './dataset';
import { LABELS, type Label } from './metrics';
import { assignSplits, groupComponents, SPLITS, type Split } from './splits';

const MERCHANT_ID = 'eval-merchant';
const CLAIM_TYPES: ClaimType[] = ['not_received', 'damaged', 'not_as_described', 'missing_items', 'return'];
const ORIGINS: ClaimOrigin[] = ['paypal_dispute', 'portal', 'manual_import'];
const EVIDENCE_SOURCES = ['uploaded', 'live_capture', 'manual_import', 'paypal_dispute'] as const;
type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

interface FileRef {
  file: string;
  shot: string | null;
}

interface ManifestSample {
  id: string;
  label: Label;
  split: Split | null;
  note?: string;
  buyer: string | null;
  sku: string | null;
  claim: { type: ClaimType; origin: ClaimOrigin; narrative: string | null; createdAt?: string };
  order: Record<string, unknown>;
  tracking: TrackingResult | null;
  evidence: (FileRef & { source: EvidenceSource })[];
  references: FileRef[];
  messages: { sender: 'merchant' | 'buyer'; text: string; at?: string }[];
}

class ManifestError extends Error {}

function fail(where: string, msg: string): never {
  throw new ManifestError(`${where}：${msg}`);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const optStr = (v: unknown, where: string, field: string): string | null => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') fail(where, `${field} 要是字符串`);
  return v;
};

function fileRefs(v: unknown, where: string, field: string, dir: string): (FileRef & { source?: unknown })[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail(where, `${field} 要是数组`);
  return v.map((item, i) => {
    const at = `${where} ${field}[${i}]`;
    if (!isObj(item) || typeof item.file !== 'string' || !item.file) fail(at, '缺少 file');
    const file = path.resolve(dir, item.file);
    if (!fs.existsSync(file)) fail(at, `找不到文件 ${item.file}`);
    return { file, shot: optStr(item.shot, at, 'shot'), source: item.source };
  });
}

/** 读取并校验 manifest。错误信息带样本 id，方便定位。 */
export function parseManifest(manifestPath: string): { name: string; samples: ManifestSample[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    throw new ManifestError(`读不了 ${manifestPath}：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObj(raw) || !Array.isArray(raw.samples) || raw.samples.length === 0) throw new ManifestError('manifest 要有非空的 samples 数组');
  const dir = path.dirname(path.resolve(manifestPath));
  const seen = new Set<string>();
  const samples = raw.samples.map((s, i): ManifestSample => {
    const where = `samples[${i}]`;
    if (!isObj(s)) fail(where, '要是对象');
    if (typeof s.id !== 'string' || !s.id) fail(where, '缺少 id');
    const at = `样本 ${s.id}`;
    if (seen.has(s.id)) fail(at, 'id 重复');
    seen.add(s.id);
    if (!LABELS.includes(s.label as Label)) fail(at, `label 只能是 ${LABELS.join('、')}`);
    if (s.split !== undefined && !SPLITS.includes(s.split as Split)) fail(at, `split 只能是 ${SPLITS.join('、')}`);
    const claim = isObj(s.claim) ? s.claim : fail(at, '缺少 claim');
    if (!CLAIM_TYPES.includes(claim.type as ClaimType)) fail(at, `claim.type 只能是 ${CLAIM_TYPES.join('、')}`);
    if (claim.origin !== undefined && !ORIGINS.includes(claim.origin as ClaimOrigin)) fail(at, `claim.origin 只能是 ${ORIGINS.join('、')}`);
    const order: Record<string, unknown> = isObj(s.order) ? { orderNo: `EVAL-${i + 1}`, currency: 'USD', ...s.order } : fail(at, '缺少 order');
    try {
      parseOrderPush(order);
    } catch (e) {
      fail(at, `order 不合法：${e instanceof Error ? e.message : String(e)}`);
    }
    if (s.tracking !== undefined && (!isObj(s.tracking) || typeof s.tracking.status !== 'string' || !Array.isArray(s.tracking.events))) {
      fail(at, 'tracking 要有 status 和 events');
    }
    const evidence = fileRefs(s.evidence, at, 'evidence', dir).map((e, j) => {
      const source = e.source ?? 'uploaded';
      if (!EVIDENCE_SOURCES.includes(source as EvidenceSource)) fail(`${at} evidence[${j}]`, `source 只能是 ${EVIDENCE_SOURCES.join('、')}`);
      return { file: e.file, shot: e.shot, source: source as EvidenceSource };
    });
    const messages = s.messages === undefined ? [] : Array.isArray(s.messages) ? s.messages : fail(at, 'messages 要是数组');
    for (const m of messages) {
      if (!isObj(m) || (m.sender !== 'merchant' && m.sender !== 'buyer') || typeof m.text !== 'string') fail(at, 'messages 每条要有 sender（merchant 或 buyer）和 text');
    }
    const items = order.items as { sku?: unknown }[] | undefined;
    return {
      id: s.id,
      label: s.label as Label,
      split: (s.split as Split | undefined) ?? null,
      note: optStr(s.note, at, 'note') ?? undefined,
      buyer: optStr(s.buyer, at, 'buyer'),
      sku: typeof items?.[0]?.sku === 'string' ? items[0].sku : null,
      claim: {
        type: claim.type as ClaimType,
        origin: (claim.origin as ClaimOrigin | undefined) ?? 'portal',
        narrative: optStr(claim.narrative, at, 'claim.narrative'),
        createdAt: optStr(claim.createdAt, at, 'claim.createdAt') ?? undefined,
      },
      order,
      tracking: (s.tracking as TrackingResult | undefined) ?? null,
      evidence,
      references: fileRefs(s.references, at, 'references', dir).map(({ file, shot }) => ({ file, shot })),
      messages: messages as ManifestSample['messages'],
    };
  });
  return { name: typeof raw.name === 'string' && raw.name ? raw.name : path.basename(manifestPath), samples };
}

/** 买家图片按“同一张或近似”分组，判定标准和 Origin 分析器的跨订单复用检测相同。视频只按文件哈希。 */
async function imageGroups(samples: ManifestSample[]): Promise<Map<string, string[]>> {
  const images: { sample: string; key: string; sha: string; dhash: string | null }[] = [];
  for (const s of samples) {
    for (const [i, e] of s.evidence.entries()) {
      const buf = fs.readFileSync(e.file);
      let dhash: string | null = null;
      if (sniffImageType(buf)) dhash = await perceptualHash(buf).catch(() => null);
      images.push({ sample: s.id, key: `${s.id}#${i}`, sha: sha256(buf), dhash });
    }
  }
  const cluster = new Map<string, string>();
  for (const [i, a] of images.entries()) {
    if (cluster.has(a.key)) continue;
    cluster.set(a.key, a.key);
    for (const b of images.slice(i + 1)) {
      if (cluster.has(b.key)) continue;
      const near = a.dhash && b.dhash && isInformativeHash(a.dhash) && isInformativeHash(b.dhash) && hammingDistance(a.dhash, b.dhash) <= REUSE_DISTANCE;
      if (a.sha === b.sha || near) cluster.set(b.key, a.key);
    }
  }
  const out = new Map<string, string[]>();
  for (const img of images) out.set(img.sample, [...new Set([...(out.get(img.sample) ?? []), cluster.get(img.key)!])]);
  return out;
}

export async function manifestDataset(manifestPath: string): Promise<Dataset> {
  const { name, samples: parsed } = parseManifest(manifestPath);
  const groups = await imageGroups(parsed);
  const withGroups = parsed.map((s) => ({ ...s, groups: { images: groups.get(s.id) ?? [], buyer: s.buyer, sku: s.sku } }));

  // 没写 split 的样本：和已标集合的样本同组就跟着它，否则整组按哈希分配（约三成进调参集）。
  const auto = assignSplits(withGroups);
  const explicit = new Map(withGroups.filter((s) => s.split).map((s) => [s.id, s.split!]));
  const splitOf = new Map<string, Split>();
  for (const ids of groupComponents(withGroups)) {
    const fixed = ids.map((id) => explicit.get(id)).find(Boolean);
    for (const id of ids) splitOf.set(id, explicit.get(id) ?? fixed ?? auto.get(id)!);
  }

  const samples: DatasetSample[] = withGroups.map((s) => ({ id: s.id, label: s.label, split: splitOf.get(s.id)!, groups: s.groups, note: s.note }));
  const unsplit = parsed.filter((s) => !s.split).length;
  return {
    name,
    source: path.resolve(manifestPath),
    samples,
    notes: unsplit ? [`${unsplit} 个样本没有标 split，已按分组自动分配（同组同集合，约三成进调参集）。`] : [],
    async run({ transform, live }) {
      wipeData();
      db().prepare('INSERT INTO merchants (id, name, settings) VALUES (?, ?, ?)').run(MERCHANT_ID, '评估商家', '{}');
      const out = new Map<string, { claimId: string; analysisMs: number }>();
      for (const s of parsed) {
        const pushed = pushOrder(s.order);
        if (!pushed.ok) throw new ManifestError(`样本 ${s.id}：订单导入失败：${pushed.body.error}`);
        const orderId = pushed.body.orderId;
        if (s.tracking) {
          db()
            .prepare("UPDATE orders SET tracking_sim = ?, carrier = COALESCE(carrier, 'UPS'), tracking_number = COALESCE(tracking_number, ?) WHERE id = ?")
            .run(JSON.stringify(s.tracking), `EVAL-TRACK-${orderId.slice(0, 8)}`, orderId);
        }
        for (const r of s.references) {
          const buf = fs.readFileSync(r.file);
          const mime = sniffImageType(buf);
          if (!mime) throw new ManifestError(`样本 ${s.id}：留底 ${path.basename(r.file)} 不是 JPEG、PNG 或 WebP`);
          await addEvidence({ claimId: null, orderId, source: 'reference', file: buf, mime, shot: r.shot });
        }
        const claimId = createClaim({
          merchantId: MERCHANT_ID,
          orderId,
          origin: s.claim.origin,
          type: s.claim.type,
          narrative: s.claim.narrative,
          status: 'analyzing',
          createdAt: s.claim.createdAt,
        });
        for (const m of s.messages) {
          db()
            .prepare('INSERT INTO messages (id, order_id, sender, text, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(newId(), orderId, m.sender, m.text, m.at ?? new Date().toISOString());
        }
        for (const e of s.evidence) {
          let buf: Buffer = fs.readFileSync(e.file);
          const video = sniffVideoType(buf);
          if (video) {
            // 视频转码不在内置变换里，视频原样导入。
            await addVideoEvidence({ claimId, orderId, source: e.source, file: buf, mime: video, shot: e.shot });
            continue;
          }
          if (!sniffImageType(buf)) throw new ManifestError(`样本 ${s.id}：${path.basename(e.file)} 不是支持的图片或视频`);
          if (transform) buf = await transform(buf);
          await addEvidence({ claimId, orderId, source: e.source, file: buf, mime: sniffImageType(buf)!, shot: e.shot });
        }
        const started = performance.now();
        await runAnalysis(claimId, { offline: !live });
        out.set(s.id, { claimId, analysisMs: performance.now() - started });
      }
      return out;
    },
  };
}

export { ManifestError };
