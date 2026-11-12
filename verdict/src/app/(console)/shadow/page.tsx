import Link from 'next/link';
import { fmtDateTime } from '@/components/format';
import { LEVEL_LABEL } from '@/core/catalog';
import { ready } from '@/server/bootstrap';
import { pageUser } from '@/server/guard';
import { defaultMerchantId } from '@/server/repo';
import { DECISION_LABEL, shadowComparison, type Decision } from '@/server/shadow';

export const dynamic = 'force-dynamic';

const DECISIONS: Decision[] = ['refund', 'offer', 'contest', 'ask', 'review'];
const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`);

/**
 * 影子对照：处理人员的决定和当时的判定放在一起看。只有店主能看——
 * 影子模式期间如果处理人员能看到判定，之后的决定就不再是“盲评”了。
 */
export default async function ShadowPage({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  await ready();
  const viewer = await pageUser();
  if (viewer.role !== 'owner') {
    return (
      <div className="card card-pad">
        <h1>Shadow mode</h1>
        <p className="muted">Only the owner can view this page.</p>
      </div>
    );
  }
  const merchantId = defaultMerchantId();
  if (!merchantId) return <p className="muted">No merchant data.</p>;
  const { all } = await searchParams;
  const c = shadowComparison(merchantId, all === '1' ? { blindOnly: false } : {});
  const used = c.rows.length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Shadow mode</h1>
          <p className="muted">
            Each agent's first substantive decision (refund, offer, contest) compared with the verdict's recommendation at the time.
          </p>
        </div>
        <div className="row">
          <span className={`badge ${c.shadowMode ? 'badge-accent' : 'badge-sim'}`}>{c.shadowMode ? 'Shadow mode on' : 'Shadow mode off'}</span>
          <Link className="btn" href="/settings">
            {c.shadowMode ? 'Turn off in Settings' : 'Turn on in Settings'}
          </Link>
        </div>
      </div>

      {!c.blindOnly && c.blindDecided === 0 && (
        <p className="notice" style={{ marginBottom: 14 }}>
          No decisions made in shadow mode yet, so the numbers below include all decisions. Agents could see the verdict at the time, so agreement will be inflated. Use it as a reference only.
        </p>
      )}
      <div className="row" style={{ marginBottom: 14 }}>
        <span className="muted small">
          {c.totalDecided} claims with decisions, {c.blindDecided} made in shadow mode. Showing {c.blindOnly ? 'shadow mode decisions' : 'all decisions'}.
        </span>
        {c.blindDecided > 0 && (
          <Link className="small" href={c.blindOnly ? '/shadow?all=1' : '/shadow'}>
            {c.blindOnly ? 'Show all decisions' : 'Show shadow mode only'}
          </Link>
        )}
      </div>

      <section className="card" style={{ marginBottom: 14 }}>
        <div className="scores" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', borderBottom: 0 }}>
          <div>
            <b>{used}</b>
            <span>Decisions counted</span>
          </div>
          <div>
            <b>{pct(c.agreementRate)}</b>
            <span>Agree with recommendation</span>
          </div>
          <div title="System recommended contesting but the agent refunded, or system recommended a refund but the agent contested">
            <b>{c.opposite}</b>
            <span>Opposite direction</span>
          </div>
        </div>
      </section>

      <div className="two-col" style={{ marginBottom: 14 }}>
        <section className="card card-pad">
          <h2>Verdict level × agent decision</h2>
          <div className="table-wrap">
            <table className="data" style={{ minWidth: 0 }}>
              <thead>
                <tr>
                  <th>Verdict</th>
                  {DECISIONS.map((d) => (
                    <th key={d} className="num">
                      {DECISION_LABEL[d]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {c.byLevel.map((l) => (
                  <tr key={l.level}>
                    <td>
                      <span className={`badge level level-${l.level}`}>{l.label}</span>
                    </td>
                    {DECISIONS.map((d) => (
                      <td key={d} className="num">
                        {c.matrix[l.level][d] || <span className="muted">0</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card card-pad">
          <h2>Agreement by verdict level</h2>
          {c.byLevel.map((l) => (
            <div className="signal-line" key={l.level}>
              <span>
                {l.label}
                <span className="muted small"> ({l.total})</span>
              </span>
              <span className="num">{l.total ? pct(l.agree / l.total) : '—'}</span>
            </div>
          ))}
          <p className="muted small" style={{ marginTop: 10 }}>
            High risk verdicts that were refunded and Low risk verdicts that were contested are worth reviewing one by one: the verdict may be wrong, or the agent may have known something the system did not.
          </p>
        </section>
      </div>

      <section className="card table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Order</th>
              <th>Verdict</th>
              <th>Recommendation</th>
              <th>Agent decision</th>
              <th>Result</th>
              <th>Decided by</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {c.rows.map((r) => (
              <tr key={r.claimId}>
                <td>
                  <Link href={`/claims/${r.claimId}`}>{r.orderNo}</Link>
                  <div className="muted small">{r.product}</div>
                </td>
                <td>
                  <span className={`badge level level-${r.level}`}>{LEVEL_LABEL[r.level]}</span>
                </td>
                <td>{DECISION_LABEL[r.system]}</td>
                <td>
                  {DECISION_LABEL[r.merchant]}
                  {!r.shadow && <span className="muted small"> (verdict visible)</span>}
                </td>
                <td>
                  <span className={`badge ${r.agree ? 'level-low' : r.opposite ? 'level-high' : 'badge-warn'}`}>{r.agree ? 'Agree' : r.opposite ? 'Opposite' : 'Disagree'}</span>
                </td>
                <td>{r.decidedBy}</td>
                <td className="muted small">{fmtDateTime(r.decidedAt)}</td>
              </tr>
            ))}
            {c.rows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 28 }}>
                  No decisions to compare yet. After shadow mode is on, actions agents take on claim pages appear here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
