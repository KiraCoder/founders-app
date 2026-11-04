import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { PeopleTable } from "@/components/people/PeopleTable";
import { NewProjectForm } from "@/components/projects/NewProjectForm";
import { ProjectCard } from "@/components/projects/ProjectCard";
import { NewTaskPanel } from "@/components/tasks/NewTaskPanel";
import { OrgWorkspace } from "@/components/org/OrgWorkspace";
import { TaskList } from "@/components/tasks/TaskList";
import { toTaskItem } from "@/components/tasks/types";
import { ComingSoon, CompanyDot, PageHeader, Section, TabNav, Tag } from "@/components/ui";
import { DataSources } from "@/components/metrics/DataSources";
import { CompanyDashboard } from "@/components/company-dashboards/CompanyDashboard";
import { dashboardTemplateFor, templateConnectorId, templateMetricKeys } from "@/components/company-dashboards/templates";
import { KpiCard } from "@/components/metrics/KpiCard";
import { NumbersGrid } from "@/components/metrics/NumbersGrid";
import { formatMetricInput, formatPeriodShort, GRANULARITY_LABELS, lastEnterablePeriod, lastPeriods, type Granularity } from "@/lib/metrics";
import { STUB_SPECS } from "@/server/connectors/stubs";
import { listConnectorStatuses, type ConnectorStatus } from "@/server/services/connectors";
import { monthTotalKind } from "@/server/ai/month-values";
import { currentValues, listCompanyMetricCards, listMetricDefinitions, type MetricCard, type MetricView } from "@/server/services/metrics";
import { getPageContext } from "@/server/context";
import { RunStatusTag } from "@/components/ai-roles/AiRolesBoard";
import { FINANCIAL_ANALYST, ORG_STRUCTURE_EXPERT } from "@/lib/ai-roles";
import { canUseAiRoles } from "@/server/services/access";
import { listHireRuns, listHires } from "@/server/services/ai-roles";
import { getCompanyBySlug } from "@/server/services/companies";
import { today } from "@/server/services/context";
import { ServiceError } from "@/server/services/errors";
import { getTaskFormOptions } from "@/server/services/options";
import { companyHeadcount, listPeople } from "@/server/services/people";
import { orgPositionsForPeople } from "@/server/services/org";
import { canViewSalaries } from "@/server/services/salaries";
import { listProjects } from "@/server/services/projects";
import { listTasks } from "@/server/services/tasks";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "numbers", label: "Numbers" },
  { key: "projects", label: "Projects" },
  { key: "tasks", label: "Tasks" },
  { key: "people", label: "People" },
  { key: "org", label: "Org structure" },
  { key: "documents", label: "Documents" },
  { key: "ai", label: "AI roles" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ tab?: string; g?: string; unit?: string; archived?: string }> };

/** The tab title is the company's name as written ("Kiwi Go"), not its URL slug. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  try {
    const ctx = await getPageContext();
    return { title: (await getCompanyBySlug(ctx, slug)).name };
  } catch {
    return { title: "Company" };
  }
}

async function loadCompany(slug: string) {
  const ctx = await getPageContext();
  try {
    return { ctx, company: await getCompanyBySlug(ctx, slug) };
  } catch (err) {
    if (err instanceof ServiceError && err.code === "not_found") notFound();
    throw err;
  }
}

export default async function CompanyPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const { tab: rawTab, g, unit: unitParam, archived: archivedParam } = await searchParams;
  const tab: TabKey = TABS.some((t) => t.key === rawTab) ? (rawTab as TabKey) : "overview";
  const { ctx, company } = await loadCompany(slug);

  return (
    <>
      <PageHeader
        eyebrow={company.legalName ?? "Company"}
        title={
          <span className="flex items-center gap-2.5">
            <CompanyDot color={company.color} size={12} /> {company.name}
            {company.status === "planned" && <Tag tone="info">Planned</Tag>}
          </span>
        }
      >
        {company.description && <p className="mt-1 max-w-2xl text-[13px] text-muted">{company.description}</p>}
      </PageHeader>
      <TabNav
        active={tab}
        tabs={TABS.map((t) => ({ key: t.key, label: t.label, href: `/companies/${slug}${t.key === "overview" ? "" : `?tab=${t.key}`}` }))}
      />

      {tab === "overview" && <Overview ctx={ctx} company={company} showArchived={archivedParam === "1"} />}
      {tab === "numbers" && <NumbersTab ctx={ctx} company={company} granularity={g} />}
      {tab === "projects" && <ProjectsTab ctx={ctx} companyId={company.id} />}
      {tab === "tasks" && <TasksTab ctx={ctx} companyId={company.id} />}
      {tab === "people" && <PeopleTab ctx={ctx} companyId={company.id} slug={company.slug} />}
      {tab === "org" && <OrgTab ctx={ctx} company={company} unitSlug={unitParam} archived={archivedParam === "1"} />}
      {tab === "documents" && <ComingSoon title="Documents">Contracts, акты and uploaded files for this company.</ComingSoon>}
      {tab === "ai" && <AiRolesTab ctx={ctx} company={company} />}
    </>
  );
}

const CONNECTOR_NAMES: Record<string, string> = Object.fromEntries(STUB_SPECS.map((c) => [c.id, c.name]));

type Ctx = Awaited<ReturnType<typeof getPageContext>>;
type CompanyFull = Awaited<ReturnType<typeof getCompanyBySlug>>;

/**
 * Overview: the company's kind picks a dashboard template (client projects, production, WB
 * sales, partner journey) shown above the standard sections; courier / generic companies keep
 * the standard overview only.
 */
async function Overview({ ctx, company, showArchived }: { ctx: Ctx; company: CompanyFull; showArchived: boolean }) {
  const [allCards, sources] = await Promise.all([
    listCompanyMetricCards(ctx, company.id),
    listConnectorStatuses(ctx, { companyId: company.id }),
  ]);
  const template = dashboardTemplateFor(company.kind);
  if (template === "default") return <StandardOverview ctx={ctx} company={company} cards={allCards} sources={sources} />;
  // Numbers and the data source the template already shows are not repeated below it.
  const shown = new Set(templateMetricKeys(template));
  return (
    <CompanyDashboard
      ctx={ctx}
      company={company}
      cards={allCards}
      sources={sources}
      today={today(ctx)}
      connectorNames={CONNECTOR_NAMES}
      showArchived={showArchived}
    >
      <StandardOverview
        ctx={ctx}
        company={company}
        cards={allCards.filter((c) => !shown.has(c.key))}
        sources={sources.filter((x) => x.id !== templateConnectorId(template))}
        hideEmptyNumbers={shown.size > 0}
      />
    </CompanyDashboard>
  );
}

function StandardOverview({
  ctx,
  company,
  cards,
  sources,
  hideEmptyNumbers,
}: {
  ctx: Ctx;
  company: CompanyFull;
  cards: MetricCard[];
  sources: ConnectorStatus[];
  hideEmptyNumbers?: boolean;
}) {
  const t = today(ctx);
  return (
    <>
      {!(hideEmptyNumbers && cards.length === 0) && (
        <Section
          title="Key numbers"
          action={
            cards.length > 0 && (
              <span className="flex gap-3 text-[12px]">
                <Link href={`/companies/${company.slug}?tab=numbers`} className="text-accent hover:underline">
                  Numbers grid
                </Link>
                <Link href={`/companies/${company.slug}/numbers/import`} className="text-accent hover:underline">
                  Upload file
                </Link>
              </span>
            )
          }
        >
          {cards.length === 0 ? (
            <div className="card px-4 py-6 text-center text-[13px] text-muted">No numbers are tracked for this company yet.</div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {cards.map((m) => (
                <KpiCard key={m.id} m={m} today={t} connectorNames={CONNECTOR_NAMES} />
              ))}
            </div>
          )}
        </Section>
      )}
      <Section title="Work">
        <div className="grid grid-cols-3 gap-3">
          <Counter label="Open tasks" value={company.openTasks} />
          <Counter label="Overdue" value={company.overdueTasks} risk />
          <Counter label="Active projects" value={company.activeProjects} />
        </div>
      </Section>
      {sources.length > 0 && (
        <Section title="Data sources">
          <div className="card px-4 py-1">
            <DataSources sources={sources} timeZone={ctx.timeZone} />
          </div>
        </Section>
      )}
      {company.units.length > 0 && (
        <Section title="Units (tracked separately)">
          <div className="flex flex-wrap gap-2">
            {company.units.map((u) => (
              <span key={u.id} className="card px-3 py-2 text-[13px] font-medium">
                {u.name} <span className="text-muted">· {u.kind}</span>
              </span>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

const GRID_ROWS: Record<Granularity, number> = { day: 14, week: 12, month: 12 };

async function NumbersTab({ ctx, company, granularity }: { ctx: Ctx; company: CompanyFull; granularity?: string }) {
  const defs = await listMetricDefinitions(ctx, company.id);
  if (defs.length === 0) {
    return <div className="card px-4 py-6 text-center text-[13px] text-muted">No numbers are tracked for this company yet.</div>;
  }
  const available = (["month", "week", "day"] as const).filter((x) => defs.some((d) => d.granularity === x));
  const g: Granularity = available.includes(granularity as Granularity) ? (granularity as Granularity) : available[0]!;
  const metrics = defs.filter((d) => d.granularity === g);
  // Rows end at the last period that may be entered: today (daily), the last finished week / month.
  const periods = lastPeriods(lastEnterablePeriod(today(ctx), g), g, GRID_ROWS[g]).reverse();
  const current = await currentValues(ctx.db, metrics.map((m) => m.id), { from: periods.at(-1)!, to: periods[0]! });
  const values = Object.fromEntries([...current.entries()].map(([k, v]) => [k, formatMetricInput(v)]));
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {available.map((x) => (
          <Link
            key={x}
            href={`/companies/${company.slug}?tab=numbers&g=${x}`}
            aria-current={x === g ? "page" : undefined}
            className={`btn btn-sm ${x === g ? "btn-primary" : ""}`}
          >
            {GRANULARITY_LABELS[x]}
          </Link>
        ))}
        <Link href={`/companies/${company.slug}/numbers/import`} className="btn btn-sm ml-auto">
          Upload file
        </Link>
      </div>
      <NumbersGrid
        key={g}
        companyId={company.id}
        metrics={metrics.map((m) => ({ id: m.id, label: m.label, unit: m.unit }))}
        rows={periods.map((p) => ({ period: p, label: formatPeriodShort(p, g) }))}
        values={values}
      />
      {g === "day" && <MonthTotalsGrid ctx={ctx} companyId={company.id} metrics={metrics} />}
    </>
  );
}

/** Finished months offered for month totals of daily numbers. */
const MONTH_TOTAL_ROWS = 3;

/**
 * "Month totals" under the daily grid: one value per finished month for each daily number
 * (a total, an average for avg numbers, the end-of-month value for last). Used only by AI
 * roles that accept monthly totals when the days are incomplete; never part of the days.
 */
async function MonthTotalsGrid({ ctx, companyId, metrics }: { ctx: Ctx; companyId: string; metrics: MetricView[] }) {
  const months = lastPeriods(lastEnterablePeriod(today(ctx), "month"), "month", MONTH_TOTAL_ROWS).reverse();
  const current = await currentValues(ctx.db, metrics.map((m) => m.id), { from: months.at(-1)!, to: months[0]! }, "month_total");
  const values = Object.fromEntries([...current.entries()].map(([k, v]) => [k, formatMetricInput(v)]));
  return (
    <section className="mt-6" aria-labelledby="month-totals-heading">
      <h3 id="month-totals-heading" className="eyebrow mb-1">
        Month totals
      </h3>
      <p className="mb-2 text-[12px] text-muted">
        When some days are missing, an AI role set to accept monthly totals uses the number entered here (complete days always win). It is never added to
        the days above.
      </p>
      <NumbersGrid
        kind="month_total"
        label="Month totals"
        periodHeader="Month"
        companyId={companyId}
        metrics={metrics.map((m) => ({ id: m.id, label: `${m.label} · month ${monthTotalKind(m.aggregation)}`, unit: m.unit }))}
        rows={months.map((p) => ({ period: p, label: formatPeriodShort(p, "month") }))}
        values={values}
      />
    </section>
  );
}

function Counter({ label, value, risk }: { label: string; value: number; risk?: boolean }) {
  return (
    <div className="card p-4">
      <p className="eyebrow">{label}</p>
      <p className={`num mt-1 text-[22px] font-semibold ${risk && value > 0 ? "text-risk" : ""}`}>{value}</p>
    </div>
  );
}

async function ProjectsTab({ ctx, companyId }: { ctx: Awaited<ReturnType<typeof getPageContext>>; companyId: string }) {
  const projects = await listProjects(ctx, { companyId });
  return (
    <>
      <div className="mb-4">
        <NewProjectForm companyId={companyId} />
      </div>
      {projects.length === 0 ? (
        <div className="card px-4 py-6 text-center text-[13px] text-muted">No projects yet.</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      )}
    </>
  );
}

async function PeopleTab({ ctx, companyId, slug }: { ctx: Awaited<ReturnType<typeof getPageContext>>; companyId: string; slug: string }) {
  const [showSalary, headcount] = await Promise.all([canViewSalaries(ctx), companyHeadcount(ctx, companyId)]);
  const people = await listPeople(ctx, { companyId }, { salaryScope: `company:${slug}` });
  const allPositions = await orgPositionsForPeople(ctx, people.map((p) => p.id));
  // On a company's tab: only this company's positions.
  const positions = Object.fromEntries(Object.entries(allPositions).map(([id, list]) => [id, list.filter((o) => o.companySlug === slug)]));
  return (
    <>
      <Section
        title="Headcount"
        count={headcount.total}
        action={
          <Link href={`/people/new?companyId=${companyId}`} className="btn btn-sm">
            <Icon name="plus" size={14} /> Add person
          </Link>
        }
      >
        <div className="flex flex-wrap gap-2" data-testid="headcount">
          {headcount.byUnit.map((u) => (
            <div key={u.unitId ?? "none"} className="card min-w-[120px] px-3 py-2">
              <p className="eyebrow">{u.unitName}</p>
              <p className="num text-[20px] font-semibold">{u.count}</p>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[12px] text-muted">Active people; founders are not counted.</p>
      </Section>
      <Section title="People">
        <PeopleTable people={people} showSalary={showSalary} showCompany={false} positions={positions} empty="No active people in this company." />
        <p className="mt-2 text-[12px] text-muted">
          <Link href={`/people?companyId=${companyId}&status=left`} className="hover:underline">
            People who left
          </Link>
        </p>
      </Section>
    </>
  );
}

async function TasksTab({ ctx, companyId }: { ctx: Awaited<ReturnType<typeof getPageContext>>; companyId: string }) {
  const [tasks, options] = await Promise.all([listTasks(ctx, { companyId, status: "open" }), getTaskFormOptions(ctx)]);
  return (
    <>
      <div className="mb-4">
        <NewTaskPanel options={options} defaults={{ visibility: "shared", companyId }} />
      </div>
      <TaskList
        tasks={tasks.map(toTaskItem)}
        today={today(ctx)}
        options={options}
        showCompany={false}
        empty="No open tasks for this company."
      />
    </>
  );
}

async function AiRolesTab({ ctx, company }: { ctx: Ctx; company: CompanyFull }) {
  if (!canUseAiRoles(ctx)) {
    return <div className="card px-4 py-6 text-center text-[13px] text-muted">Only the founders can see AI roles.</div>;
  }
  const hires = await listHires(ctx, { companyId: company.id });
  const runs = new Map(await Promise.all(hires.map(async (h) => [h.id, await listHireRuns(ctx, h.id, 6)] as const)));
  const hiredAnalyst = hires.some((h) => h.templateKey === FINANCIAL_ANALYST);
  return (
    <Section
      title="AI roles working for this company"
      count={hires.length}
      action={
        <Link href={`/ai-roles?hire=${FINANCIAL_ANALYST}&company=${company.id}`} className="btn btn-sm">
          {hiredAnalyst ? "Tune the Financial Analyst" : "Hire the Financial Analyst"}
        </Link>
      }
    >
      {hires.length === 0 ? (
        <div className="card px-4 py-6 text-center text-[13px] text-muted">
          No AI role works for {company.name} yet. The Financial Analyst checks the month&apos;s numbers, chases what is missing and reports what needs attention.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {hires.map((h) => (
            <div key={h.id} className="card p-4" data-testid="company-hire">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{h.roleName}</span>
                <Tag tone={h.status === "active" ? "ok" : "neutral"}>{h.status === "active" ? "Active" : "Paused"}</Tag>
                <span className="text-[12px] text-muted">
                  {h.scheduleLabel} · reports to {h.recipientNames.join(" and ")}
                </span>
              </div>
              <ul className="mt-2 flex flex-col gap-1 text-[13px]">
                {(runs.get(h.id) ?? []).map((r) => (
                  <li key={r.id}>
                    <Link href={`/ai-roles/runs/${r.id}`} className="flex flex-wrap items-center gap-2 hover:underline">
                      <span className="font-medium">{r.periodLabel}</span> <RunStatusTag status={r.status} /> <span className="text-muted">{r.summary}</span>
                    </Link>
                  </li>
                ))}
                {h.templateKey === ORG_STRUCTURE_EXPERT ? (
                  <li>
                    <Link href={`/companies/${company.slug}?tab=org`} className="text-accent hover:underline">
                      Its findings are on the Org structure tab
                    </Link>
                  </li>
                ) : (
                  (runs.get(h.id) ?? []).length === 0 && <li className="text-muted">No report yet — it runs {h.scheduleLabel.toLowerCase()}.</li>
                )}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

/** The company's org chart (the same board as /org, without the company switcher). */
async function OrgTab({ ctx, company, unitSlug, archived }: { ctx: Ctx; company: CompanyFull; unitSlug?: string; archived: boolean }) {
  const unit = company.units.find((u) => u.slug === unitSlug) ?? null;
  const hrefFor = ({ unit: u, archived: a }: { unit?: string | null; archived?: boolean }) => {
    const params = new URLSearchParams({ tab: "org" });
    const slug = u === undefined ? unit?.slug : u;
    if (slug) params.set("unit", slug);
    if (a) params.set("archived", "1");
    return `/companies/${company.slug}?${params.toString()}`;
  };
  return (
    <>
      <p className="mb-3 text-[12px] text-muted">
        <Link href={`/org?company=${company.slug}`} className="text-accent hover:underline">
          Open on the Org structure page
        </Link>{" "}
        (all companies)
      </p>
      <OrgWorkspace ctx={ctx} company={company} unit={unit} showArchived={archived} hrefFor={hrefFor} />
    </>
  );
}
