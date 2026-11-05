'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function ResetDemo() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn"
      disabled={busy}
      onClick={async () => {
        if (!window.confirm('确定重置演示数据吗？你新建的索赔和执行过的动作都会被清除。')) return;
        setBusy(true);
        await fetch('/api/demo/reset', { method: 'POST' });
        setBusy(false);
        router.push('/claims');
        router.refresh();
      }}
    >
      {busy ? '重置中…' : '重置演示数据'}
    </button>
  );
}
