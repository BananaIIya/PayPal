import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ANALYZER_LABEL, CLAIM_TYPE_LABEL, describeConfig, LEVEL_LABEL, SHOT_LABEL, SOURCE_LABEL, STRENGTH_LABEL } from '@/core/catalog';
import { PORTAL_LINK_PLACEHOLDER } from '@/core/recommend';
import { Brand } from '@/components/Brand';
import { PrintButton } from '@/components/PrintButton';
import { fmtDateTime, fmtMoney } from '@/components/format';
import { ready } from '@/server/bootstrap';
import { pageUser } from '@/server/guard';
import { claimView } from '@/server/views';

export const dynamic = 'force-dynamic';

const STATUS = { holds: 'Holds', refuted: 'Refuted', insufficient: 'Insufficient' } as const;

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  await ready();
  await pageUser();
  const { id } = await params;
  const v = await claimView(id);
  if (!v || !v.verdict) notFound();
  if (!v.verdict.report) {
    return (
      <div className="report">
        <p className="no-print" style={{ marginBottom: 16 }}>
          <Link href={`/claims/${id}`}>← Back to claim</Link>
        </p>
        <div className="card card-pad">
          <h1>Verification report</h1>
          <p className="muted">Shadow mode is on: the verdict is computed and stored as usual but not shown to the person handling the claim, so no report is generated. The owner can turn off shadow mode in Settings.</p>
        </div>
      </div>
    );
  }
  const r = v.verdict.report;
  const action = r.primaryAction;
  const evidenceById = new Map(v.evidence.map((e) => [e.id, e]));

  return (
    <div className="report">
      <div className="between no-print" style={{ marginBottom: 16 }}>
        <Link href={`/claims/${id}`}>← Back to claim</Link>
        <div className="row">
          <a className="btn" href={`/api/claims/${id}/report.pdf`} target="_blank" rel="noreferrer">
            Download PDF
          </a>
          <a className="btn" href={`/api/claims/${id}/report.pdf?audience=paypal`} target="_blank" rel="noreferrer" title="The version submitted to PayPal with the evidence: no merchant risk, internal notices, drafts or behavior analysis">
            Preview PayPal version
          </a>
          <PrintButton />
        </div>
      </div>
      <div className="card report-sheet">
        <header className="report-head">
          <div>
            <div className="brand" style={{ marginBottom: 14 }}>
              <Brand ink="#ffffff" />
            </div>
            <h1>Verification report</h1>
            <p className="muted">
              {v.order.items[0]?.title} · {CLAIM_TYPE_LABEL[v.claim.type]}
            </p>
          </div>
          <div className="report-meta">
            <div>
              Order <b>{v.order.orderNo}</b>
            </div>
            <div>
              Amount <b className="num">{fmtMoney(v.order.amount, v.order.currency)}</b>
            </div>
            <div>Generated {fmtDateTime(v.verdict.createdAt)}</div>
            <div>
              Verdict ID <span className="mono">{v.verdict.id}</span>
            </div>
          </div>
        </header>

        <section>
          <h2>
            Conclusion
          </h2>
          <div className="report-verdict">
            <div className={`verdict-band level-${r.level}`}>
              <div className="verdict-level">{LEVEL_LABEL[r.level]}</div>
              <div className="verdict-headline">
                {r.headline}
                {r.incomplete && <span className="badge badge-warn" style={{ marginLeft: 6 }}>Verification incomplete</span>}
              </div>
            </div>
          </div>
          <p className="num">
            Buyer risk R = {r.score.toFixed(2)}, Confidence Q = {r.dataConfidence.toFixed(2)}, Merchant risk M = {r.merchantRisk.toFixed(2)}
          </p>
          <p>
            Recommended action: {action.label}. {action.reason}
          </p>
          <p>Decision needed: {r.decisionNeeded}.</p>
          {r.notices.map((n) => (
            <p key={n}>· {n}</p>
          ))}
        </section>

        <section>
          <h2>
            Checks
          </h2>
          <table className="data">
            <thead>
              <tr>
                <th>Proposition</th>
                <th>Status</th>
                <th>Evidence tier</th>
              </tr>
            </thead>
            <tbody>
              {r.propositions.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.label}
                    {p.key ? ' (key)' : ''}
                  </td>
                  <td>{STATUS[p.status]}</td>
                  <td>{p.layers.join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <h2>
            Findings
          </h2>
          {r.findings.length === 0 && <p className="muted">No signals.</p>}
          {r.findings.map((f) => (
            <div key={f.signalIds[0]} className={`finding d-${f.direction}`} style={{ cursor: 'default', marginBottom: 8 }}>
              <strong>{f.title}</strong>{' '}
              <span className="muted small">
                {ANALYZER_LABEL[f.analyzer].name} · Strength: {STRENGTH_LABEL[f.strength]} · Confidence {f.confidence.toFixed(2)}
                {f.provider === 'recorded-fixture' ? ' · Recorded replay' : f.provider ? ` · ${f.provider}` : ''}
              </span>
              <div>{f.explanation}</div>
              <div className="row" style={{ marginTop: 6 }}>
                {f.evidenceIds
                  .filter((e) => evidenceById.has(e))
                  .map((e) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={e} src={`/api/evidence/${e}/file`} alt={SHOT_LABEL[evidenceById.get(e)!.shotLabel ?? ''] ?? 'Evidence'} style={{ width: 96, height: 72, objectFit: 'cover', borderRadius: 4 }} />
                  ))}
              </div>
              {f.normalExplanations.length > 0 && <div className="explain">Innocent explanations to rule out: {f.normalExplanations.join('; ')}</div>}
            </div>
          ))}
        </section>

        <section>
          <h2>
            Evidence
          </h2>
          {v.evidence.length === 0 && <p className="muted">No image evidence.</p>}
          {v.evidence.map((e) => (
            <p key={e.id} className="small">
              Tier {e.layer} · {SOURCE_LABEL[e.source]} · {SHOT_LABEL[e.shotLabel ?? ''] ?? 'Unlabeled'} · <span className="mono">{e.sha256.slice(0, 24)}…</span> · {fmtDateTime(e.createdAt)}
            </p>
          ))}
        </section>

        <section>
          <h2>
            Timeline
          </h2>
          <ol className="timeline">
            {v.timeline.map((t, i) => (
              <li key={i}>
                <time>{fmtDateTime(t.at)}</time>
                <div>
                  {t.title}
                  {t.detail ? ` · ${SHOT_LABEL[t.detail] ?? t.detail}` : ''}
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section>
          <h2>
            Checks not run
          </h2>
          {r.notRun.length === 0 ? (
            <p className="muted">All applicable analyzers completed.</p>
          ) : (
            r.notRun.map((n) => (
              <p key={n.analyzer}>
                {ANALYZER_LABEL[n.analyzer].name} ({ANALYZER_LABEL[n.analyzer].what}): {n.reason}
              </p>
            ))
          )}
        </section>

        {(action.message || action.notes) && (
          <section>
            <h2>
            Draft
          </h2>
            {action.message && <p style={{ whiteSpace: 'pre-wrap' }}>Message to buyer: {action.message.replaceAll(PORTAL_LINK_PLACEHOLDER, '(one-time claim page link generated when sent)')}</p>}
            {action.notes && <p style={{ whiteSpace: 'pre-wrap' }}>Notes: {action.notes}</p>}
          </section>
        )}

        <section>
          <h2>
            Audit trail
          </h2>
          <p className="small">Rules version {r.rulesVersion}</p>
          <p className="small">Weight config: {describeConfig(r.config)}</p>
          {r.ruleTrace.map((t) => (
            <p key={t} className="small">
              · {t}
            </p>
          ))}
        </section>
      </div>
    </div>
  );
}
