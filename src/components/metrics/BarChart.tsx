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
  const numericValues = data.map((d) => d.value).filter((v): v is number => v !== null && v > 0);
  const max = numericValues.length > 0 ? Math.max(...numericValues) : 1;
  const computedWidth = width ?? data.length * (barWidth + gap) + gap;
  const chartHeight = showLabels ? height - 18 : height;

  return (
    <div className="flex flex-col">
      <svg
        width={computedWidth}
        height={height}
        viewBox={`0 0 ${computedWidth} ${height}`}
        className="overflow-visible"
        role="img"
        aria-label={ariaLabel}
      >
        {/* Baseline */}
        <line
          x1={0}
          y1={chartHeight}
          x2={computedWidth}
          y2={chartHeight}
          stroke="var(--line)"
          strokeWidth={1}
        />

        {data.map((d, i) => {
          const x = gap + i * (barWidth + gap);
          if (d.value === null || d.value <= 0) {
            return (
              <g key={i}>
                <line
                  x1={x}
                  y1={chartHeight - 1}
                  x2={x + barWidth}
                  y2={chartHeight - 1}
                  stroke="var(--line)"
                  strokeWidth={2}
                  strokeDasharray="2 2"
                />
                {showLabels && (
                  <text
                    x={x + barWidth / 2}
                    y={height - 2}
                    textAnchor="middle"
                    className="fill-muted text-[10px] select-none"
                  >
                    {d.label}
                  </text>
                )}
              </g>
            );
          }

          const barHeight = Math.max(3, (d.value / max) * (chartHeight - 6));
          const y = chartHeight - barHeight;
          const color = d.tone ? TONE_COLORS[d.tone] : "var(--accent)";

          return (
            <g key={i}>
              <title>{`${d.label}: ${d.formatted ?? d.value}`}</title>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barHeight}
                rx={3}
                fill={color}
                className="transition-all hover:opacity-85"
              />
              {showLabels && (
                <text
                  x={x + barWidth / 2}
                  y={height - 2}
                  textAnchor="middle"
                  className="fill-muted text-[10px] select-none font-medium"
                >
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
