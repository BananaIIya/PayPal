import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ANALYZER_LABEL, CLAIM_TYPE_LABEL, describeConfig, LEVEL_LABEL, SHOT_LABEL, SOURCE_LABEL, STRENGTH_LABEL } from '@/core/catalog';
import { PORTAL_LINK_PLACEHOLDER } from '@/core/recommend';
import { PrintButton } from '@/components/PrintButton';
import { fmtDateTime, fmtMoney } from '@/components/format';
import { ready } from '@/server/bootstrap';
import { pageUser } from '@/server/guard';
import { claimView } from '@/server/views';

export const dynamic = 'force-dynamic';

const STATUS = { holds: '成立', refuted: '不成立', insufficient: '证据不足' } as const;

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
          <Link href={`/claims/${id}`}>← 返回索赔</Link>
        </p>
        <div className="card card-pad">
          <h1>核验报告</h1>
          <p className="muted">现在是影子模式：判定照常计算并存档，但不给处理人员看，所以也不出报告。店主可以在设置页关闭影子模式。</p>
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
        <Link href={`/claims/${id}`}>← 返回索赔</Link>
        <div className="row">
          <a className="btn" href={`/api/claims/${id}/report.pdf`} target="_blank" rel="noreferrer">
            下载 PDF
          </a>
          <a className="btn" href={`/api/claims/${id}/report.pdf?audience=paypal`} target="_blank" rel="noreferrer" title="随证据提交给 PayPal 的版本：不含商家侧风险、内部提示、草稿和行为分析">
            预览提交版
          </a>
          <PrintButton />
        </div>
      </div>
      <div className="card card-pad" style={{ padding: 28 }}>
        <h1 style={{ marginBottom: 4 }}>核验报告</h1>
        <p className="muted" style={{ marginBottom: 20 }}>
          订单 {v.order.orderNo} · {v.order.items[0]?.title} · {fmtMoney(v.order.amount, v.order.currency)} · {CLAIM_TYPE_LABEL[v.claim.type]}
          <br />
          生成时间 {fmtDateTime(v.verdict.createdAt)} · 判定 ID <span className="mono">{v.verdict.id}</span>
        </p>

        <section>
          <h2>结论</h2>
          <p style={{ marginBottom: 6 }}>
            <span className={`badge level level-${r.level}`}>{LEVEL_LABEL[r.level]}</span> {r.headline}
            {r.incomplete && <span className="badge badge-warn" style={{ marginLeft: 6 }}>核验不完整</span>}
          </p>
          <p className="num">
            买家侧风险 R = {r.score.toFixed(2)}，数据置信度 Q = {r.dataConfidence.toFixed(2)}，商家侧风险 M = {r.merchantRisk.toFixed(2)}
          </p>
          <p>
            建议动作：{action.label}。{action.reason}
          </p>
          <p>需要商家决定：{r.decisionNeeded}。</p>
          {r.notices.map((n) => (
            <p key={n}>· {n}</p>
          ))}
        </section>

        <section>
          <h2>命题核验</h2>
          <table className="data">
            <thead>
              <tr>
                <th>命题</th>
                <th>状态</th>
                <th>证据层级</th>
              </tr>
            </thead>
            <tbody>
              {r.propositions.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.label}
                    {p.key ? '（关键）' : ''}
                  </td>
                  <td>{STATUS[p.status]}</td>
                  <td>{p.layers.join('、') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <h2>发现</h2>
          {r.findings.length === 0 && <p className="muted">没有信号。</p>}
          {r.findings.map((f) => (
            <div key={f.signalIds[0]} className={`finding d-${f.direction}`} style={{ cursor: 'default', marginBottom: 8 }}>
              <strong>{f.title}</strong>{' '}
              <span className="muted small">
                {ANALYZER_LABEL[f.analyzer].name} · 强度{STRENGTH_LABEL[f.strength]} · 置信度 {f.confidence.toFixed(2)}
                {f.provider === 'recorded-fixture' ? ' · 录制回放' : f.provider ? ` · ${f.provider}` : ''}
              </span>
              <div>{f.explanation}</div>
              <div className="row" style={{ marginTop: 6 }}>
                {f.evidenceIds
                  .filter((e) => evidenceById.has(e))
                  .map((e) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={e} src={`/api/evidence/${e}/file`} alt={SHOT_LABEL[evidenceById.get(e)!.shotLabel ?? ''] ?? '证据'} style={{ width: 96, height: 72, objectFit: 'cover', borderRadius: 4 }} />
                  ))}
              </div>
              {f.normalExplanations.length > 0 && <div className="explain">需排除的正常解释：{f.normalExplanations.join('；')}</div>}
            </div>
          ))}
        </section>

        <section>
          <h2>证据清单</h2>
          {v.evidence.length === 0 && <p className="muted">没有图片证据。</p>}
          {v.evidence.map((e) => (
            <p key={e.id} className="small">
              {e.layer} 层 · {SOURCE_LABEL[e.source]} · {SHOT_LABEL[e.shotLabel ?? ''] ?? '未标注'} · <span className="mono">{e.sha256.slice(0, 24)}…</span> · {fmtDateTime(e.createdAt)}
            </p>
          ))}
        </section>

        <section>
          <h2>时间线</h2>
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
          <h2>未执行的检查</h2>
          {r.notRun.length === 0 ? (
            <p className="muted">适用的分析器全部完成。</p>
          ) : (
            r.notRun.map((n) => (
              <p key={n.analyzer}>
                {ANALYZER_LABEL[n.analyzer].name}（{ANALYZER_LABEL[n.analyzer].what}）：{n.reason}
              </p>
            ))
          )}
        </section>

        {(action.message || action.notes) && (
          <section>
            <h2>草稿</h2>
            {action.message && <p style={{ whiteSpace: 'pre-wrap' }}>给买家的消息：{action.message.replaceAll(PORTAL_LINK_PLACEHOLDER, '（发送时生成的一次性索赔页链接）')}</p>}
            {action.notes && <p style={{ whiteSpace: 'pre-wrap' }}>说明：{action.notes}</p>}
          </section>
        )}

        <section>
          <h2>审计记录</h2>
          <p className="small">规则版本 {r.rulesVersion}</p>
          <p className="small">权重配置：{describeConfig(r.config)}</p>
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
