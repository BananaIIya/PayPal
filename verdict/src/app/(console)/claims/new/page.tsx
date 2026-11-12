import { ImportForm } from '@/components/ImportForm';
import { ready } from '@/server/bootstrap';
import { pageUser } from '@/server/guard';
import { listOrders } from '@/server/repo';

export const dynamic = 'force-dynamic';

export default async function NewClaimPage() {
  await ready();
  await pageUser();
  const orders = listOrders().map((o) => ({ id: o.id, label: `${o.orderNo} · ${o.product}` }));
  return (
    <div style={{ maxWidth: 640 }}>
      <h1 style={{ marginBottom: 6 }}>
        Manual import
      </h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Import photos and screenshots the buyer sent by email or message.
      </p>
      <ImportForm orders={orders} />
    </div>
  );
}
