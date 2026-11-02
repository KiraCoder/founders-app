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
import { kpisFor } from "@/lib/kpis";
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
  { key: "projects", label: "Projects" },
  { key: "tasks", label: "Tasks" },
  { key: "people", label: "People" },
  { key: "org", label: "Org structure" },
  { key: "documents", label: "Documents" },
  { key: "ai", label: "AI roles" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ tab?: string }> };

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
  const { tab: rawTab } = await searchParams;
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

      {tab === "overview" && <Overview company={company} />}
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

function Overview({ company }: { company: Awaited<ReturnType<typeof getCompanyBySlug>> }) {
  const kpis = kpisFor(company.slug);
  const unitName = (slug?: string) => company.units.find((u) => u.slug === slug)?.name;
  return (
    <>
      <Section title="Key numbers">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {kpis.map((k) => (
            <div key={`${k.key}-${k.unit ?? ""}`} className="card p-4">
              <p className="eyebrow">
                {k.label}
                {k.unit ? ` · ${unitName(k.unit) ?? k.unit}` : ""}
              </p>
              <p className="num mt-2 text-[24px] font-semibold text-muted">—</p>
              <div className="mt-2 flex items-center justify-between gap-2">
                <Tag tone="warn">No data yet</Tag>
                <span className="text-[11px] text-muted">{k.source}</span>
              </div>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Work">
        <div className="grid grid-cols-3 gap-3">
          <Counter label="Open tasks" value={company.openTasks} />
          <Counter label="Overdue" value={company.overdueTasks} risk />
          <Counter label="Active projects" value={company.activeProjects} />
        </div>
      </Section>
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
