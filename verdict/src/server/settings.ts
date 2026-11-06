// 商家设置（开发文档 GET/PUT /api/settings）：判定权重与阈值、类目策略、退货地址、证据保留期。
// 权重和类目策略会改变判定结果，所以保存后把未结案的索赔重新判定一次；已结案的保留当时的判定作为审计记录。
import { CATEGORY_LABEL, DEFAULT_CONFIG, isDefaultConfig, LAYER_WEIGHT_GROUPS, layerWeights, LEVEL_LABEL, STRENGTH_LABEL, type LayerGroup } from '@/core/catalog';
import type { EngineConfig, ReturnAddress, Strength } from '@/core/types';
import { purgeExpiredEvidence, type PurgeResult } from './data-retention';
import { db, tx } from './db';
import { recompute } from './pipeline';
import {
  addTimeline,
  DEMO_RETURN_ADDRESS,
  getPolicy,
  latestVerdict,
  merchantEngineConfig,
  merchantSettings,
  saveMerchantSettings,
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
  policies: (PolicySettings & { label: string; orders: number })[];
  /** 商家自己填的退货地址；没填时为 null，和解用演示地址。 */
  returnAddress: ReturnAddress | null;
  demoReturnAddress: ReturnAddress;
  retentionDays: number | null;
}

export interface SettingsInput {
  /** null 表示恢复默认。 */
  engine?: EngineSettings | null;
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
    throw new InvalidSettings(`${label}要在 ${min} 到 ${max} 之间${opts.exclusiveMin ? `，且不能等于 ${min}` : ''}`);
  }
  return Math.round(n * 100) / 100;
}

function parseEngine(input: EngineSettings): NonNullable<StoredSettings['engine']> {
  const strengthWeight = {} as Record<Strength, number>;
  for (const k of STRENGTHS) strengthWeight[k] = num(input.strengthWeight?.[k], `强度权重“${STRENGTH_LABEL[k]}”`, 0, 10);
  if (!(strengthWeight.strong >= strengthWeight.moderate && strengthWeight.moderate >= strengthWeight.weak)) {
    throw new InvalidSettings('强度权重要满足 强 ≥ 中 ≥ 弱');
  }
  const layerWeight = {} as Record<LayerGroup, number>;
  for (const g of GROUPS) layerWeight[g] = num(input.layerWeight?.[g], `证据层级权重“${LAYER_WEIGHT_GROUPS[g].label}”`, 0, 1);
  // 层级只表示默认可信度（开发文档“证据入口”），所以不允许低层证据比高层证据更可信。
  if (!(layerWeight.ab >= layerWeight.cPaypal && layerWeight.ab >= layerWeight.cUploaded && layerWeight.cPaypal >= layerWeight.d && layerWeight.cUploaded >= layerWeight.d)) {
    throw new InvalidSettings('证据层级权重要满足 A、B ≥ C ≥ D');
  }
  const riskMedium = num(input.riskMedium, '中风险阈值', 0, 20, { exclusiveMin: true });
  const riskHigh = num(input.riskHigh, '高风险阈值', 0, 20, { exclusiveMin: true });
  if (riskHigh <= riskMedium) throw new InvalidSettings('高风险阈值要大于中风险阈值');
  return {
    strengthWeight,
    layerWeight,
    riskMedium,
    riskHigh,
    minDataConfidence: num(input.minDataConfidence, '“Q 充足”阈值', 0, 1, { exclusiveMin: true }),
    merchantRiskHigh: num(input.merchantRiskHigh, '“M 高”阈值', 0, 1, { exclusiveMin: true }),
  };
}

function text(value: unknown, label: string, max: number, required: boolean): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (required && !s) throw new InvalidSettings(`请填写退货地址的${label}`);
  if (s.length > max) throw new InvalidSettings(`退货地址的${label}不能超过 ${max} 个字符`);
  return s;
}

function parseAddress(input: ReturnAddress): ReturnAddress {
  const countryCode = text(input.countryCode, '国家代码', 2, true).toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) throw new InvalidSettings('国家代码要用两位字母，比如 US、CN');
  const address: ReturnAddress = {
    line1: text(input.line1, '街道地址', 300, true),
    city: text(input.city, '城市', 120, true),
    // 美国、加拿大、中国的地址 PayPal 要求填州或省。
    state: text(input.state, '州/省', 300, ['US', 'CA', 'CN'].includes(countryCode)),
    postalCode: text(input.postalCode, '邮编', 60, true),
    countryCode,
  };
  const line2 = text(input.line2, '地址第二行', 300, false);
  return line2 ? { ...address, line2 } : address;
}

function parsePolicy(input: PolicySettings): PolicySettings {
  const category = typeof input.category === 'string' ? input.category.trim() : '';
  if (!/^[a-z0-9_-]{1,40}$/.test(category)) throw new InvalidSettings(`类目“${category}”的名称无效`);
  const flag = (v: unknown, label: string) => {
    if (typeof v !== 'boolean') throw new InvalidSettings(`类目“${category}”的“${label}”要选是或否`);
    return v;
  };
  return {
    category,
    returnable: flag(input.returnable, '可退货'),
    perishable: flag(input.perishable, '易腐'),
    safetySensitive: flag(input.safetySensitive, '涉及安全'),
    identityRequired: flag(input.identityRequired, '核对序列号'),
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
function recomputeOpenClaims(merchantId: string): { recomputed: number; changed: { claimId: string; from: string; to: string }[] } {
  const rows = db().prepare("SELECT id FROM claims WHERE merchant_id = ? AND status != 'closed'").all(merchantId) as unknown as { id: string }[];
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
      addTimeline(id, 'analysis', '判定设置修改后重新判定', `${from} → ${to}`);
    }
  }
  return { recomputed: rows.length, changed };
}

export function updateSettings(merchantId: string, input: SettingsInput): SettingsResult {
  let next: StoredSettings;
  let policies: PolicySettings[] = [];
  try {
    next = { ...merchantSettings(merchantId) };
    if (input.engine === null) delete next.engine;
    else if (input.engine !== undefined) next.engine = parseEngine(input.engine);
    if (input.returnAddress === null) delete next.returnAddress;
    else if (input.returnAddress !== undefined) next.returnAddress = parseAddress(input.returnAddress);
    if (input.retentionDays === null) delete next.retentionDays;
    else if (input.retentionDays !== undefined) {
      const days = num(input.retentionDays, '证据保留天数', 1, 3650);
      if (!Number.isInteger(days)) throw new InvalidSettings('证据保留天数要是整数');
      next.retentionDays = days;
    }
    if (input.policies !== undefined) {
      if (!Array.isArray(input.policies)) throw new InvalidSettings('类目策略格式不对');
      policies = input.policies.map(parsePolicy);
    }
  } catch (e) {
    if (e instanceof InvalidSettings) return { ok: false, error: e.message };
    throw e;
  }

  const beforeConfig = JSON.stringify(merchantEngineConfig(merchantId));
  const beforePolicies = JSON.stringify(listPolicies(merchantId));
  tx(() => {
    saveMerchantSettings(merchantId, next);
    savePolicies(merchantId, policies);
  });
  const judgmentChanged =
    JSON.stringify(merchantEngineConfig(merchantId)) !== beforeConfig || JSON.stringify(listPolicies(merchantId)) !== beforePolicies;
  const { recomputed, changed } = judgmentChanged ? recomputeOpenClaims(merchantId) : { recomputed: 0, changed: [] };
  const purged = input.retentionDays ? purgeExpiredEvidence(merchantId) : null;
  return { ok: true, view: settingsView(merchantId), recomputed, changed, purged };
}
