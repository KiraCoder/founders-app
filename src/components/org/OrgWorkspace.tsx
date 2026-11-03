import Link from "next/link";
import { formatMetricValue, formatPeriod, freshnessTone } from "@/lib/metrics";
import type { CompanyUnit } from "@/server/db/schema";
import { canEditOrg } from "@/server/services/access";
import type { ServiceContext } from "@/server/services/context";
import { buildMetricCards, listMetricDefinitions } from "@/server/services/metrics";
import { getOrgChart, orgExpertForCompany, orgPeopleOptions } from "@/server/services/org";
import { orgExpertOptionsFor } from "@/server/services/org-expert";
import { OrgBoard, type LinkedMetric } from "./OrgBoard";
import { ApplyTemplateButton } from "./ApplyTemplateButton";
import { OrgExpertStrip } from "./OrgExpertStrip";

const FRESHNESS_LABEL = { fresh: "Up to date", stale: "Late", very_stale: "Very late", missing: "No data yet" } as const;

/**
 * The org board of one company (or one of its units): loads the chart, the people and
 * numbers it can link, the Org Structure Expert's findings, and renders the client board.
 * Used by /org and by the company page's "Org structure" tab.
 */
export async function OrgWorkspace({
  ctx,
  company,
  unit,
  showArchived,
  hrefFor,
}: {
  ctx: ServiceContext;
  company: { id: string; slug: string; name: string; units: CompanyUnit[] };
  unit: CompanyUnit | null;
  showArchived: boolean;
  /** Builds this page's link with other query values (unit, archived). */
  hrefFor: (q: { unit?: string | null; archived?: boolean }) => string;
}) {
  const scope = { companyId: company.id, companyUnitId: unit?.id ?? null };
  const editable = canEditOrg(ctx);
  const chart = await getOrgChart(ctx, scope, { includeArchived: showArchived });

  const unitSwitch =
    company.units.length > 0 ? (
      <nav className="mb-3 flex flex-wrap items-center gap-1.5 text-[13px]" aria-label="Chart scope">
        <span className="text-muted">Chart for:</span>
        <Link href={hrefFor({ unit: null })} aria-current={!unit ? "page" : undefined} className={`btn btn-sm ${!unit ? "btn-primary" : ""}`}>
          Whole company
        </Link>
        {company.units.map((u) => (
          <Link key={u.id} href={hrefFor({ unit: u.slug })} aria-current={unit?.id === u.id ? "page" : undefined} className={`btn btn-sm ${unit?.id === u.id ? "btn-primary" : ""}`}>
            {u.name}
          </Link>
        ))}
      </nav>
    ) : null;

  if (!chart) {
    const scopeName = unit ? `${company.name} · ${unit.name}` : company.name;
    return (
      <>
        {unitSwitch}
        <div className="card flex flex-col items-center gap-3 px-6 py-12 text-center" data-testid="org-empty">
          <h2 className="text-[16px] font-semibold">{scopeName} has no org chart yet</h2>
          <p className="max-w-md text-[13px] text-muted">
            Start from the Vysotsky model: 7 divisions and 21 departments, numbered and placed, with standard Russian names you can rename. ЦКП,
            statistics, functions and people are filled in by you.
          </p>
          {editable ? <ApplyTemplateButton companyId={company.id} companyUnitId={unit?.id ?? null} /> : <p className="text-[12px] text-muted">Only the founders can create it.</p>}
        </div>
      </>
    );
  }

  const [people, metricDefs, expert] = await Promise.all([orgPeopleOptions(ctx, company.id), listMetricDefinitions(ctx, company.id), orgExpertForCompany(ctx, company.id, await orgExpertOptionsFor(ctx, company.id))]);
  const linkedIds = new Set(chart.divisions.flatMap((d) => [...d.departments, ...d.archivedDepartments]).map((d) => d.metricDefinitionId).filter(Boolean));
  const cards = await buildMetricCards(
    ctx,
    metricDefs.filter((m) => linkedIds.has(m.id)),
  );
  const linkedMetrics: Record<string, LinkedMetric> = {};
  for (const c of cards) {
    linkedMetrics[c.id] = {
      label: c.label,
      value: c.latest ? formatMetricValue(c.latest.value, c.unit) : null,
      period: c.latest ? formatPeriod(c.latest.period, c.granularity) : null,
      freshness: FRESHNESS_LABEL[c.freshness.status],
      tone: freshnessTone(c.freshness.status),
    };
  }
  const findings = expert.find((r) => r.chartId === chart.id)?.findings ?? [];

  return (
    <>
      {unitSwitch}
      <OrgExpertStrip findings={findings} />
      <OrgBoard
        key={`${chart.id}:${showArchived ? 1 : 0}`}
        chart={chart}
        company={{ id: company.id, slug: company.slug, name: company.name }}
        editable={editable}
        people={people}
        metrics={metricDefs.map((m) => ({ id: m.id, label: m.label }))}
        linkedMetrics={linkedMetrics}
        showArchived={showArchived}
        timeZone={ctx.timeZone}
        archivedHref={hrefFor({ unit: unit?.slug ?? null, archived: !showArchived })}
      />
    </>
  );
}
