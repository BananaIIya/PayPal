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
const POLICY_FLAG_LABEL = { returnable: 'Returnable', perishable: 'Perishable', safetySensitive: 'Safety-sensitive', identityRequired: 'Verify serial number' } as const;
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
        setState((s) => ({ ...s, [section]: { ...IDLE, error: body.error ?? 'Save failed' } }));
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
          ? ` Re-evaluated ${recomputed} open claims. ${changed.length > 0 ? `Verdict level changed on ${changed.length}:` : 'No verdict levels changed.'}`
          : '';
      const purged = body.purged as { evidence: number; files: number } | null;
      const purgedText = purged ? (purged.evidence > 0 ? ` Deleted ${purged.evidence} expired evidence originals.` : ' No evidence originals have expired yet.') : '';
      setState((s) => ({ ...s, [section]: { ...IDLE, done: `${success}${extra}${purgedText}`, changed } }));
      router.refresh();
    } catch {
      setState((s) => ({ ...s, [section]: { ...IDLE, error: 'Request failed to send. Try again.' } }));
    }
  }

  const scoped = engineFor(view, scope);
  // 类目专用配置的提示值是商家默认（它从商家默认改起），全部类目的提示值是系统默认。
  const base = scope === ALL ? view.defaults : view.engine;
  const baseLabel = scope === ALL ? 'Default' : 'Merchant default';
  const scopeLabel = scope === ALL ? '' : (view.policies.find((p) => p.category === scope)?.label ?? scope);
  const badge =
    scope === ALL
      ? view.customized
        ? { cls: 'badge-accent', text: 'Customized' }
        : { cls: 'badge-sim', text: 'Default' }
      : scoped.own
        ? { cls: 'badge-accent', text: 'Category-specific' }
        : { cls: 'badge-sim', text: 'Using merchant default' };
  const changeScope = (next: string) => {
    setScope(next);
    setEngine(toDraft(engineFor(view, next).engine));
    setState((s) => ({ ...s, engine: IDLE }));
  };
  const saveEngine = () =>
    scope === ALL
      ? save('engine', { engine: fromDraft(engine) }, 'Saved.')
      : save('engine', { categoryEngine: { category: scope, engine: fromDraft(engine) } }, `Saved category settings for "${scopeLabel}".`);
  const resetEngine = () => {
    if (scope === ALL) {
      if (window.confirm('Restore default weights and thresholds? Category-specific settings are not affected. Open claims will be re-evaluated.')) void save('engine', { engine: null }, 'Defaults restored.');
    } else if (window.confirm(`Delete the category settings for "${scopeLabel}" and use the merchant default? Open claims in this category will be re-evaluated.`)) {
      void save('engine', { categoryEngine: { category: scope, engine: null } }, `"${scopeLabel}" now uses the merchant default.`);
    }
  };

  const setStrength = (k: Strength, v: string) => setEngine((e) => ({ ...e, strengthWeight: { ...e.strengthWeight, [k]: v } }));
  const setLayer = (k: LayerGroup, v: string) => setEngine((e) => ({ ...e, layerWeight: { ...e.layerWeight, [k]: v } }));
  const setPolicy = (category: string, field: keyof Omit<PolicySettings, 'category'>, v: boolean) =>
    setPolicies((ps) => ps.map((p) => (p.category === category ? { ...p, [field]: v } : p)));

  return (
    <fieldset className="bare stack" style={{ gap: 14 }} disabled={readOnly}>
      {readOnly && <p className="notice notice-info">Only the owner can change these verdict settings. You can view them.</p>}
      <section className="card card-pad">
        <div className="between">
          <h2>Shadow mode</h2>
          <span className={`badge ${view.shadowMode ? 'badge-accent' : 'badge-sim'}`}>{view.shadowMode ? 'On' : 'Off'}</span>
        </div>
        <p className="muted small" style={{ marginBottom: 10 }}>
          Run this for a while before going live. Verdicts are still computed and stored, but the claim list, claim details and reports hide verdicts, scores, findings and recommendations. The action panel lists only the actions PayPal allows and does not attach reports or evidence automatically. Agents decide on their own, and each decision is compared with the verdict at that time.
        </p>
        <div className="row">
          <button
            className="btn btn-primary"
            disabled={state.shadow.busy}
            onClick={() => save('shadow', { shadowMode: !view.shadowMode }, view.shadowMode ? 'Shadow mode is off. Verdicts are visible again.' : 'Shadow mode is on.')}
          >
            {state.shadow.busy ? 'Saving…' : view.shadowMode ? 'Turn off shadow mode' : 'Turn on shadow mode'}
          </button>
          {!readOnly && (
            <Link className="btn" href="/shadow">
              View shadow mode results
            </Link>
          )}
        </div>
        <Result state={state.shadow} />
      </section>
      <section className="card card-pad">
        <div className="between">
          <h2>Verdict weights and thresholds</h2>
          <span className={`badge ${badge.cls}`}>{badge.text}</span>
        </div>
        <p className="muted small" style={{ marginBottom: 12 }}>
          Buyer risk R = Σ direction × strength weight × confidence × tier weight. Hard rule signals (reused image, identical image found earlier online, mismatched documents, screenshot that does not match the message log) are not affected by these settings and always mean High risk. Unverified source claims do not trigger High risk on their own. Contradictions between the buyer's own evidence raise the verdict only to Medium risk. A serial number mismatch read from a live capture or system record means High risk when Confidence Q is sufficient, but the recommendation is still to check for a wrong shipment first. You can configure a category separately, for example a lower Q threshold for fresh food or a stricter High risk threshold for electronics. Categories without their own settings use the merchant default. After you save, open claims are re-evaluated with the new settings. Closed claims keep their original verdict.
        </p>
        <label className="field" style={{ maxWidth: 360 }}>
          Applies to
          <select value={scope} onChange={(e) => changeScope(e.target.value)}>
            <option value={ALL}>All categories (merchant default)</option>
            {[...new Set([...view.policies.map((p) => p.category), ...view.categoryEngine.map((c) => c.category)])].sort().map((c) => {
              const label = view.policies.find((p) => p.category === c)?.label ?? view.categoryEngine.find((x) => x.category === c)?.label ?? c;
              const own = view.categoryEngine.some((x) => x.category === c);
              return (
                <option key={c} value={c}>
                  {label} ({c}){own ? ' · Category settings' : ''}
                </option>
              );
            })}
          </select>
          {scope === ALL && view.categoryEngine.length > 0 && (
            <span className="muted small">
              {view.categoryEngine.map((c) => c.label).join(', ')} have their own settings. Changes here do not affect them.
            </span>
          )}
          {scope !== ALL && !scoped.own && <span className="muted small">This category uses the merchant default. Saving changes creates category settings for it.</span>}
        </label>
        <div className="settings-grid">
          <fieldset>
            <legend>Signal strength weights</legend>
            {STRENGTHS.map((k) => (
              <NumberField key={k} label={STRENGTH_LABEL[k]} value={engine.strengthWeight[k]} onChange={(v) => setStrength(k, v)} hint={`${baseLabel} ${base.strengthWeight[k]}`} />
            ))}
          </fieldset>
          <fieldset>
            <legend>Evidence tier weights (0–1)</legend>
            {GROUPS.map((g) => (
              <NumberField key={g} label={LAYER_WEIGHT_GROUPS[g].label} value={engine.layerWeight[g]} onChange={(v) => setLayer(g, v)} step="0.05" hint={`${baseLabel} ${base.layerWeight[g]}`} />
            ))}
          </fieldset>
          <fieldset>
            <legend>Thresholds</legend>
            <NumberField label="Medium risk: R ≥" value={engine.riskMedium} onChange={(v) => setEngine((e) => ({ ...e, riskMedium: v }))} hint={`${baseLabel} ${base.riskMedium}`} />
            <NumberField label="High risk: R ≥" value={engine.riskHigh} onChange={(v) => setEngine((e) => ({ ...e, riskHigh: v }))} hint={`${baseLabel} ${base.riskHigh}`} />
            <NumberField
              label="Confidence Q sufficient: Q ≥"
              value={engine.minDataConfidence}
              onChange={(v) => setEngine((e) => ({ ...e, minDataConfidence: v }))}
              step="0.05"
              hint={`${baseLabel} ${base.minDataConfidence}${scope === ALL ? ' (no value in the spec)' : ''}`}
            />
            <NumberField
              label="Merchant risk M high: M ≥"
              value={engine.merchantRiskHigh}
              onChange={(v) => setEngine((e) => ({ ...e, merchantRiskHigh: v }))}
              step="0.05"
              hint={`${baseLabel} ${base.merchantRiskHigh}${scope === ALL ? ' (no value in the spec)' : ''}`}
            />
          </fieldset>
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <button className="btn btn-primary" disabled={state.engine.busy} onClick={saveEngine}>
            {state.engine.busy ? 'Saving…' : scope === ALL ? 'Save weights and thresholds' : `Save settings for "${scopeLabel}"`}
          </button>
          <button className="btn" disabled={state.engine.busy || !scoped.own} onClick={resetEngine}>
            {scope === ALL ? 'Restore defaults' : 'Use merchant default'}
          </button>
        </div>
        <Result state={state.engine} />
      </section>

      <section className="card card-pad">
        <h2>Category policies</h2>
        <p className="muted small" style={{ marginBottom: 10 }}>
          Returnable: when off, return and refund is not recommended and "Item is suitable for return" is Refuted. Perishable: the report flags the time from delivery to first contact for review. Safety-sensitive: the report starts with a note to handle it as a safety incident first. Verify serial number: a serial number close-up is added to the required shots, and "Damaged item is this order's item" becomes a key check. Open claims are re-evaluated after changes.
        </p>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Category</th>
                <th>Orders</th>
                <th>Returnable</th>
                <th>Perishable</th>
                <th>Safety-sensitive</th>
                <th>Verify serial number</th>
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
                        aria-label={`${view.policies.find((v) => v.category === p.category)?.label ?? p.category}: ${POLICY_FLAG_LABEL[f]}`}
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
          <button className="btn btn-primary" disabled={state.policies.busy} onClick={() => save('policies', { policies }, 'Saved.')}>
            {state.policies.busy ? 'Saving…' : 'Save category policies'}
          </button>
        </div>
        <Result state={state.policies} />
      </section>

      <div className="two-col">
        <section className="card card-pad">
          <div className="between">
            <h2>Return address</h2>
            {!view.returnAddress && <span className="badge badge-warn">Using demo address</span>}
          </div>
          <p className="muted small" style={{ marginBottom: 10 }}>
            PayPal shares this address with the buyer when you offer a return and refund.
            {!view.returnAddress && ` If empty, the demo address is used (${[view.demoReturnAddress.line1, view.demoReturnAddress.city].join(', ')}, fictional).`}
          </p>
          <label className="field">
            Street address
            <input type="text" value={address.line1} onChange={(e) => setAddress({ ...address, line1: e.target.value })} autoComplete="address-line1" />
          </label>
          <label className="field">
            Address line 2 (optional)
            <input type="text" value={address.line2 ?? ''} onChange={(e) => setAddress({ ...address, line2: e.target.value })} autoComplete="address-line2" />
          </label>
          <div className="settings-grid">
            <label className="field">
              City
              <input type="text" value={address.city} onChange={(e) => setAddress({ ...address, city: e.target.value })} autoComplete="address-level2" />
            </label>
            <label className="field">
              State/province
              <input type="text" value={address.state} onChange={(e) => setAddress({ ...address, state: e.target.value })} autoComplete="address-level1" />
            </label>
            <label className="field">
              Postal code
              <input type="text" value={address.postalCode} onChange={(e) => setAddress({ ...address, postalCode: e.target.value })} autoComplete="postal-code" />
            </label>
            <label className="field">
              Country code
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
            <button className="btn btn-primary" disabled={state.address.busy} onClick={() => save('address', { returnAddress: address }, 'Return address saved.')}>
              {state.address.busy ? 'Saving…' : 'Save return address'}
            </button>
            {view.returnAddress && (
              <button className="btn" disabled={state.address.busy} onClick={() => save('address', { returnAddress: null }, 'Switched back to the demo address.')}>
                Use demo address
              </button>
            )}
          </div>
          <Result state={state.address} />
        </section>

        <section className="card card-pad">
          <h2>Evidence retention</h2>
          <p className="muted small" style={{ marginBottom: 10 }}>
            The spec requires original evidence files to be deleted when the merchant's retention period ends. Only the buyer's original evidence files on closed claims are deleted. Hashes, analysis signals and verdicts are kept, so reused-image detection still works. Reference photos are not affected.
          </p>
          <label className="row" style={{ marginBottom: 10 }}>
            <input type="checkbox" checked={retain} onChange={(e) => setRetain(e.target.checked)} />
            Delete evidence originals automatically when they expire
          </label>
          {retain && <NumberField label="Days to keep evidence after upload" value={days} onChange={setDays} step="1" />}
          <div className="row">
            <button
              className="btn btn-primary"
              disabled={state.retention.busy}
              onClick={() => {
                // NaN 经 JSON 序列化会变成 null，而 null 表示关闭自动删除，所以空值要在这里拦下。
                if (retain && (days.trim() === '' || !Number.isFinite(Number(days)))) {
                  setState((s) => ({ ...s, retention: { ...IDLE, error: 'Enter the number of days to keep evidence' } }));
                  return;
                }
                void save('retention', { retentionDays: retain ? Number(days) : null }, retain ? 'Retention period saved.' : 'Automatic deletion turned off.');
              }}
            >
              {state.retention.busy ? 'Saving…' : 'Save retention period'}
            </button>
          </div>
          <Result state={state.retention} />
        </section>
      </div>
    </fieldset>
  );
}
