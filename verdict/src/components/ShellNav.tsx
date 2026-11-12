'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ICON = {
  claims: <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 14.5v-9ZM7 8h6M7 10.5h6M7 13h3.5" />,
  orders: <path d="M3.5 6.5 10 3l6.5 3.5v7L10 17l-6.5-3.5v-7ZM3.5 6.5 10 10m0 0 6.5-3.5M10 10v7" />,
  shadow: <path d="M10 3.5v13M5 7h10M5 7l-2 5a2.2 2.2 0 0 0 4 0L5 7Zm10 0-2 5a2.2 2.2 0 0 0 4 0l-2-5ZM7 16.5h6" />,
  settings: <path d="M4 6h5m4 0h3M4 10h2m4 0h6M4 14h7m4 0h1M11 4.5v3M8 8.5v3M13 12.5v3" />,
};

const ITEMS = [
  { href: '/claims', label: 'Claims', icon: ICON.claims, ownerOnly: false },
  { href: '/orders', label: 'Orders & references', icon: ICON.orders, ownerOnly: false },
  { href: '/shadow', label: 'Shadow mode', icon: ICON.shadow, ownerOnly: true },
  { href: '/settings', label: 'Settings', icon: ICON.settings, ownerOnly: false },
];

export function ShellNav({ owner }: { owner: boolean }) {
  const path = usePathname();
  return (
    <nav className="rail-nav" aria-label="Main navigation">
      {ITEMS.filter((i) => owner || !i.ownerOnly).map((i) => (
        <Link key={i.href} href={i.href} aria-current={path === i.href || path.startsWith(`${i.href}/`) ? 'page' : undefined}>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {i.icon}
          </svg>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
