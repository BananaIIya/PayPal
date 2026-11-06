export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth-shell">
      <div className="auth-brand">Verdict</div>
      {children}
    </main>
  );
}
