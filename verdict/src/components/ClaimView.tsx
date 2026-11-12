'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ANALYZER_LABEL,
  CLAIM_TYPE_LABEL,
  DEFAULT_CONFIG,
  describeConfig,
  LEVEL_LABEL,
  ORIGIN_LABEL,
  SHOT_LABEL,
  SOURCE_LABEL,
  STATUS_LABEL,
  STRENGTH_LABEL,
} from '@/core/catalog';
import type { BBox, Finding, PropositionResult, RunStatus, SourceMark } from '@/core/types';
import type { Viewer } from '@/server/guard';
import type { PublicEvidence } from '@/server/repo';
import type { ClaimViewData } from '@/server/views';
import { ActionPanel } from './ActionPanel';
import { DeleteClaim } from './DeleteClaim';
import { SandboxTools } from './SandboxTools';
import { dueLabel, fmtDateTime, fmtMoney } from './format';
import { RiskMeter, ScoreBar } from './RiskMeter';

const STATUS_TEXT: Record<PropositionResult['status'], string> = { holds: 'Holds', refuted: 'Refuted', insufficient: 'Insufficient' };
const DIRECTION_TEXT = { contradicts_claim: 'Contradicts claim', supports_claim: 'Supports claim', neutral: 'Neutral' } as const;
const RUN_TEXT: Record<RunStatus, string> = { queued: 'Queued', running: 'Running', done: 'Done', unavailable: 'Not run', failed: 'Failed' };

function providerText(p?: string) {
  if (!p) return null;
  if (p === 'recorded-fixture') return 'Recorded replay';
  return p;
}

export function ClaimView({ initial, viewer }: { initial: ClaimViewData; viewer: Viewer }) {
  const isOwner = viewer.role === 'owner';
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
  // 早期存档的判定没有记录当时的阈值，按默认值画刻度。
  const cfg = report?.config ?? DEFAULT_CONFIG;
  const signalById = useMemo(() => new Map(data.signals.map((s) => [s.id, s])), [data.signals]);
  const analyzing = data.runs.some((r) => r.status === 'queued' || r.status === 'running');
  const due = dueLabel(data.claim.dueAt);
  const showDeadlineWarning = due.soon && report?.incomplete && data.claim.status !== 'closed';
  const purged = data.evidence.some((e) => e.purgedAt);
  const deleteBlocked =
    data.claim.disputeId && data.claim.status !== 'closed'
      ? 'The PayPal dispute is still open. You can delete after it closes; otherwise you could no longer respond to it in Verdict.'
      : data.actions.some((a) => a.status === 'pending' || a.status === 'unknown' || a.status === 'processing')
        ? 'There are actions with a refund in progress, an unknown result or still running. Reconcile them in the action history first.'
        : analyzing
          ? 'Analysis is still running. Delete later.'
          : null;

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
      <div className="detail-grid">
        <div className="main-col">
          {/* 页头放在左栏里：右侧判定栏从页面顶部开始，一屏内就能看到判定和动作按钮。 */}
          <div className="detail-head">
            <div className="page-head">
              <div>
                <p className="crumb">
                  <Link href="/claims">Claims</Link> / {scenario?.title ?? data.order.orderNo}
                </p>
                <h1>
                  {data.order.orderNo} · {item?.title}
                  {item && item.quantity > 1 ? ` ×${item.quantity}` : ''}
                </h1>
                <div className="case-meta">
                  <span className="badge">{CLAIM_TYPE_LABEL[data.claim.type]}</span>
                  <span className="badge">{ORIGIN_LABEL[data.claim.origin]}</span>
                  <span className="badge">{STATUS_LABEL[data.claim.status]}</span>
                  {data.paypal.env === 'sandbox' && <span className="badge badge-warn">PayPal sandbox</span>}
                  {data.paypal.status && (
                    <span className="badge mono">
                      {data.paypal.status} · {data.paypal.stage}
                    </span>
                  )}
                  <span className="amount">{fmtMoney(data.order.amount, data.order.currency)}</span>
                  {data.claim.dueAt && (
                    <span className={due.soon ? 'due-soon' : 'muted'} suppressHydrationWarning>
                      PayPal due: {due.text}
                    </span>
                  )}
                </div>
              </div>
              <div className="row no-print">
                <button
                  className="btn"
                  onClick={reanalyze}
                  disabled={reanalyzing || analyzing || purged}
                  title={purged ? 'Original evidence was deleted per the retention period and cannot be reanalyzed' : undefined}
                >
                  {analyzing ? 'Analyzing…' : 'Reanalyze'}
                </button>
                <Link className="btn" href={`/orders/${data.order.id}`}>
                  Orders & references
                </Link>
                {report && (
                  <Link className="btn" href={`/claims/${id}/report`}>
                    Verification report
                  </Link>
                )}
              </div>
            </div>

            {scenario && (
              <div className="scenario">
                <span className="badge badge-sim">Demo case</span>
                <span>
                  <strong>{scenario.title}.</strong> {scenario.story} <strong>Expected:</strong>{' '}
                  {scenario.expected}.
                </span>
              </div>
            )}
            {data.paypal.captureWarning && (
              <p className="notice" style={{ marginBottom: 14 }}>
                {data.paypal.captureWarning}
              </p>
            )}
            {data.paypal.error && (
              <div className="notice notice-danger" style={{ marginBottom: 14 }}>
                Can't read the status of this PayPal dispute right now. Actions are paused: {data.paypal.error}
              </div>
            )}
            {showDeadlineWarning && (
              <div className="notice notice-danger" style={{ marginBottom: 14 }}>
                The PayPal response deadline is close and some checks are still incomplete. The verdict below is based only on completed signals.
              </div>
            )}

          </div>
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
              <h2>
                Findings ({report.findings.length})
              </h2>
              {report.findings.length === 0 && <p className="muted">The completed analyzers produced no signals.</p>}
              {report.findings.map((f) => (
                <button
                  key={f.signalIds[0]}
                  className={`finding d-${f.direction} ${activeFinding === f.signalIds[0] ? 'selected' : ''}`}
                  onClick={() => selectFinding(f)}
                >
                  <div className="finding-head">
                    <strong>{f.title}</strong>
                    {f.hardRule && <span className="badge level-high">Hard rule</span>}
                    <span className={`badge dir-${f.direction}`}>{DIRECTION_TEXT[f.direction]}</span>
                    <span className="badge">Strength: {STRENGTH_LABEL[f.strength]}</span>
                    <span className="muted small">{ANALYZER_LABEL[f.analyzer].name}</span>
                    {providerText(f.provider) && <span className="badge badge-sim">{providerText(f.provider)}</span>}
                    {f.contribution !== 0 && (
                      <span className={`finding-contrib ${f.contribution > 0 ? 'contrib-pos' : 'contrib-neg'}`} title="This finding's contribution to R">
                        {f.contribution > 0 ? `+${f.contribution.toFixed(2)}` : f.contribution.toFixed(2)}
                      </span>
                    )}
                  </div>
                  <div>{f.explanation}</div>
                  <ReuseComparison raw={signalById.get(f.signalIds[0])?.raw} currentId={f.region?.evidenceId ?? f.evidenceIds[0]} currentOrder={data.order.orderNo} />
                  {f.normalExplanations.length > 0 && (
                    <div className="explain">
                      Innocent explanations to rule out:
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
              <h2>
                Checks
              </h2>
              {report.propositions.map((p) => {
                const signals = [...p.supportingSignalIds, ...p.refutingSignalIds].map((sid) => signalById.get(sid)?.code).filter(Boolean);
                return (
                  <div className="prop" key={p.id}>
                    <span className={`badge status-${p.status}`} style={{ justifySelf: 'start' }}>
                      {STATUS_TEXT[p.status]}
                    </span>
                    <div>
                      {p.label}
                      {p.key && <span className="muted small"> (key)</span>}
                      {(p.note || signals.length > 0) && (
                        <div className="muted small">
                          {p.note}
                          {p.note && signals.length > 0 ? ' · ' : ''}
                          {signals.join(', ')}
                        </div>
                      )}
                    </div>
                    <div className="row">
                      {p.layers.map((l) => (
                        <span key={l} className={`tier tier-${l}`} title={`Evidence tier ${l}`}>
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
            <h2>
              Buyer statement
            </h2>
            <p style={{ whiteSpace: 'pre-wrap' }}>{data.claim.narrative || <span className="muted">The buyer hasn't filled this in yet.</span>}</p>
          </section>

          <section className="card card-pad">
            <h2>
              Timeline
            </h2>
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
                <summary>Audit trail</summary>
                <p className="muted small" style={{ marginTop: 8 }}>
                  Rules version {report.rulesVersion} · Verdict ID {data.verdict!.id}
                </p>
                <p className="muted small">Weight config: {describeConfig(report.config)}</p>
                <h3 style={{ marginTop: 10 }}>Rule trace</h3>
                <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
                  {report.ruleTrace.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
                <h3 style={{ marginTop: 10 }}>Raw signal data</h3>
                <pre className="raw">{JSON.stringify(data.signals, null, 2)}</pre>
              </details>
            </section>
          )}

          <DeleteClaim claimId={data.claim.id} blocked={isOwner ? deleteBlocked : 'Only the owner can delete claim data.'} />
        </div>

        <aside className="side">
          {report ? (
            <section className="card verdict-card">
              <div className={`verdict-band level-${report.level}`}>
                <div className="verdict-level">{LEVEL_LABEL[report.level]}</div>
                <div className="verdict-headline">{report.headline}</div>
                {(report.incomplete || report.qualityNotice) && (
                  <div className="row" style={{ marginTop: 8 }}>
                    {report.incomplete && <span className="badge badge-warn">Verification incomplete</span>}
                    {report.qualityNotice && <span className="badge badge-warn">Possible quality or fulfillment issue</span>}
                  </div>
                )}
              </div>
              <RiskMeter score={report.score} medium={cfg.riskMedium} high={cfg.riskHigh} level={report.level} />
              <div className="bars">
                <ScoreBar
                  label="Confidence Q"
                  value={report.dataConfidence}
                  mark={cfg.minDataConfidence}
                  title="Share of key propositions covered by tier A/B evidence × share of analyzers completed. The line marks the minimum needed for a verdict"
                />
                <ScoreBar
                  label="Merchant risk M"
                  value={report.merchantRisk}
                  mark={cfg.merchantRiskHigh}
                  title="Likelihood of a product quality or fulfillment issue. The line marks the alert threshold"
                />
              </div>
              <div className="card-pad">
                {report.topSignalIds.length > 0 && (
                  <>
                    <h3 style={{ marginBottom: 4 }}>
                      Top signals
                    </h3>
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
                    <h3 style={{ marginBottom: 4 }}>
                      Evidence gaps
                    </h3>
                    {report.missingShots.map((s) => (
                      <div key={s} className="check-line check-miss">
                        <i>✕</i>Missing: {SHOT_LABEL[s] ?? s}
                      </div>
                    ))}
                    {report.lowTierShots.map((s) => (
                      <div key={s} className="check-line check-weak">
                        <i>△</i>Gallery or imported only: {SHOT_LABEL[s] ?? s}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          ) : data.shadow && data.verdict ? (
            <section className="card card-pad">
              <div className="between">
                <h2>Shadow mode</h2>
                <span className="badge badge-sim">Verdict hidden</span>
              </div>
              <p className="muted small">
                The verdict has been computed and stored in the background but is not shown to the person handling the claim. Decide based on the evidence, order and buyer statement. Your decision is compared with the verdict, and the owner sees the agreement rate on the Shadow mode page.
              </p>
            </section>
          ) : (
            <section className="card card-pad">
              <h2>Waiting for evidence</h2>
              <p className="muted">Analysis starts automatically once the buyer submits.</p>
            </section>
          )}

          {data.verdict && data.rulesOutdated && data.claim.status !== 'closed' && (
            <div className="notice notice-info no-print">
              <strong>Verdict rules have been updated.</strong>
              This verdict was computed with the old rules, so refund, accept claim and offer are unavailable for now. Click Reanalyze at the top of the page to recompute with the new rules, then decide.
            </div>
          )}

          {data.verdict && (
            <ActionPanel
              key={data.verdict.id}
              claimId={id}
              verdictId={data.verdict.id}
              options={data.actionOptions}
              shadow={data.shadow}
              claim={data.claim}
              order={data.order}
              allowed={data.allowedActions}
              actions={data.actions}
              paypal={data.paypal}
              canConfirmFunds={isOwner}
              onDone={refresh}
            />
          )}

          {isOwner && data.paypal.env === 'sandbox' && data.claim.disputeId && data.claim.status !== 'closed' && (
            <SandboxTools claimId={id} links={data.paypal.sandboxTools} onDone={refresh} />
          )}

          {data.runs.length > 0 && (
            <section className="card card-pad">
              <h2>
                Analyzers
              </h2>
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
function ReuseComparison({ raw, currentId, currentOrder }: { raw: unknown; currentId?: string; currentOrder: string }) {
  const match = raw as { matchedEvidenceId?: string; matchedOrder?: string; hammingDistance?: number } | null | undefined;
  if (!match?.matchedEvidenceId) return null;
  return (
    <div className="compare">
      {currentId && (
        <figure>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/evidence/${currentId}/file`} alt="Evidence submitted for this claim" loading="lazy" />
          <figcaption>
            <b>This claim</b>
            <span className="mono">{currentOrder}</span>
          </figcaption>
        </figure>
      )}
      {currentId && (
        <div className="compare-link">
          <i aria-hidden="true">≈</i>
          Same image
          {typeof match.hammingDistance === 'number' && <span>Difference {match.hammingDistance}/256</span>}
        </div>
      )}
      <figure>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/api/evidence/${match.matchedEvidenceId}/file`} alt={`Past evidence from order ${match.matchedOrder}`} loading="lazy" />
        <figcaption>
          <b>Past evidence</b>
          <span className="mono">{match.matchedOrder}</span>
        </figcaption>
      </figure>
    </div>
  );
}

/** 视频的第一帧，用作缩略图和播放器封面。 */
function framesOf(all: PublicEvidence[], videoId: string): PublicEvidence[] {
  return all.filter((e) => e.kind === 'frame' && e.parentId === videoId).sort((a, b) => frameAt(a) - frameAt(b));
}
const frameAt = (e: PublicEvidence) => Number(e.captureMeta?.atMs ?? 0);
const fileUrl = (id: string) => `/api/evidence/${id}/file`;
const secondsText = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

interface VideoInfoView {
  frameExtraction: string;
  reason: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  frames: number;
  sceneCutsMs: number[];
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
        <h2>Evidence</h2>
        <p className="muted">This claim has no image evidence. Verification relies on shipping and transaction records.</p>
      </section>
    );
  }
  // 抽出来的帧不单独占缩略图位置，挂在所属视频下面。
  const top = evidence.filter((e) => e.kind !== 'frame');
  const video = selected?.kind === 'video' ? selected : selected?.kind === 'frame' ? (evidence.find((e) => e.id === selected.parentId) ?? null) : null;
  const frames = video ? framesOf(evidence, video.id) : [];
  const info = (video?.captureMeta?.video ?? null) as VideoInfoView | null;
  const box = highlight && selected && highlight.evidenceId === selected.id ? highlight.bbox : null;
  return (
    <section className="card card-pad">
      <h2>
        Evidence
      </h2>
      {selected && (
        <div className="gallery-main">
          <div className="gallery-frame">
            {selected.kind === 'video' ? (
              selected.purgedAt ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={fileUrl(selected.id)} alt="Original deleted" />
              ) : (
                <video key={selected.id} src={fileUrl(selected.id)} poster={frames[0] ? fileUrl(frames[0].id) : undefined} controls playsInline preload="metadata" />
              )
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={fileUrl(selected.id)} alt={SHOT_LABEL[selected.shotLabel ?? ''] ?? 'Evidence image'} />
            )}
            {box && (
              <div
                className="bbox"
                style={{ left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${box[2] * 100}%`, height: `${box[3] * 100}%` }}
              />
            )}
          </div>
        </div>
      )}
      {video && frames.length > 0 && (
        <>
          <div className="muted small" style={{ marginTop: 10 }}>
            Extracted frames ({frames.length}): taken at fixed intervals plus scene changes. The other analyzers look at these frames
          </div>
          <div className="thumbs" style={{ marginTop: 4 }}>
            <button className="thumb" aria-pressed={selected?.id === video.id} onClick={() => onSelect(video.id)}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={fileUrl(frames[0].id)} alt="" loading="lazy" />
              <span className="thumb-label">▶ Play video</span>
            </button>
            {frames.map((f) => (
              <button key={f.id} className="thumb" aria-pressed={selected?.id === f.id} onClick={() => onSelect(f.id)}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={fileUrl(f.id)} alt="" loading="lazy" />
                <span className="thumb-label">
                  {secondsText(frameAt(f))}
                  {f.captureMeta?.reason === 'scene' ? ' · cut' : ''}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      {top.length > 0 && <Thumbs title={`Buyer evidence (${top.length})`} items={top} all={evidence} selected={video ?? selected} onSelect={onSelect} />}
      {references.length > 0 && <Thumbs title={`Reference photos (${references.length})`} items={references} all={references} selected={selected} onSelect={onSelect} />}
      {selected && (
        <dl className="meta-grid">
          <div>
            <dt>Shot</dt>
            <dd>{SHOT_LABEL[selected.shotLabel ?? ''] ?? selected.shotLabel ?? 'Unlabeled'}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>
              <span className={`tier tier-${selected.layer}`}>{selected.layer}</span> {SOURCE_LABEL[selected.source as SourceMark]}
            </dd>
          </div>
          <div>
            <dt>Uploaded</dt>
            <dd>{fmtDateTime(selected.createdAt)}</dd>
          </div>
          {selected.kind === 'frame' && (
            <div>
              <dt>Video frame</dt>
              <dd>
                At {secondsText(frameAt(selected))}
                {selected.captureMeta?.reason === 'scene' ? ' (scene change)' : ' (fixed interval)'}
              </dd>
            </div>
          )}
          {info && (
            <div>
              <dt>Video</dt>
              <dd>
                {info.durationMs ? secondsText(info.durationMs) : 'Unknown duration'}
                {info.width && info.height ? ` · ${info.width}×${info.height}` : ''}
                {info.frameExtraction === 'ok' ? ` · ${info.frames} frames extracted` : ` · No frames extracted: ${info.reason ?? 'unknown reason'}`}
                {info.sceneCutsMs.length > 0 ? ` · Scene changes ${info.sceneCutsMs.map(secondsText).join(', ')}` : ''}
              </dd>
            </div>
          )}
          {selected.purgedAt && (
            <div>
              <dt>Original</dt>
              <dd>Deleted {fmtDateTime(selected.purgedAt)} per retention period</dd>
            </div>
          )}
          <div>
            <dt>SHA-256</dt>
            <dd className="mono" title={selected.sha256}>
              {selected.sha256.slice(0, 16)}…
            </dd>
          </div>
          {selected.challenge && (
            <div>
              <dt>Challenge</dt>
              <dd>
                <span className="mono">{selected.challenge.code}</span> · {selected.challenge.action}
              </dd>
            </div>
          )}
          {typeof selected.captureMeta?.durationMs === 'number' && (
            <div>
              <dt>Capture time</dt>
              <dd className="num">{Math.round((selected.captureMeta.durationMs as number) / 1000)} s</dd>
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
  all,
  selected,
  onSelect,
}: {
  title: string;
  items: PublicEvidence[];
  all: PublicEvidence[];
  selected: PublicEvidence | null;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      <div className="muted small" style={{ marginTop: 10 }}>
        {title}
      </div>
      <div className="thumbs" style={{ marginTop: 4 }}>
        {items.map((e) => {
          const cover = e.kind === 'video' ? framesOf(all, e.id)[0] : e;
          return (
            <button key={e.id} className="thumb" aria-pressed={selected?.id === e.id} onClick={() => onSelect(e.id)}>
              {cover ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={fileUrl(cover.id)} alt="" loading="lazy" />
              ) : (
                <span className="thumb-video">Video</span>
              )}
              <span className={`tier tier-${e.layer}`}>{e.layer}</span>
              <span className="thumb-label">
                {e.kind === 'video' ? '▶ ' : ''}
                {SHOT_LABEL[e.shotLabel ?? ''] ?? e.shotLabel ?? 'Unlabeled'}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}
