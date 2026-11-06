'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { CLAIM_TYPE_LABEL, LEVEL_LABEL, ORIGIN_LABEL, STATUS_LABEL } from '@/core/catalog';
import type { VerdictLevel } from '@/core/types';
import type { ClaimListItem } from '@/server/repo';
import { dueLabel, fmtMoney, fmtScore } from './format';

type Filter = 'all' | VerdictLevel | 'open';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'open', label: '待处理' },
  { id: 'high', label: '高风险' },
  { id: 'medium', label: '中风险' },
  { id: 'insufficient', label: '证据不足' },
  { id: 'low', label: '低风险' },
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
      <div className="filters" role="group" aria-label="筛选">
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
        <table className="data">
          <thead>
            <tr>
              <th>订单</th>
              <th>索赔类型</th>
              <th>来源</th>
              {!shadow && <th>判定</th>}
              {!shadow && <th title="买家侧风险 R / 数据置信度 Q / 商家侧风险 M">R / Q / M</th>}
              <th>PayPal 截止</th>
              <th>状态</th>
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
                        沙箱
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
                        {c.incomplete && c.status !== 'collecting' && <span className="badge badge-warn">核验不完整</span>}
                      </div>
                    </td>
                  )}
                  {!shadow && (
                    <td className="num">
                      {fmtScore(c.score)} / {fmtScore(c.dataConfidence)} / {fmtScore(c.merchantRisk)}
                    </td>
                  )}
                  <td className={due.soon ? 'due-soon' : undefined} suppressHydrationWarning>
                    {due.text}
                  </td>
                  <td>{STATUS_LABEL[c.status]}</td>
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={shadow ? 5 : 7} className="muted" style={{ textAlign: 'center', padding: 28 }}>
                  没有符合条件的索赔
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
