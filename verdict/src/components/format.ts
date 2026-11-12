export function fmtMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toFixed(2)}`;
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function dueLabel(iso: string | null): { text: string; soon: boolean } {
  if (!iso) return { text: '—', soon: false };
  const hours = (new Date(iso).getTime() - Date.now()) / 3600000;
  if (hours < 0) return { text: 'Overdue', soon: true };
  if (hours < 48) return { text: `in ${Math.round(hours)} h`, soon: true };
  return { text: `in ${Math.round(hours / 24)} days`, soon: false };
}

export function fmtScore(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : n.toFixed(2);
}
