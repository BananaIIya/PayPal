import Link from 'next/link';
import { TestOrderForm } from '@/components/TestOrderForm';
import { fmtMoney } from '@/components/format';
import { publicPayPalStatus } from '@/paypal/config';
import { ready } from '@/server/bootstrap';
import { listOrders } from '@/server/repo';
import { TEST_PRODUCTS } from '@/server/sandbox-shop';

export const dynamic = 'force-dynamic';

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ paypal_error?: string }> }) {
  await ready();
  const { paypal_error: paypalError } = await searchParams;
  const sandboxReady = publicPayPalStatus().state === 'ready';
  const orders = listOrders();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>订单与留底</h1>
          <p className="muted">发货前留底是 Reference 和 Logistics 的比对基准。从这里也可以生成买家索赔链接。</p>
        </div>
      </div>
      {paypalError && (
        <p className="notice notice-danger" style={{ marginBottom: 14 }}>
          PayPal 付款没有完成：{paypalError}
        </p>
      )}
      {sandboxReady && <TestOrderForm products={TEST_PRODUCTS.map((p) => ({ key: p.key, title: p.title, amount: p.amount }))} />}
      <div className="card table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>订单</th>
              <th>商品</th>
              <th>金额</th>
              <th>买家</th>
              <th>物流单号</th>
              <th>发货称重</th>
              <th>留底</th>
              <th>索赔</th>
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
                      {o.paid ? '沙箱' : '沙箱 · 未付款'}
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
