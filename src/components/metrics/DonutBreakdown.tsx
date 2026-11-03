import type { Tone } from "@/components/ui";

export interface DonutSlice {
  label: string;
  value: number;
  color?: string;
  tone?: Tone;
}

const TONE_COLORS: Record<Tone, string> = {
  ok: "var(--accent)",
  warn: "var(--warn)",
  risk: "var(--risk)",
  info: "var(--info)",
  neutral: "var(--muted)",
};

const DEFAULT_PALETTE = [
  "var(--accent)",
  "var(--info)",
  "var(--warn)",
  "var(--risk)",
  "var(--muted)",
];

/**
 * Lightweight SVG Donut Chart component for distributions and breakdowns.
 * Accessible with tooltips, center total label, and optional legend.
 */
export function DonutBreakdown({
  slices,
  size = 110,
  strokeWidth = 14,
  centerLabel,
  centerValue,
  showLegend = true,
}: {
  slices: DonutSlice[];
  size?: number;
  strokeWidth?: number;
  centerLabel?: string;
  centerValue?: string | number;
  showLegend?: boolean;
}) {
  const total = slices.reduce((acc, s) => acc + (s.value > 0 ? s.value : 0), 0);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  let accumulatedPercent = 0;

  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="-rotate-90"
          role="img"
          aria-label={centerLabel ?? "Distribution breakdown"}
        >
          {/* Background circle track */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--sunk)"
            strokeWidth={strokeWidth}
          />
          {total > 0 &&
            slices.map((slice, i) => {
              if (slice.value <= 0) return null;
              const percent = slice.value / total;
              const strokeDasharray = `${percent * circumference} ${circumference}`;
              const strokeDashoffset = -accumulatedPercent * circumference;
              accumulatedPercent += percent;

              const color =
                slice.color ??
                (slice.tone ? TONE_COLORS[slice.tone] : DEFAULT_PALETTE[i % DEFAULT_PALETTE.length]);

              return (
                <circle
                  key={i}
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  stroke={color}
                  strokeWidth={strokeWidth}
                  strokeDasharray={strokeDasharray}
                  strokeDashoffset={strokeDashoffset}
                  className="transition-all hover:opacity-90"
                >
                  <title>{`${slice.label}: ${slice.value} (${Math.round(percent * 100)}%)`}</title>
                </circle>
              );
            })}
        </svg>
        {/* Center content */}
        {(centerValue !== undefined || centerLabel) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
            {centerValue !== undefined && (
              <span className="num text-[16px] font-semibold leading-tight text-ink">
                {centerValue}
              </span>
            )}
            {centerLabel && (
              <span className="text-[10px] uppercase tracking-wide text-muted font-medium">
                {centerLabel}
              </span>
            )}
          </div>
        )}
      </div>

      {showLegend && (
        <ul className="flex flex-col gap-1 text-[12px]">
          {slices.map((slice, i) => {
            const color =
              slice.color ??
              (slice.tone ? TONE_COLORS[slice.tone] : DEFAULT_PALETTE[i % DEFAULT_PALETTE.length]);
            const pct = total > 0 ? Math.round((slice.value / total) * 100) : 0;
            return (
              <li key={i} className="flex items-center gap-2">
                <span
                  className="size-2 rounded-full shrink-0"
                  style={{ backgroundColor: color }}
                  aria-hidden="true"
                />
                <span className="text-muted">{slice.label}</span>
                <span className="ml-auto font-medium text-ink num">
                  {slice.value} <span className="text-[10px] text-muted font-normal">({pct}%)</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
