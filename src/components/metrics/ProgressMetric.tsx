import type { Tone } from "@/components/ui";

const TONE_BAR: Record<Tone, string> = {
  ok: "bg-accent",
  warn: "bg-warn",
  risk: "bg-risk",
  info: "bg-info",
  neutral: "bg-muted",
};

/**
 * Clean target progress bar for KPIs, financial milestones, and company metrics.
 * Follows the Founder Cockpit design tokens with tabular numerals and status tones.
 */
export function ProgressMetric({
  current,
  target,
  label,
  unit,
  tone,
  formatter,
  className = "",
}: {
  current: number;
  target: number;
  label?: string;
  unit?: string;
  tone?: Tone;
  formatter?: (val: number, unit?: string) => string;
  className?: string;
}) {
  const percent = target > 0 ? Math.min(100, Math.max(0, Math.round((current / target) * 100))) : 0;
  const resolvedTone: Tone =
    tone ?? (percent >= 100 ? "ok" : percent >= 70 ? "info" : percent >= 40 ? "warn" : "risk");

  const fmt = (v: number) => (formatter ? formatter(v, unit) : unit ? `${v.toLocaleString()} ${unit}` : v.toLocaleString());
  const gap = target - current;

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      {(label || target > 0) && (
        <div className="flex items-center justify-between gap-2 text-[12px]">
          {label && <span className="text-muted">{label}</span>}
          <div className="ml-auto flex items-center gap-1.5 num">
            <span className="font-semibold text-ink">{percent}%</span>
            <span className="text-muted">
              ({fmt(current)} / {fmt(target)})
            </span>
          </div>
        </div>
      )}
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-sunk">
        <div
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          className={`h-full rounded-full transition-all duration-300 ${TONE_BAR[resolvedTone]}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {gap > 0 && (
        <p className="text-[11px] text-muted num text-right">
          {fmt(gap)} to target
        </p>
      )}
    </div>
  );
}
