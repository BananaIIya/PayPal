// 商家设置（开发文档 GET/PUT /api/settings）：判定权重与阈值（可按类目单独配置）、类目策略、影子模式、退货地址、证据保留期。
// 权重和类目策略会改变判定结果，所以保存后把未结案的索赔重新判定一次；已结案的保留当时的判定作为审计记录。
import { CATEGORY_LABEL, DEFAULT_CONFIG, isDefaultConfig, LAYER_WEIGHT_GROUPS, layerWeights, LEVEL_LABEL, STRENGTH_LABEL, type LayerGroup } from '@/core/catalog';
import type { EngineConfig, ReturnAddress, Strength } from '@/core/types';
import { purgeExpiredEvidence, type PurgeResult } from './data-retention';
import { db, tx } from './db';
import { recompute } from './pipeline';
import {
  addTimeline,
  DEMO_RETURN_ADDRESS,
  engineConfigFor,
  getPolicy,
  latestVerdict,
  merchantEngineConfig,
  merchantSettings,
  saveMerchantSettings,
  type StoredEngine,
  type StoredSettings,
} from './repo';

export interface EngineSettings {
  strengthWeight: Record<Strength, number>;
  layerWeight: Record<LayerGroup, number>;
  riskMedium: number;
  riskHigh: number;
  minDataConfidence: number;
  merchantRiskHigh: number;
}

export interface PolicySettings {
  category: string;
  returnable: boolean;
  perishable: boolean;
  safetySensitive: boolean;
  identityRequired: boolean;
}

export interface SettingsView {
  engine: EngineSettings;
  customized: boolean;
  defaults: EngineSettings;
  /** 有专用权重与阈值的类目。没列出的类目用 engine。 */
  categoryEngine: { category: string; label: string; engine: EngineSettings }[];
  shadowMode: boolean;
  policies: (PolicySettings & { label: string; orders: number })[];
  /** 商家自己填的退货地址；没填时为 null，和解用演示地址。 */
  returnAddress: ReturnAddress | null;
  demoReturnAddress: ReturnAddress;
  retentionDays: number | null;
}

export interface SettingsInput {
  /** null 表示恢复默认。 */
  engine?: EngineSettings | null;
  /** 某个类目的专用配置；engine 为 null 表示删掉，改回商家默认。 */
  categoryEngine?: { category: string; engine: EngineSettings | null };
  shadowMode?: boolean;
  policies?: PolicySettings[];
  returnAddress?: ReturnAddress | null;
  retentionDays?: number | null;
}

export type SettingsResult =
  | {
      ok: true;
      view: SettingsView;
      recomputed: number;
      changed: { claimId: string; from: string; to: string }[];
      /** 改了保留期时立即执行一次删除的结果。 */
      purged: PurgeResult | null;
    }
  | { ok: false; error: string };

const STRENGTHS: Strength[] = ['strong', 'moderate', 'weak'];
const CATEGORY_RE = /^[a-z0-9_-]{1,40}$/;
const MAX_CATEGORY_ENGINES = 50;
const GROUPS = Object.keys(LAYER_WEIGHT_GROUPS) as LayerGroup[];

function toEngineSettings(cfg: EngineConfig): EngineSettings {
  return {
    strengthWeight: { ...cfg.strengthWeight },
    layerWeight: layerWeights(cfg),
    riskMedium: cfg.riskMedium,
    riskHigh: cfg.riskHigh,
    minDataConfidence: cfg.minDataConfidence,
    merchantRiskHigh: cfg.merchantRiskHigh,
  };
}

function listPolicies(merchantId: string): SettingsView['policies'] {
  const saved = db().prepare('SELECT category FROM category_policies WHERE merchant_id = ?').all(merchantId) as unknown as { category: string }[];
  const counts = db()
    .prepare('SELECT category, COUNT(*) AS n FROM orders WHERE merchant_id = ? GROUP BY category')
    .all(merchantId) as unknown as { category: string; n: number }[];
  const orders = new Map(counts.map((c) => [c.category, c.n]));
  const categories = [...new Set([...saved.map((r) => r.category), ...orders.keys()])].sort();
  return categories.map((category) => {
    const p = getPolicy(merchantId, category);
    return {
      category,
      label: CATEGORY_LABEL[category] ?? category,
      returnable: p.returnable,
      perishable: p.perishable,
      safetySensitive: p.safetySensitive,
      identityRequired: p.identityRequired,
      orders: orders.get(category) ?? 0,
    };
  });
}

export function settingsView(merchantId: string): SettingsView {
  const stored = merchantSettings(merchantId);
  const cfg = merchantEngineConfig(merchantId);
  return {
    engine: toEngineSettings(cfg),
    customized: !isDefaultConfig(cfg),
    defaults: toEngineSettings(DEFAULT_CONFIG),
    categoryEngine: Object.keys(stored.categoryEngine ?? {})
      .sort()
      .map((category) => ({ category, label: CATEGORY_LABEL[category] ?? category, engine: toEngineSettings(engineConfigFor(merchantId, category)) })),
    shadowMode: stored.shadowMode === true,
    policies: listPolicies(merchantId),
    returnAddress: stored.returnAddress ?? null,
    demoReturnAddress: DEMO_RETURN_ADDRESS,
    retentionDays: stored.retentionDays ?? null,
  };
}

class InvalidSettings extends Error {}

function num(value: unknown, label: string, min: number, max: number, opts: { exclusiveMin?: boolean } = {}): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  const tooLow = opts.exclusiveMin ? n <= min : n < min;
  if (!Number.isFinite(n) || tooLow || n > max) {
    throw new InvalidSettings(`${label} must be between ${min} and ${max}${opts.exclusiveMin ? `, and cannot equal ${min}` : ''}`);
  }
  return Math.round(n * 100) / 100;
}

function parseEngine(input: EngineSettings): StoredEngine {
  const strengthWeight = {} as Record<Strength, number>;
  for (const k of STRENGTHS) strengthWeight[k] = num(input.strengthWeight?.[k], `Strength weight "${STRENGTH_LABEL[k]}"`, 0, 10);
  if (!(strengthWeight.strong >= strengthWeight.moderate && strengthWeight.moderate >= strengthWeight.weak)) {
    throw new InvalidSettings('Strength weights must satisfy strong ≥ moderate ≥ weak');
  }
  const layerWeight = {} as Record<LayerGroup, number>;
  for (const g of GROUPS) layerWeight[g] = num(input.layerWeight?.[g], `Evidence tier weight "${LAYER_WEIGHT_GROUPS[g].label}"`, 0, 1);
  // 层级只表示默认可信度（开发文档“证据入口”），所以不允许低层证据比高层证据更可信。
  if (!(layerWeight.ab >= layerWeight.cPaypal && layerWeight.ab >= layerWeight.cUploaded && layerWeight.cPaypal >= layerWeight.d && layerWeight.cUploaded >= layerWeight.d)) {
    throw new InvalidSettings('Evidence tier weights must satisfy A, B ≥ C ≥ D');
  }
  const riskMedium = num(input.riskMedium, 'Medium risk threshold', 0, 20, { exclusiveMin: true });
  const riskHigh = num(input.riskHigh, 'High risk threshold', 0, 20, { exclusiveMin: true });
  if (riskHigh <= riskMedium) throw new InvalidSettings('High risk threshold must be greater than the Medium risk threshold');
  return {
    strengthWeight,
    layerWeight,
    riskMedium,
    riskHigh,
    minDataConfidence: num(input.minDataConfidence, '"Q sufficient" threshold', 0, 1, { exclusiveMin: true }),
    merchantRiskHigh: num(input.merchantRiskHigh, '"M high" threshold', 0, 1, { exclusiveMin: true }),
  };
}

function text(value: unknown, label: string, max: number, required: boolean): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (required && !s) throw new InvalidSettings(`Enter the return address ${label}`);
  if (s.length > max) throw new InvalidSettings(`Return address ${label} cannot exceed ${max} characters`);
  return s;
}

function parseAddress(input: ReturnAddress): ReturnAddress {
  const countryCode = text(input.countryCode, 'country code', 2, true).toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) throw new InvalidSettings('Country code must be two letters, e.g. US, CN');
  const address: ReturnAddress = {
    line1: text(input.line1, 'street address', 300, true),
    city: text(input.city, 'city', 120, true),
    // 美国、加拿大、中国的地址 PayPal 要求填州或省。
    state: text(input.state, 'state/province', 300, ['US', 'CA', 'CN'].includes(countryCode)),
    postalCode: text(input.postalCode, 'postal code', 60, true),
    countryCode,
  };
  const line2 = text(input.line2, 'address line 2', 300, false);
  return line2 ? { ...address, line2 } : address;
}

function parsePolicy(input: PolicySettings): PolicySettings {
  const category = typeof input.category === 'string' ? input.category.trim() : '';
  if (!CATEGORY_RE.test(category)) throw new InvalidSettings(`Category name "${category}" is invalid`);
  const flag = (v: unknown, label: string) => {
    if (typeof v !== 'boolean') throw new InvalidSettings(`"${label}" for category "${category}" must be yes or no`);
    return v;
  };
  return {
    category,
    returnable: flag(input.returnable, 'Returnable'),
    perishable: flag(input.perishable, 'Perishable'),
    safetySensitive: flag(input.safetySensitive, 'Safety-sensitive'),
    identityRequired: flag(input.identityRequired, 'Check serial number'),
  };
}

function savePolicies(merchantId: string, policies: PolicySettings[]): void {
  const conn = db();
  for (const p of policies) {
    // 只改四个开关，保留已有的必需镜头配置。
    conn
      .prepare(
        `INSERT INTO category_policies (merchant_id, category, returnable, perishable, safety_sensitive, identity_required, required_shots)
         VALUES (?, ?, ?, ?, ?, ?, '{}')
         ON CONFLICT(merchant_id, category) DO UPDATE SET
           returnable = excluded.returnable, perishable = excluded.perishable,
           safety_sensitive = excluded.safety_sensitive, identity_required = excluded.identity_required`,
      )
      .run(merchantId, p.category, p.returnable ? 1 : 0, p.perishable ? 1 : 0, p.safetySensitive ? 1 : 0, p.identityRequired ? 1 : 0);
  }
}

/** 判定输入变了的未结案索赔重新判定，判定等级变化的写进时间线。 */
function recomputeOpenClaims(merchantId: string, category: string | null): { recomputed: number; changed: { claimId: string; from: string; to: string }[] } {
  const rows = (
    category
      ? db()
          .prepare("SELECT c.id FROM claims c JOIN orders o ON o.id = c.order_id WHERE c.merchant_id = ? AND c.status != 'closed' AND o.category = ?")
          .all(merchantId, category)
      : db().prepare("SELECT id FROM claims WHERE merchant_id = ? AND status != 'closed'").all(merchantId)
  ) as unknown as { id: string }[];
  const changed: { claimId: string; from: string; to: string }[] = [];
  for (const { id } of rows) {
    const before = latestVerdict(id);
    recompute(id);
    const after = latestVerdict(id);
    if (!after || before?.id === after.id) continue;
    if (before && before.level !== after.level) {
      const from = LEVEL_LABEL[before.level];
      const to = LEVEL_LABEL[after.level];
      changed.push({ claimId: id, from, to });
      addTimeline(id, 'analysis', 'Re-evaluated after verdict settings change', `${from} → ${to}`);
    }
  }
  return { recomputed: rows.length, changed };
}

/** 会影响判定的全部输入：商家默认配置、每个类目实际用的配置、类目策略。 */
function judgmentSnapshot(merchantId: string): string {
  const policies = listPolicies(merchantId);
  const categories = [...new Set([...policies.map((p) => p.category), ...Object.keys(merchantSettings(merchantId).categoryEngine ?? {})])].sort();
  return JSON.stringify({
    base: merchantEngineConfig(merchantId),
    categories: categories.map((c) => engineConfigFor(merchantId, c)),
    policies,
  });
}

export function updateSettings(merchantId: string, input: SettingsInput): SettingsResult {
  let next: StoredSettings;
  let policies: PolicySettings[] = [];
  try {
    next = { ...merchantSettings(merchantId) };
    if (input.engine === null) delete next.engine;
    else if (input.engine !== undefined) next.engine = parseEngine(input.engine);
    if (input.categoryEngine !== undefined) {
      const { category, engine } = input.categoryEngine ?? ({} as { category?: unknown; engine?: unknown });
      if (typeof category !== 'string' || !CATEGORY_RE.test(category)) throw new InvalidSettings('Invalid category name');
      const own = { ...next.categoryEngine };
      if (engine === null) delete own[category];
      else {
        if (!engine || typeof engine !== 'object') throw new InvalidSettings('Invalid category-specific config format');
        own[category] = parseEngine(engine as EngineSettings);
      }
      if (Object.keys(own).length > MAX_CATEGORY_ENGINES) throw new InvalidSettings(`At most ${MAX_CATEGORY_ENGINES} categories can have their own config`);
      if (Object.keys(own).length > 0) next.categoryEngine = own;
      else delete next.categoryEngine;
    }
    if (input.shadowMode !== undefined) {
      if (typeof input.shadowMode !== 'boolean') throw new InvalidSettings('Shadow mode must be on or off');
      if (input.shadowMode) next.shadowMode = true;
      else delete next.shadowMode;
    }
    if (input.returnAddress === null) delete next.returnAddress;
    else if (input.returnAddress !== undefined) next.returnAddress = parseAddress(input.returnAddress);
    if (input.retentionDays === null) delete next.retentionDays;
    else if (input.retentionDays !== undefined) {
      const days = num(input.retentionDays, 'Evidence retention days', 1, 3650);
      if (!Number.isInteger(days)) throw new InvalidSettings('Evidence retention days must be a whole number');
      next.retentionDays = days;
    }
    if (input.policies !== undefined) {
      if (!Array.isArray(input.policies)) throw new InvalidSettings('Invalid category policy format');
      policies = input.policies.map(parsePolicy);
    }
  } catch (e) {
    if (e instanceof InvalidSettings) return { ok: false, error: e.message };
    throw e;
  }

  const before = judgmentSnapshot(merchantId);
  tx(() => {
    saveMerchantSettings(merchantId, next);
    savePolicies(merchantId, policies);
  });
  const judgmentChanged = judgmentSnapshot(merchantId) !== before;
  // 只改了某个类目的专用配置时，只有这个类目的索赔受影响。
  const onlyCategory = input.categoryEngine && input.engine === undefined && input.policies === undefined ? input.categoryEngine.category : null;
  const { recomputed, changed } = judgmentChanged ? recomputeOpenClaims(merchantId, onlyCategory) : { recomputed: 0, changed: [] };
  const purged = input.retentionDays ? purgeExpiredEvidence(merchantId) : null;
  return { ok: true, view: settingsView(merchantId), recomputed, changed, purged };
}
