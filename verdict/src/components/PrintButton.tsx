'use client';

export function PrintButton() {
  return (
    <button className="btn" onClick={() => window.print()}>
      打印或存为 PDF
    </button>
  );
}
