'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ANALYZER_LABEL,
  CLAIM_TYPE_LABEL,
  LEVEL_LABEL,
  ORIGIN_LABEL,
  SHOT_LABEL,
  SOURCE_LABEL,
  STATUS_LABEL,
  STRENGTH_LABEL,
} from '@/core/catalog';
import type { BBox, Finding, PropositionResult, RunStatus, SourceMark } from '@/core/types';
import type { PublicEvidence } from '@/server/repo';
import type { ClaimViewData } from '@/server/views';
import { ActionPanel } from './ActionPanel';
import { SandboxTools } from './SandboxTools';
import { dueLabel, fmtDateTime, fmtMoney } from './format';

const STATUS_TEXT: Record<PropositionResult['status'], string> = { holds: '成立', refuted: '不成立', insufficient: '证据不足' };
const RUN_TEXT: Record<RunStatus, string> = { queued: '排队', running: '运行中', done: '完成', unavailable: '未执行', failed: '失败' };

function providerText(p?: string) {
  if (!p) return null;
  if (p === 'recorded-fixture') return '录制回放';
  return p;
}

export function ClaimView({ initial }: { initial: ClaimViewData }) {
  const [data, setData] = useState(initial);
  const id = initial.claim.id;
  const allEvidence = useMemo(() => [...data.evidence, ...data.references], [data.evidence, data.references]);
  const [selectedId, setSelectedId] = useState<string | null>(initial.evidence[0]?.id ?? initial.references[0]?.id ?? null);
  const [highlight, setHighlight] = useState<{ evidenceId: string; bbox: BBox } | null>(null);
  const [activeFinding, setActiveFinding] = useState<string | null>(null);
  const [reanalyzing, setReanalyzing] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/claims/${id}`, { cache: 'no-store' });
    if (res.ok) setData((await res.json()) as ClaimViewData);
  }, [id]);

  useEffect(() => {
    const es = new EventSource(`/api/claims/${id}/events`);
    es.addEventListener('update', () => void refresh());
    return () => es.close();
  }, [id, refresh]);

  const selected = allEvidence.find((e) => e.id === selectedId) ?? null;
  const report = data.verdict?.report ?? null;
  const signalById = useMemo(() => new Map(data.signals.map((s) => [s.id, s])), [data.signals]);
  const analyzing = data.runs.some((r) => r.status === 'queued' || r.status === 'running');
  const due = dueLabel(data.claim.dueAt);
  const showDeadlineWarning = due.soon && report?.incomplete && data.claim.status !== 'closed';

  function selectFinding(f: Finding) {
    setActiveFinding(f.signalIds[0]);
    const target = f.region?.evidenceId ?? f.evidenceIds.find((e) => allEvidence.some((x) => x.id === e));
    if (target) setSelectedId(target);
    setHighlight(f.region ?? null);
  }

  async function reanalyze() {
    setReanalyzing(true);
    await fetch(`/api/claims/${id}/reanalyze`, { method: 'POST' });
    setReanalyzing(false);
  }

  const scenario = data.claim.scenario;
  const item = data.order.items[0];

  return (
    <>
      <div className="page-head">
        <div>
          <p className="small">
            <Link href="/claims">← 索赔列表</Link>
          </p>
          <h1>
            {data.order.orderNo} · {item?.title}
            {item && item.quantity > 1 ? ` ×${item.quantity}` : ''}
          </h1>
          <div className="row" style={{ marginTop: 6 }}>
            <span className="badge">{CLAIM_TYPE_LABEL[data.claim.type]}</span>
            <span className="badge">{ORIGIN_LABEL[data.claim.origin]}</span>
            <span className="badge">{STATUS_LABEL[data.claim.status]}</span>
            {data.paypal.env === 'sandbox' && <span className="badge badge-warn">PayPal 沙箱</span>}
            {data.paypal.status && (
              <span className="badge mono">
                {data.paypal.status} · {data.paypal.stage}
              </span>
            )}
            <span className="muted num">{fmtMoney(data.order.amount, data.order.currency)}</span>
            {data.claim.dueAt && (
              <span className={due.soon ? 'due-soon' : 'muted'} suppressHydrationWarning>
                PayPal 截止：{due.text}
              </span>
            )}
          </div>
        </div>
        <div className="row no-print">
          <button className="btn" onClick={reanalyze} disabled={reanalyzing || analyzing}>
            {analyzing ? '分析中…' : '重新分析'}
          </button>
          <Link className="btn" href={`/orders/${data.order.id}`}>
            订单与留底
          </Link>
          {report && (
            <Link className="btn" href={`/claims/${id}/report`}>
              核验报告
            </Link>
          )}
        </div>
      </div>

      {scenario && (
        <div className="scenario">
          <strong>演示场景：{scenario.title}。</strong> {scenario.story} <strong>文档期望：</strong>
          {scenario.expected}。
        </div>
      )}
      {data.paypal.error && (
        <div className="notice notice-danger" style={{ marginBottom: 14 }}>
          暂时读取不到 PayPal 上这笔争议的状态，动作已暂停：{data.paypal.error}
        </div>
      )}
      {showDeadlineWarning && (
        <div className="notice notice-danger" style={{ marginBottom: 14 }}>
          PayPal 响应截止临近，仍有检查未完成。下面的判定只基于已完成的信号。
        </div>
      )}

      <div className="detail-grid">
        <div className="main-col">
          <Gallery
            evidence={data.evidence}
            references={data.references}
            selected={selected}
            highlight={highlight}
            onSelect={(eid) => {
              setSelectedId(eid);
              setHighlight(null);
              setActiveFinding(null);
            }}
          />

          {report && (
            <section className="card card-pad">
              <h2>发现（{report.findings.length}）</h2>
              {report.findings.length === 0 && <p className="muted">已完成的分析器没有产生信号。</p>}
              {report.findings.map((f) => (
                <button
                  key={f.signalIds[0]}
                  className={`finding d-${f.direction} ${activeFinding === f.signalIds[0] ? 'selected' : ''}`}
                  onClick={() => selectFinding(f)}
                >
                  <div className="finding-head">
                    <strong>{f.title}</strong>
                    {f.hardRule && <span className="badge level-high">硬规则</span>}
                    <span className="badge">{f.direction === 'contradicts_claim' ? '反驳索赔' : f.direction === 'supports_claim' ? '支持索赔' : '中性'}</span>
                    <span className="badge">强度 {STRENGTH_LABEL[f.strength]}</span>
                    <span className="muted small">{ANALYZER_LABEL[f.analyzer].name}</span>
                    {providerText(f.provider) && <span className="badge badge-sim">{providerText(f.provider)}</span>}
                  </div>
                  <div>{f.explanation}</div>
                  <ReuseComparison raw={signalById.get(f.signalIds[0])?.raw} />
                  {f.normalExplanations.length > 0 && (
                    <div className="explain">
                      需排除的正常解释：
                      <ul>
                        {f.normalExplanations.map((n) => (
                          <li key={n}>{n}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </button>
              ))}
            </section>
          )}

          {report && (
            <section className="card card-pad">
              <h2>命题核验</h2>
              {report.propositions.map((p) => {
                const signals = [...p.supportingSignalIds, ...p.refutingSignalIds].map((sid) => signalById.get(sid)?.code).filter(Boolean);
                return (
                  <div className="prop" key={p.id}>
                    <span className={`badge status-${p.status}`} style={{ justifySelf: 'start' }}>
                      {STATUS_TEXT[p.status]}
                    </span>
                    <div>
                      {p.label}
                      {p.key && <span className="muted small">（关键）</span>}
                      {(p.note || signals.length > 0) && (
                        <div className="muted small">
                          {p.note}
                          {p.note && signals.length > 0 ? ' · ' : ''}
                          {signals.join('、')}
                        </div>
                      )}
                    </div>
                    <div className="row">
                      {p.layers.map((l) => (
                        <span key={l} className={`tier tier-${l}`} title={`${l} 层证据`}>
                          {l}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </section>
          )}

          <section className="card card-pad">
            <h2>买家陈述</h2>
            <p style={{ whiteSpace: 'pre-wrap' }}>{data.claim.narrative || <span className="muted">买家还没有填写。</span>}</p>
          </section>

          <section className="card card-pad">
            <h2>时间线</h2>
            <ol className="timeline">
              {data.timeline.map((t, i) => (
                <li key={`${t.at}-${i}`}>
                  <time>{fmtDateTime(t.at)}</time>
                  <div>
                    {t.title}
                    {t.detail && <span className="muted small"> · {SHOT_LABEL[t.detail] ?? t.detail}</span>}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {report && (
            <section className="card card-pad">
              <details className="audit">
                <summary>审计记录</summary>
                <p className="muted small" style={{ marginTop: 8 }}>
                  规则版本 {report.rulesVersion} · 判定 ID {data.verdict!.id}
                </p>
                <h3 style={{ marginTop: 10 }}>规则路径</h3>
                <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
                  {report.ruleTrace.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
                <h3 style={{ marginTop: 10 }}>信号原始数据</h3>
                <pre className="raw">{JSON.stringify(data.signals, null, 2)}</pre>
              </details>
            </section>
          )}
        </div>

        <aside className="side">
          {report ? (
            <section className="card verdict-card">
              <div className={`verdict-band level-${report.level}`}>
                <div className="verdict-level">{LEVEL_LABEL[report.level]}</div>
                <div>{report.headline}</div>
                <div className="row" style={{ marginTop: 6 }}>
                  {report.incomplete && <span className="badge badge-warn">核验不完整</span>}
                  {report.qualityNotice && <span className="badge badge-warn">疑似质量或履约问题</span>}
                </div>
              </div>
              <div className="scores">
                <div title="买家侧风险：正值倾向索赔不实">
                  <b>{report.score.toFixed(2)}</b>
                  <span>买家风险 R</span>
                </div>
                <div title="关键命题中 A、B 层证据覆盖比例 × 分析器完成比例">
                  <b>{report.dataConfidence.toFixed(2)}</b>
                  <span>置信度 Q</span>
                </div>
                <div title="商品质量或履约问题的可能性">
                  <b>{report.merchantRisk.toFixed(2)}</b>
                  <span>商家风险 M</span>
                </div>
              </div>
              <div className="card-pad">
                {report.topSignalIds.length > 0 && (
                  <>
                    <h3 style={{ marginBottom: 4 }}>贡献最大的信号</h3>
                    {report.topSignalIds.map((sid) => {
                      const f = report.findings.find((x) => x.signalIds.includes(sid));
                      if (!f) return null;
                      return (
                        <div className="signal-line" key={sid}>
                          <span>{f.title}</span>
                          <span className="num">{f.contribution > 0 ? `+${f.contribution.toFixed(2)}` : f.contribution.toFixed(2)}</span>
                        </div>
                      );
                    })}
                  </>
                )}
                {report.notices.length > 0 && (
                  <div className="stack" style={{ marginTop: report.topSignalIds.length ? 10 : 0 }}>
                    {report.notices.map((n) => (
                      <div className="notice" key={n}>
                        {n}
                      </div>
                    ))}
                  </div>
                )}
                {report.missingShots.length + report.lowTierShots.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <h3 style={{ marginBottom: 4 }}>充分性清单</h3>
                    {report.missingShots.map((s) => (
                      <div key={s} className="small">
                        ✕ 缺少：{SHOT_LABEL[s] ?? s}
                      </div>
                    ))}
                    {report.lowTierShots.map((s) => (
                      <div key={s} className="small">
                        △ 只有相册或导入来源：{SHOT_LABEL[s] ?? s}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          ) : (
            <section className="card card-pad">
              <h2>等待证据</h2>
              <p className="muted">买家提交后会自动开始分析。</p>
            </section>
          )}

          {report && (
            <ActionPanel
              key={data.verdict!.id}
              claimId={id}
              verdictId={data.verdict!.id}
              report={report}
              claim={data.claim}
              order={data.order}
              allowed={data.allowedActions}
              actions={data.actions}
              paypal={data.paypal}
              onDone={refresh}
            />
          )}

          {data.paypal.env === 'sandbox' && data.claim.disputeId && data.claim.status !== 'closed' && (
            <SandboxTools claimId={id} links={data.paypal.sandboxTools} onDone={refresh} />
          )}

          {data.runs.length > 0 && (
            <section className="card card-pad">
              <h2>分析器</h2>
              {data.runs.map((r) => (
                <div className="run" key={r.analyzer}>
                  <span className={`dot dot-${r.status}`} />
                  <div>
                    <span>{ANALYZER_LABEL[r.analyzer].name}</span> <span className="muted small">{ANALYZER_LABEL[r.analyzer].what}</span>
                    {r.status !== 'done' && r.error && <div className="small" style={{ color: 'var(--medium)' }}>{r.error}</div>}
                    {r.status === 'done' && r.note && <div className="muted small">{r.note}</div>}
                  </div>
                  <span className="muted small">{RUN_TEXT[r.status]}</span>
                </div>
              ))}
            </section>
          )}
        </aside>
      </div>
    </>
  );
}

/** 图片复用是硬规则，把被比对的那张图摆出来，商家才能自己判断是不是真的同一张。 */
function ReuseComparison({ raw }: { raw: unknown }) {
  const match = raw as { matchedEvidenceId?: string; matchedOrder?: string } | null | undefined;
  if (!match?.matchedEvidenceId) return null;
  return (
    <div className="explain">
      比对对象（订单 {match.matchedOrder}）：
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/evidence/${match.matchedEvidenceId}/file`}
        alt={`订单 ${match.matchedOrder} 的历史证据`}
        style={{ display: 'block', width: 160, height: 107, objectFit: 'cover', borderRadius: 4, marginTop: 4 }}
      />
    </div>
  );
}

function Gallery({
  evidence,
  references,
  selected,
  highlight,
  onSelect,
}: {
  evidence: PublicEvidence[];
  references: PublicEvidence[];
  selected: PublicEvidence | null;
  highlight: { evidenceId: string; bbox: BBox } | null;
  onSelect: (id: string) => void;
}) {
  if (evidence.length === 0 && references.length === 0) {
    return (
      <section className="card card-pad">
        <h2>证据</h2>
        <p className="muted">这笔索赔没有图片证据，核验依据物流与交易记录。</p>
      </section>
    );
  }
  const box = highlight && selected && highlight.evidenceId === selected.id ? highlight.bbox : null;
  return (
    <section className="card card-pad">
      <h2>证据</h2>
      {selected && (
        <div className="gallery-main">
          <div className="gallery-frame">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/evidence/${selected.id}/file`} alt={SHOT_LABEL[selected.shotLabel ?? ''] ?? '证据图片'} />
            {box && (
              <div
                className="bbox"
                style={{ left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${box[2] * 100}%`, height: `${box[3] * 100}%` }}
              />
            )}
          </div>
        </div>
      )}
      {evidence.length > 0 && <Thumbs title={`买家证据（${evidence.length}）`} items={evidence} selected={selected} onSelect={onSelect} />}
      {references.length > 0 && <Thumbs title={`商家留底（${references.length}）`} items={references} selected={selected} onSelect={onSelect} />}
      {selected && (
        <dl className="meta-grid">
          <div>
            <dt>镜头</dt>
            <dd>{SHOT_LABEL[selected.shotLabel ?? ''] ?? selected.shotLabel ?? '未标注'}</dd>
          </div>
          <div>
            <dt>来源</dt>
            <dd>
              <span className={`tier tier-${selected.layer}`}>{selected.layer}</span> {SOURCE_LABEL[selected.source as SourceMark]}
            </dd>
          </div>
          <div>
            <dt>上传时间</dt>
            <dd>{fmtDateTime(selected.createdAt)}</dd>
          </div>
          <div>
            <dt>SHA-256</dt>
            <dd className="mono" title={selected.sha256}>
              {selected.sha256.slice(0, 16)}…
            </dd>
          </div>
          {selected.challenge && (
            <div>
              <dt>挑战</dt>
              <dd>
                <span className="mono">{selected.challenge.code}</span> · {selected.challenge.action}
              </dd>
            </div>
          )}
          {typeof selected.captureMeta?.durationMs === 'number' && (
            <div>
              <dt>拍摄耗时</dt>
              <dd className="num">{Math.round((selected.captureMeta.durationMs as number) / 1000)} 秒</dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}

function Thumbs({
  title,
  items,
  selected,
  onSelect,
}: {
  title: string;
  items: PublicEvidence[];
  selected: PublicEvidence | null;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      <div className="muted small" style={{ marginTop: 10 }}>
        {title}
      </div>
      <div className="thumbs" style={{ marginTop: 4 }}>
        {items.map((e) => (
          <button key={e.id} className="thumb" aria-pressed={selected?.id === e.id} onClick={() => onSelect(e.id)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/evidence/${e.id}/file`} alt="" loading="lazy" />
            <span className={`tier tier-${e.layer}`}>{e.layer}</span>
            <span className="thumb-label">{SHOT_LABEL[e.shotLabel ?? ''] ?? e.shotLabel ?? '未标注'}</span>
          </button>
        ))}
      </div>
    </>
  );
}
