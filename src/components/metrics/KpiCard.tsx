import { Tag, type Tone } from "@/components/ui";
import type { IsoDate } from "@/lib/dates";
import {
  agoText,
  formatDelta,
  formatMetricValue,
  formatPeriod,
  freshnessTone,
  nextPeriod,
  periodStart,
} from "@/lib/metrics";
import type { MetricCard } from "@/server/services/metrics";
import { EnterValueForm } from "./EnterValueForm";
import { Sparkline } from "./Sparkline";

const CARD_TONE: Record<string, string> = {
  ok: "",
  warn: "border-warn-line bg-warn-soft",
  risk: "border-risk-line bg-risk-soft",
};

export function sourceLabel(m: Pick<MetricCard, "sourceKind" | "connectorId">, connectorNames: Record<string, string>): string {
  if (m.sourceKind === "connector") return m.connectorId ? (connectorNames[m.connectorId] ?? m.connectorId) : "Connector";
  return m.sourceKind === "upload" ? "Upload" : "Manual entry";
}

function freshnessTag(m: MetricCard, today: IsoDate): { tone: Tone; text: string } {
  const f = m.freshness;
  if (f.status === "fresh") return { tone: "ok", text: "Fresh" };
  if (f.status === "missing") return { tone: "risk", text: `No data yet · waiting for ${formatPeriod(f.waitingFor!, m.granularity)}` };
  const n = f.overduePeriods;
  const behind = f.status === "very_stale" ? `${n >= 3 ? "3+" : n} periods missing` : `Waiting for ${formatPeriod(f.waitingFor!, m.granularity)}`;
  return { tone: freshnessTone(f.status) as Tone, text: `${behind} · due ${agoText(f.dueOn!, today)}` };
}

/** Period the "Enter value" form opens with: the one we are waiting for, else the next one (not in the future). */
function defaultPeriod(m: MetricCard, today: IsoDate): IsoDate {
  const current = periodStart(today, m.granularity);
  if (m.freshness.waitingFor) return m.freshness.waitingFor;
  if (m.latest) {
    const next = nextPeriod(m.latest.period, m.granularity);
    return next <= current ? next : m.latest.period;
  }
  return m.freshness.expectedPeriod;
}

export function KpiCard({ m, today, connectorNames }: { m: MetricCard; today: IsoDate; connectorNames: Record<string, string> }) {
  const tone = freshnessTone(m.freshness.status);
  const tag = freshnessTag(m, today);
  const change = m.change;
  return (
    <div className={`card flex flex-col gap-2 p-4 ${CARD_TONE[tone]}`} data-testid="kpi-card" data-metric={m.key} data-freshness={m.freshness.status}>
      <div className="flex items-start justify-between gap-2">
        <p className="eyebrow">{m.label}</p>
        <span className="shrink-0 text-[11px] text-muted">{m.granularity === "day" ? "daily" : m.granularity === "week" ? "weekly" : "monthly"}</span>
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className={`num text-[24px] font-semibold leading-7 ${m.latest ? "" : "text-muted"}`} data-testid="kpi-value">
            {m.latest ? formatMetricValue(m.latest.value, m.unit) : "—"}
          </p>
          <p className="text-[12px] text-muted">
            {m.latest ? formatPeriod(m.latest.period, m.granularity) : "No value yet"}
            {change && (
              <>
                {" · "}
                <span
                  className={change.tone === "good" ? "text-accent" : change.tone === "bad" ? "text-risk" : ""}
                  title={`vs ${formatPeriod(change.previousPeriod, m.granularity)}: ${formatMetricValue(change.previous, m.unit)}`}
                >
                  {formatDelta(change, m.unit)}
                </span>
              </>
            )}
          </p>
        </div>
        <Sparkline
          points={m.series}
          className={tone === "ok" ? "text-accent" : tone === "warn" ? "text-warn" : "text-risk"}
          label={`${m.label}: last ${m.series.length} periods`}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Tag tone={tag.tone}>{tag.text}</Tag>
        {m.target !== null && <span className="text-[11px] text-muted">Target {formatMetricValue(m.target, m.unit)}</span>}
      </div>
      <p className="text-[11px] text-muted" data-testid="kpi-freshness">
        {m.latest
          ? `Updated ${agoText(m.latest.enteredDay, today)}${m.latest.enteredByName ? ` by ${m.latest.enteredByName}` : m.latest.source === "connector" ? " by connector" : ""}`
          : "Never updated"}
        {" · "}
        {sourceLabel(m, connectorNames)}
      </p>
      <EnterValueForm
        metricId={m.id}
        label={m.label}
        unit={m.unit}
        granularity={m.granularity}
        defaultPeriod={defaultPeriod(m, today)}
        maxPeriod={periodStart(today, m.granularity)}
      />
    </div>
  );
}
