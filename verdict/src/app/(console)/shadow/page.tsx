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
        <h1>影子对照</h1>
        <p className="muted">只有店主可以查看。影子模式期间处理人员看到判定，之后的决定就不能用来评估系统了。</p>
      </div>
    );
  }
  const merchantId = defaultMerchantId();
  if (!merchantId) return <p className="muted">没有商家数据。</p>;
  const { all } = await searchParams;
  const c = shadowComparison(merchantId, all === '1' ? { blindOnly: false } : {});
  const used = c.rows.length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>影子对照</h1>
          <p className="muted">
            每笔索赔取处理人员的第一个实质决定（退款、和解、反驳；都没有时取第一条消息），和执行那一刻的判定建议比较。用来决定能不能正式启用判定，不是给处理人员打分。
          </p>
        </div>
        <div className="row">
          <span className={`badge ${c.shadowMode ? 'badge-accent' : 'badge-sim'}`}>{c.shadowMode ? '影子模式进行中' : '影子模式未开启'}</span>
          <Link className="btn" href="/settings">
            {c.shadowMode ? '去设置页关闭' : '去设置页开启'}
          </Link>
        </div>
      </div>

      {!c.blindOnly && c.blindDecided === 0 && (
        <p className="notice" style={{ marginBottom: 14 }}>
          还没有影子模式下做出的决定，下面统计的是全部决定。处理人员当时看得到判定，一致率会偏高，只能当参考。
        </p>
      )}
      <div className="row" style={{ marginBottom: 14 }}>
        <span className="muted small">
          共 {c.totalDecided} 笔有决定，其中影子模式下 {c.blindDecided} 笔。现在统计{c.blindOnly ? '影子模式下的决定' : '全部决定'}。
        </span>
        {c.blindDecided > 0 && (
          <Link className="small" href={c.blindOnly ? '/shadow?all=1' : '/shadow'}>
            {c.blindOnly ? '改为统计全部' : '只统计影子模式下的'}
          </Link>
        )}
      </div>

      <section className="card" style={{ marginBottom: 14 }}>
        <div className="scores" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', borderBottom: 0 }}>
          <div>
            <b>{used}</b>
            <span>统计的决定</span>
          </div>
          <div>
            <b>{pct(c.agreementRate)}</b>
            <span>和判定建议一致</span>
          </div>
          <div title="系统建议反驳而人工退款，或系统建议退款而人工反驳">
            <b>{c.opposite}</b>
            <span>方向相反</span>
          </div>
        </div>
      </section>

      <div className="two-col" style={{ marginBottom: 14 }}>
        <section className="card card-pad">
          <h2>判定等级 × 人工决定</h2>
          <div className="table-wrap">
            <table className="data" style={{ minWidth: 0 }}>
              <thead>
                <tr>
                  <th>判定</th>
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
          <h2>按判定等级的一致率</h2>
          {c.byLevel.map((l) => (
            <div className="signal-line" key={l.level}>
              <span>
                {l.label}
                <span className="muted small">（{l.total} 笔）</span>
              </span>
              <span className="num">{l.total ? pct(l.agree / l.total) : '—'}</span>
            </div>
          ))}
          <p className="muted small" style={{ marginTop: 10 }}>
            高风险判定被人工退款、低风险判定被人工反驳最值得逐笔看：可能是判定错了，也可能是处理人员掌握了系统没有的信息。
          </p>
        </section>
      </div>

      <section className="card table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>订单</th>
              <th>判定</th>
              <th>判定建议</th>
              <th>人工决定</th>
              <th>结果</th>
              <th>决定人</th>
              <th>时间</th>
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
                  {!r.shadow && <span className="muted small">（看得到判定）</span>}
                </td>
                <td>
                  <span className={`badge ${r.agree ? 'level-low' : r.opposite ? 'level-high' : 'badge-warn'}`}>{r.agree ? '一致' : r.opposite ? '方向相反' : '不一致'}</span>
                </td>
                <td>{r.decidedBy}</td>
                <td className="muted small">{fmtDateTime(r.decidedAt)}</td>
              </tr>
            ))}
            {c.rows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 28 }}>
                  还没有可以对照的决定。开启影子模式后，处理人员在索赔页执行动作，这里就会出现记录。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
