/** Inline SVG sparkline of the last periods. Gaps (no value) break the line. Colors come from theme tokens via currentColor. */
export function Sparkline({
  points,
  width = 120,
  height = 32,
  className = "text-accent",
  label,
}: {
  points: { period: string; value: number | null }[];
  width?: number;
  height?: number;
  className?: string;
  label?: string;
}) {
  const values = points.map((p) => p.value).filter((v): v is number => v !== null);
  if (values.length === 0) {
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="text-line" aria-hidden="true">
        <line x1="0" x2={width} y1={height - 2} y2={height - 2} stroke="currentColor" strokeDasharray="3 3" />
      </svg>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = 3;
  const step = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
  const y = (v: number) => (max === min ? height / 2 : pad + (1 - (v - min) / (max - min)) * (height - pad * 2));
  const segments: string[][] = [];
  let current: string[] = [];
  points.forEach((p, i) => {
    if (p.value === null) {
      if (current.length) segments.push(current);
      current = [];
      return;
    }
    current.push(`${(pad + i * step).toFixed(1)},${y(p.value).toFixed(1)}`);
  });
  if (current.length) segments.push(current);
  const lastIdx = points.map((p) => p.value !== null).lastIndexOf(true);
  const last = points[lastIdx]!;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label={label ?? `Trend over the last ${points.length} periods`}
    >
      {segments.map((s, i) =>
        s.length === 1 ? (
          <circle key={i} cx={s[0]!.split(",")[0]} cy={s[0]!.split(",")[1]} r="1.5" fill="currentColor" />
        ) : (
          <polyline key={i} points={s.join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        ),
      )}
      <circle cx={pad + lastIdx * step} cy={y(last.value!)} r="2.5" fill="currentColor" />
    </svg>
  );
}
