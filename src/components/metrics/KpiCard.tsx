import { Tag, type Tone } from "@/components/ui";
import type { IsoDate } from "@/lib/dates";
import {
  agoText,
  defaultEntryPeriod,
  formatDelta,
  formatMetricValue,
  formatPeriod,
  freshnessTone,
  lastEnterablePeriod,
  periodEnd,
} from "@/lib/metrics";
import type { MetricCard } from "@/server/services/metrics";
import { EnterValueForm } from "./EnterValueForm";
import { ProgressMetric } from "./ProgressMetric";
import { Sparkline } from "./Sparkline";

const CARD_TONE: Record<string, string> = {
  ok: "",
  warn: "border-warn-line bg-warn-soft",
  risk: "border-risk-line bg-risk-soft",
};

/** "extension:wb-seller" (an ingest call of the browser extension) → "Browser extension (wb-seller)". */
export function sourceName(connectorId: string): string {
  return connectorId.startsWith("extension:") ? `Browser extension (${connectorId.slice("extension:".length)})` : connectorId;
}

export function sourceLabel(m: Pick<MetricCard, "sourceKind" | "connectorId">, connectorNames: Record<string, string>): string {
  if (m.sourceKind === "connector") return m.connectorId ? (connectorNames[m.connectorId] ?? m.connectorId) : "Connector";
  return m.sourceKind === "upload" ? "Upload" : "Manual entry";
}

function freshnessTag(m: MetricCard, today: IsoDate): { tone: Tone; text: string } {
  const f = m.freshness;
  if (f.status === "fresh") return { tone: "ok", text: "Fresh" };
  if (f.status === "missing") return { tone: "risk", text: `No data yet · waiting for ${formatPeriod(f.waitingFor!, m.granularity)}` };
  const n = f.overduePeriods;
  const behind =
    n === 1 && !f.moreBeforeWindow
      ? `Waiting for ${formatPeriod(f.waitingFor!, m.granularity)}`
      : `${n}${f.moreBeforeWindow ? "+" : ""} missing · from ${formatPeriod(f.waitingFor!, m.granularity)}`;
  return { tone: freshnessTone(f.status) as Tone, text: `${behind} · due ${agoText(f.dueOn!, today)}` };
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
            {m.latest?.inProgress && " · so far"}
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
      {m.target !== null && m.latest && (
        <ProgressMetric
          current={m.latest.value}
          target={m.target}
          unit={m.unit}
          formatter={(v, u) => formatMetricValue(v, u ?? m.unit)}
        />
      )}
      {m.disagreements[0] && (
        <p className="text-[11px] text-warn" data-testid="kpi-disagrees">
          Source disagrees: {connectorNames[m.disagreements[0].connectorId] ?? sourceName(m.disagreements[0].connectorId)} says {formatMetricValue(m.disagreements[0].reported, m.unit)} for{" "}
          {formatPeriod(m.disagreements[0].period, m.granularity)} (kept {formatMetricValue(m.disagreements[0].kept, m.unit)}{" "}
          {m.disagreements[0].keptSource === "upload" ? "from the upload" : "entered by hand"})
          {m.disagreements.length > 1 && ` +${m.disagreements.length - 1} more`}
        </p>
      )}
      <p className="text-[11px] text-muted" data-testid="kpi-freshness" title={`Expected source: ${sourceLabel(m, connectorNames)}`}>
        {m.latest
          ? `Updated ${agoText(m.latest.enteredDay, today)}${m.latest.enteredByName ? ` by ${m.latest.enteredByName}` : ""} · ${
              m.latest.source === "connector"
                ? `via ${sourceLabel(m, connectorNames)}`
                : m.latest.source === "extension"
                  ? "via the browser extension"
                  : m.latest.source === "derived"
                  ? "computed from the Holding page"
                  : m.latest.source === "upload"
                    ? "via upload"
                    : "entered by hand"
            }`
          : `Never updated · expected from ${sourceLabel(m, connectorNames)}`}
      </p>
      <EnterValueForm
        metricId={m.id}
        label={m.label}
        unit={m.unit}
        granularity={m.granularity}
        defaultPeriod={defaultEntryPeriod({ granularity: m.granularity, freshness: m.freshness, latestPeriod: m.latest?.period ?? null }, today)}
        maxDate={m.granularity === "day" ? today : periodEnd(lastEnterablePeriod(today, m.granularity), m.granularity)}
      />
    </div>
  );
}
