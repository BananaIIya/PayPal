import type { VerdictLevel } from '@/core/types';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const signed = (n: number) => (n > 0 ? `+${n.toFixed(2)}` : n.toFixed(2));

/** 列表里的小刻度：从 0 向两侧伸出，长度是 R，颜色跟判定等级走。 */
export function MiniMeter({ score, level }: { score: number | null; level: VerdictLevel | null }) {
  if (score === null || level === null) return <span className="muted">—</span>;
  const half = (clamp(Math.abs(score), 0, 4) / 4) * 50;
  return (
    <span className="mini-meter" title={`Buyer risk R = ${score.toFixed(2)} (negative supports the claim, positive contradicts it)`}>
      <span className="mini-track" aria-hidden="true">
        <span className={`mini-fill fill-${level}`} style={score >= 0 ? { left: '50%', width: `${half}%` } : { right: '50%', width: `${half}%` }} />
      </span>
      <span className="mini-val">{signed(score)}</span>
    </span>
  );
}

/** R 以 0 为中心：负值是支持索赔的证据更重，正值是反驳索赔的证据更重。刻度标出两个阈值。 */
export function RiskMeter({ score, medium, high, level }: { score: number; medium: number; high: number; level: VerdictLevel }) {
  const span = Math.max(high + 1, Math.abs(score) + 0.5);
  const pos = (v: number) => clamp(((v + span) / (2 * span)) * 100, 0, 100);
  const zero = pos(0);
  const at = pos(score);
  return (
    <div className="meter">
      <div className="meter-head">
        <span title="Weighted sum of all signals">Buyer risk R</span>
        <b>{signed(score)}</b>
      </div>
      <div className="meter-track" role="img" aria-label={`R = ${score.toFixed(2)}, thresholds ${medium} / ${high}`}>
        <span className={`meter-fill fill-${level}`} style={{ left: `${Math.min(zero, at)}%`, width: `${Math.abs(at - zero)}%` }} />
        {[0, medium, high].map((v) => (
          <span key={v} className="meter-tick" style={{ left: `${pos(v)}%` }} />
        ))}
      </div>
      <div className="meter-ticks" aria-hidden="true">
        <span style={{ left: `${pos(0)}%` }}>0</span>
        <span style={{ left: `${pos(medium)}%` }}>{medium}</span>
        <span style={{ left: `${pos(high)}%` }}>{high}</span>
      </div>
      <div className="meter-ends" aria-hidden="true">
        <span>Supports claim</span>
        <span>Contradicts claim</span>
      </div>
    </div>
  );
}

/** 0 到 1 的分数条，带一条阈值线。 */
export function ScoreBar({ label, value, mark, title }: { label: string; value: number; mark: number; title: string }) {
  return (
    <div className="bar-cell" title={title}>
      <div className="meter-head">
        <span>{label}</span>
        <b>{value.toFixed(2)}</b>
      </div>
      <div className="bar-track" aria-hidden="true">
        <span className="bar-fill" style={{ width: `${clamp(value, 0, 1) * 100}%` }} />
        <span className="bar-mark" style={{ left: `${clamp(mark, 0, 1) * 100}%` }} />
      </div>
    </div>
  );
}
