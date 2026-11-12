'use client';

export function PrintButton() {
  return (
    <button className="btn" onClick={() => window.print()}>
      Print or save as PDF
    </button>
  );
}
