import Link from 'next/link';
import { TestOrderForm } from '@/components/TestOrderForm';
import { fmtMoney } from '@/components/format';
import { publicPayPalStatus } from '@/paypal/config';
import { ready } from '@/server/bootstrap';
import { pageUser } from '@/server/guard';
import { listOrders } from '@/server/repo';
import { TEST_PRODUCTS } from '@/server/sandbox-shop';

export const dynamic = 'force-dynamic';

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ paypal_error?: string }> }) {
  await ready();
  const viewer = await pageUser();
  const { paypal_error: paypalError } = await searchParams;
  const sandboxReady = publicPayPalStatus().state === 'ready';
  const orders = listOrders();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Orders &amp; references</h1>
        </div>
      </div>
      {paypalError && (
        <p className="notice notice-danger" style={{ marginBottom: 14 }}>
          PayPal payment was not completed: {paypalError}
        </p>
      )}
      {sandboxReady && viewer.role === 'owner' && <TestOrderForm products={TEST_PRODUCTS.map((p) => ({ key: p.key, title: p.title, amount: p.amount }))} />}
      <div className="card table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Order</th>
              <th>Item</th>
              <th>Amount</th>
              <th>Buyer</th>
              <th>Tracking number</th>
              <th>Shipping weight</th>
              <th>References</th>
              <th>Claims</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td>
                  <Link href={`/orders/${o.id}`}>
                    <strong>{o.orderNo}</strong>
                  </Link>
                  {o.paypalEnv === 'sandbox' && (
                    <span className="badge badge-warn" style={{ marginLeft: 6 }}>
                      {o.paid ? 'Sandbox' : 'Sandbox · Unpaid'}
                    </span>
                  )}
                </td>
                <td>{o.product}</td>
                <td className="num">{fmtMoney(o.amount, o.currency)}</td>
                <td>{o.buyerName}</td>
                <td className="mono">{o.trackingNumber ?? '—'}</td>
                <td className="num">{o.shippedWeightG ? `${o.shippedWeightG}g` : '—'}</td>
                <td className="num">{o.referenceCount}</td>
                <td className="num">{o.claimCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
