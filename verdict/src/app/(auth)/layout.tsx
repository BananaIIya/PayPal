import { Brand } from '@/components/Brand';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth-shell">
      <div className="brand auth-brand">
        <Brand ink="#ffffff" />
      </div>
      {children}
    </main>
  );
}
