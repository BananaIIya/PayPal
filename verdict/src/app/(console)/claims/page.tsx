import Link from 'next/link';
import { ClaimList } from '@/components/ClaimList';
import { PayPalSyncButton } from '@/components/PayPalSyncButton';
import { publicPayPalStatus } from '@/paypal/config';
import { ready } from '@/server/bootstrap';
import { pageUser } from '@/server/guard';
import { defaultMerchantId, listClaims } from '@/server/repo';
import { maskClaimList } from '@/server/shadow';

export const dynamic = 'force-dynamic';

export default async function ClaimsPage() {
  await ready();
  await pageUser();
  const { claims, shadow } = maskClaimList(defaultMerchantId(), listClaims());
  const open = claims.filter((c) => c.status !== 'closed');
  const now = Date.now();
  const dueSoon = open.filter((c) => c.dueAt && new Date(c.dueAt).getTime() - now < 48 * 3600000).length;
  const highRisk = open.filter((c) => c.level === 'high').length;
  // 金额按币种分开合计，多币种时只显示笔数最多的那个，其余在说明里带过。
  const byCurrency = new Map<string, number>();
  for (const c of open) byCurrency.set(c.currency, (byCurrency.get(c.currency) ?? 0) + c.amount);
  const [mainCurrency, mainAmount] = [...byCurrency.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['USD', 0];
  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            Claims
          </h1>
          {shadow && <p className="muted">Shadow mode is on. Verdicts are hidden.</p>}
        </div>
        <div className="row">
          {publicPayPalStatus().state === 'ready' && <PayPalSyncButton />}
          <Link className="btn" href="/orders">
            New claim link
          </Link>
          <Link className="btn btn-primary" href="/claims/new">
            Manual import
          </Link>
        </div>
      </div>
      <div className="kpis">
        <div className="kpi">
          <div className="kpi-label">
            Open
          </div>
          <div className="kpi-value">{open.length}</div>
          <div className="kpi-note">{claims.length} claims total</div>
        </div>
        <div className={`kpi ${dueSoon > 0 ? 'kpi-alert' : ''}`}>
          <div className="kpi-label">
            Due within 48 h
          </div>
          <div className="kpi-value">{dueSoon}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">
            {shadow ? 'Closed' : 'High risk to review'}
          </div>
          <div className="kpi-value">{shadow ? claims.length - open.length : highRisk}</div>

        </div>
        <div className="kpi">
          <div className="kpi-label">
            Open amount
          </div>
          <div className="kpi-value">
            <small>{mainCurrency}</small>
            {mainAmount.toFixed(2)}
          </div>
          {byCurrency.size > 1 && <div className="kpi-note">{byCurrency.size - 1} more currencies not included</div>}
        </div>
      </div>
      <ClaimList claims={claims} shadow={shadow} />
    </>
  );
}
