import { ImportForm } from '@/components/ImportForm';
import { ready } from '@/server/bootstrap';
import { listOrders } from '@/server/repo';

export const dynamic = 'force-dynamic';

export default async function NewClaimPage() {
  await ready();
  const orders = listOrders().map((o) => ({ id: o.id, label: `${o.orderNo} · ${o.product}` }));
  return (
    <div style={{ maxWidth: 640 }}>
      <h1 style={{ marginBottom: 6 }}>手动导入</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        买家绕开 PayPal、通过邮件或私信发来照片和截图时，在这里导入。这些文件的来源无法验证，判定中按 C 层证据降权。
      </p>
      <ImportForm orders={orders} />
    </div>
  );
}
