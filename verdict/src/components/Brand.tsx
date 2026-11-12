/** 字标与图形标，和 app/icon.svg 用同一个 V 形。 */
export function BrandMark({ ink = '#12141a' }: { ink?: string }) {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 34 31" xmlns="http://www.w3.org/2000/svg">
        <path d="M0 0h9l8 24 8-24h9L21 31h-8Z" fill={ink} />
      </svg>
    </span>
  );
}

export function Brand({ sub, ink }: { sub?: string; ink?: string }) {
  return (
    <>
      <BrandMark ink={ink} />
      <span>
        <span className="brand-name">Verdict</span>
        {sub && <span className="brand-sub">{sub}</span>}
      </span>
    </>
  );
}
