import type { ReactNode } from "react";
import type { IsoDate } from "@/lib/dates";
import type { ConnectorStatus } from "@/server/services/connectors";
import type { ServiceContext } from "@/server/services/context";
import type { MetricCard } from "@/server/services/metrics";
import { ItServicesDashboard } from "./ItServicesDashboard";
import { MetricsPanel } from "./MetricsPanel";
import { PartnerJourneyDashboard } from "./PartnerJourneyDashboard";
import {
  accentStyle,
  BRAND_CONNECTOR_ID,
  BRAND_METRIC_KEYS,
  dashboardTemplateFor,
  FACTORY_CONNECTOR_ID,
  FACTORY_METRIC_KEYS,
  TEMPLATE_ACCENT_TOKEN,
} from "./templates";

const KEY_LABELS: Record<string, string> = {
  orders_open: "Open orders",
  units_in_progress: "Units in progress",
  output_pcs: "Output per day (pcs)",
  defects_pct: "Defects %",
  wb_orders: "WB orders",
  wb_sales_amount: "WB sales amount",
  wb_returns: "WB returns",
};

/**
 * The kind-specific part of a company's overview (above the standard sections). Courier and
 * generic companies get nothing here: their overview stays as it was.
 */
export async function CompanyDashboard({
  ctx,
  company,
  cards,
  sources,
  today,
  connectorNames,
  showArchived,
  children,
}: {
  ctx: ServiceContext;
  company: { id: string; slug: string; name: string; kind: string };
  cards: MetricCard[];
  sources: ConnectorStatus[];
  today: IsoDate;
  connectorNames: Record<string, string>;
  showArchived: boolean;
  children: ReactNode;
}) {
  const template = dashboardTemplateFor(company.kind);
  let body: ReactNode = null;
  if (template === "it_services") {
    body = <ItServicesDashboard ctx={ctx} company={company} today={today} showArchived={showArchived} />;
  } else if (template === "factory") {
    body = (
      <div data-testid="dashboard-factory">
        <MetricsPanel
          title="Production"
          connectorId={FACTORY_CONNECTOR_ID}
          keys={FACTORY_METRIC_KEYS}
          keyLabels={KEY_LABELS}
          cards={cards}
          sources={sources}
          today={today}
          timeZone={ctx.timeZone}
          connectorNames={connectorNames}
          byUnit
        />
      </div>
    );
  } else if (template === "brand_sales") {
    body = (
      <div data-testid="dashboard-brand-sales">
        <MetricsPanel
          title="Wildberries sales"
          connectorId={BRAND_CONNECTOR_ID}
          keys={BRAND_METRIC_KEYS}
          keyLabels={KEY_LABELS}
          cards={cards}
          sources={sources}
          today={today}
          timeZone={ctx.timeZone}
          connectorNames={connectorNames}
        />
      </div>
    );
  } else if (template === "sales_partners") {
    body = <PartnerJourneyDashboard ctx={ctx} company={company} />;
  }
  return (
    <div style={accentStyle(template)} data-template={template} data-accent={TEMPLATE_ACCENT_TOKEN[template]}>
      {body}
      {children}
    </div>
  );
}
