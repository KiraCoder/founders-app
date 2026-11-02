import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { PeopleTable } from "@/components/people/PeopleTable";
import { NewProjectForm } from "@/components/projects/NewProjectForm";
import { ProjectCard } from "@/components/projects/ProjectCard";
import { NewTaskPanel } from "@/components/tasks/NewTaskPanel";
import { TaskList } from "@/components/tasks/TaskList";
import { toTaskItem } from "@/components/tasks/types";
import { ComingSoon, CompanyDot, PageHeader, Section, TabNav, Tag } from "@/components/ui";
import { DataSources } from "@/components/metrics/DataSources";
import { KpiCard } from "@/components/metrics/KpiCard";
import { NumbersGrid } from "@/components/metrics/NumbersGrid";
import { formatMetricInput, formatPeriodShort, GRANULARITY_LABELS, lastEnterablePeriod, lastPeriods, type Granularity } from "@/lib/metrics";
import { STUB_SPECS } from "@/server/connectors/stubs";
import { listConnectorStatuses } from "@/server/services/connectors";
import { currentValues, listCompanyMetricCards, listMetricDefinitions } from "@/server/services/metrics";
import { getPageContext } from "@/server/context";
import { getCompanyBySlug } from "@/server/services/companies";
import { today } from "@/server/services/context";
import { ServiceError } from "@/server/services/errors";
import { getTaskFormOptions } from "@/server/services/options";
import { companyHeadcount, listPeople } from "@/server/services/people";
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

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ tab?: string; g?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: slug.replace(/-/g, " ") };
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
  const { tab: rawTab, g } = await searchParams;
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

      {tab === "overview" && <Overview ctx={ctx} company={company} />}
      {tab === "numbers" && <NumbersTab ctx={ctx} company={company} granularity={g} />}
      {tab === "projects" && <ProjectsTab ctx={ctx} companyId={company.id} />}
      {tab === "tasks" && <TasksTab ctx={ctx} companyId={company.id} />}
      {tab === "people" && <PeopleTab ctx={ctx} companyId={company.id} slug={company.slug} />}
      {tab === "org" && (
        <ComingSoon title="Org structure">
          Editable org chart based on the Vysotsky model (7 divisions, 21 departments), labels in Russian.
        </ComingSoon>
      )}
      {tab === "documents" && <ComingSoon title="Documents">Contracts, акты and uploaded files for this company.</ComingSoon>}
      {tab === "ai" && (
        <ComingSoon title="AI roles">AI agents hired for this company. They arrive after the AI provider is chosen.</ComingSoon>
      )}
    </>
  );
}

const CONNECTOR_NAMES: Record<string, string> = Object.fromEntries(STUB_SPECS.map((c) => [c.id, c.name]));

type Ctx = Awaited<ReturnType<typeof getPageContext>>;
type CompanyFull = Awaited<ReturnType<typeof getCompanyBySlug>>;

async function Overview({ ctx, company }: { ctx: Ctx; company: CompanyFull }) {
  const [cards, sources] = await Promise.all([
    listCompanyMetricCards(ctx, company.id),
    listConnectorStatuses(ctx, { companyId: company.id }),
  ]);
  const t = today(ctx);
  return (
    <>
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
    </>
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
        <PeopleTable people={people} showSalary={showSalary} showCompany={false} empty="No active people in this company." />
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
