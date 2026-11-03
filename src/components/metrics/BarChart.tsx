import type { Tone } from "@/components/ui";

export interface BarDatum {
  label: string;
  value: number | null;
  formatted?: string;
  tone?: Tone;
}

const TONE_COLORS: Record<Tone, string> = {
  ok: "var(--accent)",
  warn: "var(--warn)",
  risk: "var(--risk)",
  info: "var(--info)",
  neutral: "var(--muted)",
};

/**
 * Clean inline SVG Bar Chart matching the Founder Cockpit design system.
 * Zero external charting dependencies; pure SVG with theme token colors.
 */
export function BarChart({
  data,
  height = 72,
  width,
  barWidth = 14,
  gap = 6,
  showLabels = true,
  ariaLabel = "Bar chart",
}: {
  data: BarDatum[];
  height?: number;
  width?: number;
  barWidth?: number;
  gap?: number;
  showLabels?: boolean;
  ariaLabel?: string;
}) {
  const finite = (v: number | null): v is number => v !== null && Number.isFinite(v);
  const values = data.map((d) => d.value).filter(finite);
  // The scale always includes 0, so negative values hang below the zero line.
  const maxV = Math.max(0, ...values);
  const minV = Math.min(0, ...values);
  const span = maxV - minV || 1;
  const computedWidth = width ?? data.length * (barWidth + gap) + gap;
  const chartHeight = showLabels ? height - 18 : height;
  const top = 3;
  const plotH = Math.max(1, chartHeight - top);
  const zeroY = top + (maxV / span) * plotH;
  const valueText = (d: BarDatum) => (finite(d.value) ? (d.formatted ?? String(d.value)) : "no data");
  const label = data.length ? `${ariaLabel}: ${data.map((d) => `${d.label} ${valueText(d)}`).join(", ")}` : `${ariaLabel}: no data`;

  return (
    <div className="flex flex-col">
      <svg
        width={computedWidth}
        height={height}
        viewBox={`0 0 ${computedWidth} ${height}`}
        className="overflow-visible"
        role="img"
        aria-label={label}
      >
        {/* Zero line */}
        <line x1={0} y1={zeroY} x2={computedWidth} y2={zeroY} stroke="var(--line)" strokeWidth={1} />

        {data.map((d, i) => {
          const x = gap + i * (barWidth + gap);
          const color = d.tone ? TONE_COLORS[d.tone] : "var(--accent)";
          const labelEl = showLabels && (
            <text x={x + barWidth / 2} y={height - 2} textAnchor="middle" className="fill-muted text-[10px] select-none font-medium">
              {d.label}
            </text>
          );

          let mark;
          if (!finite(d.value)) {
            // No data: dashed stub on the zero line.
            mark = <line x1={x} y1={zeroY - 1} x2={x + barWidth} y2={zeroY - 1} stroke="var(--line)" strokeWidth={2} strokeDasharray="2 2" />;
          } else if (d.value === 0) {
            // A real zero: solid stub in the bar's colour, so it reads differently from "no data".
            mark = <line x1={x} y1={zeroY - 1} x2={x + barWidth} y2={zeroY - 1} stroke={color} strokeWidth={2} />;
          } else {
            const barHeight = Math.max(3, (Math.abs(d.value) / span) * plotH);
            const y = d.value > 0 ? zeroY - barHeight : zeroY;
            mark = <rect x={x} y={y} width={barWidth} height={barHeight} rx={3} fill={color} className="transition-all hover:opacity-85" />;
          }

          return (
            <g key={i}>
              <title>{`${d.label}: ${valueText(d)}`}</title>
              {mark}
              {labelEl}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
