'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { CLAIM_TYPE_LABEL, LEVEL_LABEL, ORIGIN_LABEL, STATUS_LABEL } from '@/core/catalog';
import type { VerdictLevel } from '@/core/types';
import type { ClaimListItem } from '@/server/repo';
import { dueLabel, fmtMoney, fmtScore } from './format';
import { MiniMeter } from './RiskMeter';

type Filter = 'all' | VerdictLevel | 'open';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Open' },
  { id: 'high', label: 'High risk' },
  { id: 'medium', label: 'Medium risk' },
  { id: 'insufficient', label: 'Insufficient evidence' },
  { id: 'low', label: 'Low risk' },
];

/** shadow：影子模式下没有判定可筛选，也不显示判定列。 */
export function ClaimList({ claims, shadow = false }: { claims: ClaimListItem[]; shadow?: boolean }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>('all');
  const shown = useMemo(
    () =>
      claims.filter((c) => {
        if (filter === 'all') return true;
        if (filter === 'open') return c.status !== 'closed';
        return c.level === filter;
      }),
    [claims, filter],
  );

  return (
    <>
      <div className="filters" role="group" aria-label="Filter">
        {(shadow ? FILTERS.filter((f) => f.id === 'all' || f.id === 'open') : FILTERS).map((f) => (
          <button key={f.id} className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label}
            <span className="muted num">
              {' '}
              {f.id === 'all'
                ? claims.length
                : f.id === 'open'
                  ? claims.filter((c) => c.status !== 'closed').length
                  : claims.filter((c) => c.level === f.id).length}
            </span>
          </button>
        ))}
      </div>
      <div className="card table-wrap">
        <table className="data claims-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Claim type</th>
              <th>Source</th>
              {!shadow && <th>Verdict</th>}
              {!shadow && <th title="Buyer risk R / Confidence Q / Merchant risk M">R / Q / M</th>}
              <th>PayPal due</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => {
              const due = dueLabel(c.dueAt);
              return (
                <tr key={c.id} className="link-row" onClick={() => router.push(`/claims/${c.id}`)}>
                  <td>
                    <Link href={`/claims/${c.id}`} onClick={(e) => e.stopPropagation()}>
                      <strong>{c.scenarioTitle ?? c.orderNo}</strong>
                    </Link>
                    {c.paypalEnv === 'sandbox' && (
                      <span className="badge badge-warn" style={{ marginLeft: 6 }}>
                        Sandbox
                      </span>
                    )}
                    <div className="muted small">
                      {c.orderNo} · {c.product} · {fmtMoney(c.amount, c.currency)}
                    </div>
                  </td>
                  <td>{CLAIM_TYPE_LABEL[c.type]}</td>
                  <td>{ORIGIN_LABEL[c.origin]}</td>
                  {!shadow && (
                    <td>
                      <div className="row">
                        {c.level ? <span className={`badge level level-${c.level}`}>{LEVEL_LABEL[c.level]}</span> : <span className="muted">—</span>}
                        {c.incomplete && c.status !== 'collecting' && <span className="badge badge-warn">Verification incomplete</span>}
                      </div>
                    </td>
                  )}
                  {!shadow && (
                    <td>
                      <MiniMeter score={c.score} level={c.level} />
                      <div className="muted small num">
                        Q {fmtScore(c.dataConfidence)} · M {fmtScore(c.merchantRisk)}
                      </div>
                    </td>
                  )}
                  <td className={due.soon ? 'due-soon' : undefined} suppressHydrationWarning>
                    {due.text}
                  </td>
                  <td>
                    <span className={`status-text status-${c.status}`}>{STATUS_LABEL[c.status]}</span>
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={shadow ? 5 : 7} className="muted" style={{ textAlign: 'center', padding: 28 }}>
                  No matching claims
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
