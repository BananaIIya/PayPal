'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { LAYER_WEIGHT_GROUPS, STRENGTH_LABEL, type LayerGroup } from '@/core/catalog';
import type { ReturnAddress, Strength } from '@/core/types';
import type { EngineSettings, PolicySettings, SettingsInput, SettingsView } from '@/server/settings';

type Section = 'engine' | 'policies' | 'address' | 'retention' | 'shadow';
interface SaveState {
  busy: boolean;
  error: string | null;
  done: string | null;
  changed: { claimId: string; from: string; to: string }[];
}
const IDLE: SaveState = { busy: false, error: null, done: null, changed: [] };

const STRENGTHS: Strength[] = ['strong', 'moderate', 'weak'];
const GROUPS = Object.keys(LAYER_WEIGHT_GROUPS) as LayerGroup[];
const POLICY_FLAG_LABEL = { returnable: '可退货', perishable: '易腐', safetySensitive: '涉及安全', identityRequired: '核对序列号' } as const;
const EMPTY_ADDRESS: ReturnAddress = { line1: '', line2: '', city: '', state: '', postalCode: '', countryCode: 'US' };

/** 数字输入框里允许暂时是空串或半个小数，提交时由服务端校验。 */
type Draft<T> = { [K in keyof T]: T[K] extends number ? string : T[K] extends object ? Draft<T[K]> : T[K] };

function toDraft(e: EngineSettings): Draft<EngineSettings> {
  const s = (n: number) => String(n);
  return {
    strengthWeight: { strong: s(e.strengthWeight.strong), moderate: s(e.strengthWeight.moderate), weak: s(e.strengthWeight.weak) },
    layerWeight: { ab: s(e.layerWeight.ab), cPaypal: s(e.layerWeight.cPaypal), cUploaded: s(e.layerWeight.cUploaded), d: s(e.layerWeight.d) },
    riskMedium: s(e.riskMedium),
    riskHigh: s(e.riskHigh),
    minDataConfidence: s(e.minDataConfidence),
    merchantRiskHigh: s(e.merchantRiskHigh),
  };
}

function fromDraft(d: Draft<EngineSettings>): EngineSettings {
  const n = (v: string) => (v.trim() === '' ? NaN : Number(v));
  return {
    strengthWeight: { strong: n(d.strengthWeight.strong), moderate: n(d.strengthWeight.moderate), weak: n(d.strengthWeight.weak) },
    layerWeight: { ab: n(d.layerWeight.ab), cPaypal: n(d.layerWeight.cPaypal), cUploaded: n(d.layerWeight.cUploaded), d: n(d.layerWeight.d) },
    riskMedium: n(d.riskMedium),
    riskHigh: n(d.riskHigh),
    minDataConfidence: n(d.minDataConfidence),
    merchantRiskHigh: n(d.merchantRiskHigh),
  };
}

/** 全部类目用空串表示。 */
const ALL = '';

function engineFor(view: SettingsView, scope: string): { engine: EngineSettings; own: boolean } {
  if (scope === ALL) return { engine: view.engine, own: view.customized };
  const own = view.categoryEngine.find((c) => c.category === scope);
  return own ? { engine: own.engine, own: true } : { engine: view.engine, own: false };
}

function NumberField(p: { label: string; value: string; onChange: (v: string) => void; step?: string; hint?: string }) {
  return (
    <label className="field" style={{ marginBottom: 8 }}>
      {p.label}
      <input type="number" inputMode="decimal" step={p.step ?? '0.1'} value={p.value} onChange={(e) => p.onChange(e.target.value)} />
      {p.hint && <span className="muted small">{p.hint}</span>}
    </label>
  );
}

function Result({ state }: { state: SaveState }) {
  if (state.error) return <p className="notice notice-danger" role="alert">{state.error}</p>;
  if (!state.done) return null;
  return (
    <div className="notice notice-info" role="status">
      {state.done}
      {state.changed.length > 0 && (
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {state.changed.map((c) => (
            <li key={c.claimId}>
              <Link href={`/claims/${c.claimId}`}>{c.from} → {c.to}</Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** readOnly：客服可以看，不能改。服务端同样只允许店主保存。 */
export function SettingsForm({ initial, readOnly = false }: { initial: SettingsView; readOnly?: boolean }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [scope, setScope] = useState(ALL);
  const [engine, setEngine] = useState(() => toDraft(initial.engine));
  const [policies, setPolicies] = useState<PolicySettings[]>(initial.policies);
  const [address, setAddress] = useState<ReturnAddress>(initial.returnAddress ?? EMPTY_ADDRESS);
  const [retain, setRetain] = useState(initial.retentionDays !== null);
  const [days, setDays] = useState(String(initial.retentionDays ?? 180));
  const [state, setState] = useState<Record<Section, SaveState>>({ engine: IDLE, policies: IDLE, address: IDLE, retention: IDLE, shadow: IDLE });

  async function save(section: Section, input: SettingsInput, success: string) {
    setState((s) => ({ ...s, [section]: { ...IDLE, busy: true } }));
    try {
      const res = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState((s) => ({ ...s, [section]: { ...IDLE, error: body.error ?? '保存失败' } }));
        return;
      }
      const next = body.view as SettingsView;
      setView(next);
      setEngine(toDraft(engineFor(next, scope).engine));
      setPolicies(next.policies);
      setAddress(next.returnAddress ?? EMPTY_ADDRESS);
      const recomputed = body.recomputed as number;
      const changed = body.changed as SaveState['changed'];
      const extra =
        recomputed > 0
          ? `${recomputed} 笔未结案的索赔已重新判定，${changed.length > 0 ? `其中 ${changed.length} 笔判定等级变化：` : '判定等级都没有变化。'}`
          : '';
      const purged = body.purged as { evidence: number; files: number } | null;
      const purgedText = purged ? (purged.evidence > 0 ? `已删除 ${purged.evidence} 份到期的证据原件。` : '目前没有到期的证据原件。') : '';
      setState((s) => ({ ...s, [section]: { ...IDLE, done: `${success}${extra}${purgedText}`, changed } }));
      router.refresh();
    } catch {
      setState((s) => ({ ...s, [section]: { ...IDLE, error: '请求没有发出去，请重试' } }));
    }
  }

  const scoped = engineFor(view, scope);
  // 类目专用配置的提示值是商家默认（它从商家默认改起），全部类目的提示值是系统默认。
  const base = scope === ALL ? view.defaults : view.engine;
  const baseLabel = scope === ALL ? '默认' : '商家默认';
  const scopeLabel = scope === ALL ? '' : (view.policies.find((p) => p.category === scope)?.label ?? scope);
  const badge =
    scope === ALL
      ? view.customized
        ? { cls: 'badge-accent', text: '商家自定义' }
        : { cls: 'badge-sim', text: '默认配置' }
      : scoped.own
        ? { cls: 'badge-accent', text: '类目专用' }
        : { cls: 'badge-sim', text: '沿用商家默认' };
  const changeScope = (next: string) => {
    setScope(next);
    setEngine(toDraft(engineFor(view, next).engine));
    setState((s) => ({ ...s, engine: IDLE }));
  };
  const saveEngine = () =>
    scope === ALL
      ? save('engine', { engine: fromDraft(engine) }, '已保存。')
      : save('engine', { categoryEngine: { category: scope, engine: fromDraft(engine) } }, `已保存“${scopeLabel}”的专用配置。`);
  const resetEngine = () => {
    if (scope === ALL) {
      if (window.confirm('恢复默认权重与阈值？类目专用配置不受影响。未结案的索赔会重新判定。')) void save('engine', { engine: null }, '已恢复默认。');
    } else if (window.confirm(`删除“${scopeLabel}”的专用配置，改回商家默认？这个类目未结案的索赔会重新判定。`)) {
      void save('engine', { categoryEngine: { category: scope, engine: null } }, `“${scopeLabel}”已改回商家默认。`);
    }
  };

  const setStrength = (k: Strength, v: string) => setEngine((e) => ({ ...e, strengthWeight: { ...e.strengthWeight, [k]: v } }));
  const setLayer = (k: LayerGroup, v: string) => setEngine((e) => ({ ...e, layerWeight: { ...e.layerWeight, [k]: v } }));
  const setPolicy = (category: string, field: keyof Omit<PolicySettings, 'category'>, v: boolean) =>
    setPolicies((ps) => ps.map((p) => (p.category === category ? { ...p, [field]: v } : p)));

  return (
    <fieldset className="bare stack" style={{ gap: 14 }} disabled={readOnly}>
      {readOnly && <p className="notice notice-info">下面的判定设置只有店主可以修改，你可以查看。</p>}
      <section className="card card-pad">
        <div className="between">
          <h2>影子模式</h2>
          <span className={`badge ${view.shadowMode ? 'badge-accent' : 'badge-sim'}`}>{view.shadowMode ? '已开启' : '未开启'}</span>
        </div>
        <p className="muted small" style={{ marginBottom: 10 }}>
          正式启用前先跑一段时间：判定照常计算并存档，但索赔列表、详情和报告里都不显示判定、分数、发现和建议，动作面板只列 PayPal 允许的操作，也不自动附报告和证据。处理人员按自己的判断处理，每个决定都会和当时的判定对照。
        </p>
        <div className="row">
          <button
            className="btn btn-primary"
            disabled={state.shadow.busy}
            onClick={() => save('shadow', { shadowMode: !view.shadowMode }, view.shadowMode ? '影子模式已关闭，判定重新显示。' : '影子模式已开启。')}
          >
            {state.shadow.busy ? '保存中…' : view.shadowMode ? '关闭影子模式' : '开启影子模式'}
          </button>
          {!readOnly && (
            <Link className="btn" href="/shadow">
              查看影子对照
            </Link>
          )}
        </div>
        <Result state={state.shadow} />
      </section>
      <section className="card card-pad">
        <div className="between">
          <h2>判定权重与阈值</h2>
          <span className={`badge ${badge.cls}`}>{badge.text}</span>
        </div>
        <p className="muted small" style={{ marginBottom: 12 }}>
          买家侧风险 R = Σ 方向 × 强度权重 × 置信度 × 层级权重。硬规则信号（图片复用、网上更早的相同图片、单据对不上、截图和消息库不符）不受这里影响，出现就判高风险。未核验的来源声明不直接判高风险。买家自己的多份证据互相矛盾只抬到中风险。现场或系统记录里读到的序列号不符，在数据置信度足够时判高风险，但建议仍是先排查错发。可以给某个类目单独配置，比如生鲜的 Q 阈值放低、电子产品的高风险阈值收紧；没有单独配置的类目用商家默认。保存后未结案的索赔会按新配置重新判定；已结案的保留当时的判定。
        </p>
        <label className="field" style={{ maxWidth: 360 }}>
          适用范围
          <select value={scope} onChange={(e) => changeScope(e.target.value)}>
            <option value={ALL}>所有类目（商家默认）</option>
            {[...new Set([...view.policies.map((p) => p.category), ...view.categoryEngine.map((c) => c.category)])].sort().map((c) => {
              const label = view.policies.find((p) => p.category === c)?.label ?? view.categoryEngine.find((x) => x.category === c)?.label ?? c;
              const own = view.categoryEngine.some((x) => x.category === c);
              return (
                <option key={c} value={c}>
                  {label}（{c}）{own ? ' · 专用配置' : ''}
                </option>
              );
            })}
          </select>
          {scope === ALL && view.categoryEngine.length > 0 && (
            <span className="muted small">
              {view.categoryEngine.map((c) => c.label).join('、')}有专用配置，改这里不影响它们。
            </span>
          )}
          {scope !== ALL && !scoped.own && <span className="muted small">这个类目现在沿用商家默认。改完保存就成为它的专用配置。</span>}
        </label>
        <div className="settings-grid">
          <fieldset>
            <legend>信号强度权重</legend>
            {STRENGTHS.map((k) => (
              <NumberField key={k} label={STRENGTH_LABEL[k]} value={engine.strengthWeight[k]} onChange={(v) => setStrength(k, v)} hint={`${baseLabel} ${base.strengthWeight[k]}`} />
            ))}
          </fieldset>
          <fieldset>
            <legend>证据层级权重（0–1）</legend>
            {GROUPS.map((g) => (
              <NumberField key={g} label={LAYER_WEIGHT_GROUPS[g].label} value={engine.layerWeight[g]} onChange={(v) => setLayer(g, v)} step="0.05" hint={`${baseLabel} ${base.layerWeight[g]}`} />
            ))}
          </fieldset>
          <fieldset>
            <legend>阈值</legend>
            <NumberField label="中风险：R ≥" value={engine.riskMedium} onChange={(v) => setEngine((e) => ({ ...e, riskMedium: v }))} hint={`${baseLabel} ${base.riskMedium}`} />
            <NumberField label="高风险：R ≥" value={engine.riskHigh} onChange={(v) => setEngine((e) => ({ ...e, riskHigh: v }))} hint={`${baseLabel} ${base.riskHigh}`} />
            <NumberField
              label="数据置信度充足：Q ≥"
              value={engine.minDataConfidence}
              onChange={(v) => setEngine((e) => ({ ...e, minDataConfidence: v }))}
              step="0.05"
              hint={`${baseLabel} ${base.minDataConfidence}${scope === ALL ? '（开发文档没有给数值）' : ''}`}
            />
            <NumberField
              label="商家侧风险高：M ≥"
              value={engine.merchantRiskHigh}
              onChange={(v) => setEngine((e) => ({ ...e, merchantRiskHigh: v }))}
              step="0.05"
              hint={`${baseLabel} ${base.merchantRiskHigh}${scope === ALL ? '（开发文档没有给数值）' : ''}`}
            />
          </fieldset>
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <button className="btn btn-primary" disabled={state.engine.busy} onClick={saveEngine}>
            {state.engine.busy ? '保存中…' : scope === ALL ? '保存权重与阈值' : `保存“${scopeLabel}”专用配置`}
          </button>
          <button className="btn" disabled={state.engine.busy || !scoped.own} onClick={resetEngine}>
            {scope === ALL ? '恢复默认' : '改回商家默认'}
          </button>
        </div>
        <Result state={state.engine} />
      </section>

      <section className="card card-pad">
        <h2>类目策略</h2>
        <p className="muted small" style={{ marginBottom: 10 }}>
          可退货：关掉后不建议退货退款，“商品是否适宜退回”判为不成立。易腐：报告提示重点核对签收到首次反馈的间隔。涉及安全：报告置顶提示先按安全事件处理。核对序列号：必需镜头加上序列号特写，“受损物是否为本订单商品”算关键命题。改动后未结案的索赔会重新判定。
        </p>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>类目</th>
                <th>订单</th>
                <th>可退货</th>
                <th>易腐</th>
                <th>涉及安全</th>
                <th>核对序列号</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.category}>
                  <td>
                    {view.policies.find((v) => v.category === p.category)?.label ?? p.category} <span className="muted small">{p.category}</span>
                  </td>
                  <td className="num">{view.policies.find((v) => v.category === p.category)?.orders ?? 0}</td>
                  {(['returnable', 'perishable', 'safetySensitive', 'identityRequired'] as const).map((f) => (
                    <td key={f}>
                      <input
                        type="checkbox"
                        aria-label={`${view.policies.find((v) => v.category === p.category)?.label ?? p.category}：${POLICY_FLAG_LABEL[f]}`}
                        checked={p[f]}
                        onChange={(e) => setPolicy(p.category, f, e.target.checked)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn btn-primary" disabled={state.policies.busy} onClick={() => save('policies', { policies }, '已保存。')}>
            {state.policies.busy ? '保存中…' : '保存类目策略'}
          </button>
        </div>
        <Result state={state.policies} />
      </section>

      <div className="two-col">
        <section className="card card-pad">
          <div className="between">
            <h2>退货地址</h2>
            {!view.returnAddress && <span className="badge badge-warn">正在用演示地址</span>}
          </div>
          <p className="muted small" style={{ marginBottom: 10 }}>
            提出“退货退款”和解时，PayPal 会把这个地址告诉买家。
            {!view.returnAddress && `没有填写时用演示地址（${[view.demoReturnAddress.line1, view.demoReturnAddress.city].join(', ')}，虚构）。`}
          </p>
          <label className="field">
            街道地址
            <input type="text" value={address.line1} onChange={(e) => setAddress({ ...address, line1: e.target.value })} autoComplete="address-line1" />
          </label>
          <label className="field">
            地址第二行（可选）
            <input type="text" value={address.line2 ?? ''} onChange={(e) => setAddress({ ...address, line2: e.target.value })} autoComplete="address-line2" />
          </label>
          <div className="settings-grid">
            <label className="field">
              城市
              <input type="text" value={address.city} onChange={(e) => setAddress({ ...address, city: e.target.value })} autoComplete="address-level2" />
            </label>
            <label className="field">
              州/省
              <input type="text" value={address.state} onChange={(e) => setAddress({ ...address, state: e.target.value })} autoComplete="address-level1" />
            </label>
            <label className="field">
              邮编
              <input type="text" value={address.postalCode} onChange={(e) => setAddress({ ...address, postalCode: e.target.value })} autoComplete="postal-code" />
            </label>
            <label className="field">
              国家代码
              <input
                type="text"
                maxLength={2}
                value={address.countryCode}
                onChange={(e) => setAddress({ ...address, countryCode: e.target.value.toUpperCase() })}
                autoComplete="country"
              />
            </label>
          </div>
          <div className="row">
            <button className="btn btn-primary" disabled={state.address.busy} onClick={() => save('address', { returnAddress: address }, '退货地址已保存。')}>
              {state.address.busy ? '保存中…' : '保存退货地址'}
            </button>
            {view.returnAddress && (
              <button className="btn" disabled={state.address.busy} onClick={() => save('address', { returnAddress: null }, '已改回演示地址。')}>
                改回演示地址
              </button>
            )}
          </div>
          <Result state={state.address} />
        </section>

        <section className="card card-pad">
          <h2>证据保留期</h2>
          <p className="muted small" style={{ marginBottom: 10 }}>
            开发文档要求原始证据文件按商家设置的保留期到期删除。只删除已结案索赔的买家证据原件；哈希、分析信号和判定保留，图片复用检测仍然有效。商家留底照不受影响。
          </p>
          <label className="row" style={{ marginBottom: 10 }}>
            <input type="checkbox" checked={retain} onChange={(e) => setRetain(e.target.checked)} />
            到期自动删除证据原件
          </label>
          {retain && <NumberField label="证据上传后保留天数" value={days} onChange={setDays} step="1" />}
          <div className="row">
            <button
              className="btn btn-primary"
              disabled={state.retention.busy}
              onClick={() => {
                // NaN 经 JSON 序列化会变成 null，而 null 表示关闭自动删除，所以空值要在这里拦下。
                if (retain && (days.trim() === '' || !Number.isFinite(Number(days)))) {
                  setState((s) => ({ ...s, retention: { ...IDLE, error: '请填写保留天数' } }));
                  return;
                }
                void save('retention', { retentionDays: retain ? Number(days) : null }, retain ? '保留期已保存。' : '已关闭自动删除。');
              }}
            >
              {state.retention.busy ? '保存中…' : '保存保留期'}
            </button>
          </div>
          <Result state={state.retention} />
        </section>
      </div>
    </fieldset>
  );
}
