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
        if (!window.confirm('Reset demo data? Claims you created and actions you took will be cleared.')) return;
        setBusy(true);
        await fetch('/api/demo/reset', { method: 'POST' });
        setBusy(false);
        router.push('/claims');
        router.refresh();
      }}
    >
      {busy ? 'Resetting…' : 'Reset demo data'}
    </button>
  );
}
