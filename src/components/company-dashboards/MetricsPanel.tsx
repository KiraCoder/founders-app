import { KpiCard } from "@/components/metrics/KpiCard";
import { Section } from "@/components/ui";
import type { IsoDate } from "@/lib/dates";
import type { ConnectorStatus } from "@/server/services/connectors";
import type { MetricCard } from "@/server/services/metrics";
import { SourceStatusCard } from "./SourceStatusCard";
import { groupByUnit, pickMetricCards } from "./templates";

/**
 * Connector-fed numbers panel (factory production, WB sales): the source's status card, then
 * the latest value / freshness / sparkline of each expected key. Factory numbers are split
 * per unit (ХБК, Ош Район); keys that are not tracked yet are listed as "waiting".
 */
export function MetricsPanel({
  title,
  connectorId,
  keys,
  keyLabels,
  cards,
  sources,
  today,
  timeZone,
  connectorNames,
  byUnit,
}: {
  title: string;
  connectorId: string;
  keys: readonly string[];
  keyLabels: Record<string, string>;
  cards: MetricCard[];
  sources: ConnectorStatus[];
  today: IsoDate;
  timeZone: string;
  connectorNames: Record<string, string>;
  byUnit?: boolean;
}) {
  const picked = pickMetricCards(cards, keys);
  const missing = keys.filter((k) => !picked.some((c) => c.key === k));
  const groups = byUnit ? groupByUnit(picked) : [{ unitName: null, cards: picked }];
  return (
    <Section title={title}>
      <div className="mb-3">
        <SourceStatusCard connectorId={connectorId} sources={sources} timeZone={timeZone} />
      </div>
      {picked.length === 0 ? (
        <div className="card px-4 py-6 text-center text-[13px] text-muted" data-testid="panel-empty">
          No numbers from this source yet. Expected: {keys.map((k) => keyLabels[k] ?? k).join(", ")}.
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <div key={g.unitName ?? "company"} data-testid="panel-group">
              {byUnit && <h3 className="mb-2 text-[13px] font-semibold text-(color:--kind-accent)">{g.unitName ?? "Whole company"}</h3>}
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {g.cards.map((m) => (
                  <KpiCard key={m.id} m={m} today={today} connectorNames={connectorNames} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {picked.length > 0 && missing.length > 0 && (
        <p className="mt-2 text-[12px] text-muted">Not tracked yet: {missing.map((k) => keyLabels[k] ?? k).join(", ")}.</p>
      )}
    </Section>
  );
}
