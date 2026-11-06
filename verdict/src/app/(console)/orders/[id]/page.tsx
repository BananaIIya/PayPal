import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CLAIM_TYPE_LABEL, SHOT_LABEL, STATUS_LABEL } from '@/core/catalog';
import { OrderTools } from '@/components/OrderTools';
import { fmtDateTime, fmtMoney } from '@/components/format';
import { ready } from '@/server/bootstrap';
import { pageUser } from '@/server/guard';
import { db, json } from '@/server/db';
import { getOrder, getTracking, orderReferences, type ClaimRow } from '@/server/repo';
import { captureState } from '@/server/sandbox-shop';

export const dynamic = 'force-dynamic';

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  await ready();
  await pageUser();
  const { id } = await params;
  const order = getOrder(id);
  if (!order) notFound();
  const items = json<{ title: string; quantity: number; sku: string; weightG?: number }[]>(order.items, []);
  const address = json<{ line1?: string; city?: string; postalCode?: string } | null>(order.ship_address, null);
  const snapshot = json<{ title?: string; description?: string } | null>(order.listing_snapshot, null);
  const tracking = getTracking(order);
  const refs = orderReferences(id);
  const claims = db().prepare('SELECT * FROM claims WHERE order_id = ? ORDER BY created_at DESC').all(id) as unknown as ClaimRow[];
  const capture = await captureState(order);

  return (
    <>
      <p className="small">
        <Link href="/orders">← 订单列表</Link>
      </p>
      <div className="page-head">
        <h1>
          {order.order_no} · {items[0]?.title}
        </h1>
      </div>
      {capture?.warning && (
        <p className="notice" style={{ marginBottom: 14 }}>
          {capture.warning}
        </p>
      )}
      <div className="two-col">
        <div className="stack" style={{ gap: 14 }}>
          <section className="card card-pad">
            <h2>订单信息</h2>
            <dl className="kv">
              <dt>金额</dt>
              <dd className="num">{fmtMoney(order.amount, order.currency)}</dd>
              {capture && (
                <>
                  <dt>付款状态</dt>
                  <dd title={capture.error ?? undefined}>{capture.summary}</dd>
                </>
              )}
              <dt>商品</dt>
              <dd>
                {items.map((i) => (
                  <div key={i.sku}>
                    {i.title} ×{i.quantity} <span className="mono muted">{i.sku}</span>
                  </div>
                ))}
              </dd>
              <dt>买家</dt>
              <dd>{order.buyer_name ?? '—'}</dd>
              <dt>收货地址</dt>
              <dd>
                {address ? `${address.line1 ?? ''}，${address.city ?? ''} ${address.postalCode ?? ''}` : '—'}
              </dd>
              <dt>下单时间</dt>
              <dd>{fmtDateTime(order.created_at)}</dd>
              <dt>下单时描述</dt>
              <dd>{snapshot?.description ?? '—'}</dd>
            </dl>
          </section>
          <section className="card card-pad">
            <h2>物流轨迹</h2>
            {tracking ? (
              <>
                <p className="small muted" style={{ marginBottom: 6 }}>
                  {order.carrier} <span className="mono">{order.tracking_number}</span>
                  {tracking.weightG ? ` · 物流称重 ${tracking.weightG}g` : ''}
                  {tracking.deliveredPostalCode ? ` · 签收邮编 ${tracking.deliveredPostalCode}` : ''}
                  <span className="badge badge-sim" style={{ marginLeft: 6 }}>模拟数据</span>
                </p>
                <ol className="timeline">
                  {tracking.events.map((e) => (
                    <li key={e.at}>
                      <time>{fmtDateTime(e.at)}</time>
                      <div>{e.description}</div>
                    </li>
                  ))}
                </ol>
              </>
            ) : order.tracking_number ? (
              <>
                <p className="small" style={{ marginBottom: 6 }}>
                  {order.carrier} <span className="mono">{order.tracking_number}</span>
                </p>
                <p className="muted small">没有物流轨迹：还没有接入物流接口（EasyPost、Shippo），Logistics 分析器会标为未执行。</p>
              </>
            ) : (
              <p className="muted">这笔订单没有物流信息。</p>
            )}
          </section>
          <section className="card card-pad">
            <h2>索赔</h2>
            {claims.length === 0 && <p className="muted">还没有索赔。</p>}
            {claims.map((c) => (
              <p key={c.id}>
                <Link href={`/claims/${c.id}`}>
                  {CLAIM_TYPE_LABEL[c.claim_type]} · {STATUS_LABEL[c.status]}
                </Link>{' '}
                <span className="muted small">{fmtDateTime(c.created_at)}</span>
              </p>
            ))}
          </section>
        </div>
        <div className="stack" style={{ gap: 14 }}>
          <OrderTools orderId={id} initialWeight={order.shipped_weight_g} paypalEnv={order.paypal_env} captureId={order.capture_id} />
          <section className="card card-pad">
            <h2>留底照（{refs.length}）</h2>
            {refs.length === 0 ? (
              <p className="muted">这笔订单没有留底，部分比对无法进行。</p>
            ) : (
              <div className="ref-grid">
                {refs.map((r) => (
                  <figure key={r.id}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/evidence/${r.id}/file`} alt={SHOT_LABEL[r.shot_label ?? ''] ?? '留底'} />
                    <figcaption>{SHOT_LABEL[r.shot_label ?? ''] ?? r.shot_label}</figcaption>
                  </figure>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
