import { redirect } from "next/navigation";
import { NewTaskPanel } from "@/components/tasks/NewTaskPanel";
import { TaskList } from "@/components/tasks/TaskList";
import { TeamBoard, TeamCapNotice } from "@/components/tasks/TeamBoard";
import { TeamFilters } from "@/components/tasks/TeamFilters";
import { toTaskItem } from "@/components/tasks/types";
import { filterPeople } from "@/components/tasks/filter-people";
import { FilterBar } from "@/components/ui/FilterBar";
import { PageHeader, TabNav } from "@/components/ui";
import { readListFilters } from "@/lib/list-filters";
import { TASK_QUICK_FILTERS, TASK_SORTS, TASK_STATUS_VALUES, type TaskFilters, type TaskQuickFilter } from "@/lib/schemas";
import { getPageContext } from "@/server/context";
import { today } from "@/server/services/context";
import { getTaskFormOptions } from "@/server/services/options";
import { countTasksByStatus, listTasks } from "@/server/services/tasks";
import { canSeeTeamTasks } from "@/server/services/access";
import { getTeamTasks, teamTaskFiltersSchema } from "@/server/services/team-tasks";

export const metadata = { title: "Tasks" };

/** The page's views: "My tasks" (personal todos + assigned to me + mine without assignee), shared company tasks, Team. */
type PageView = "mine" | "company";
const VIEW_LABELS: Record<PageView | "team", string> = { mine: "My tasks", company: "All company tasks", team: "Team" };

const EMPTY: Record<PageView, string> = {
  mine: "Nothing here. Personal todos are visible only to you; tasks assigned to you show here too.",
  company: "No company tasks match these filters.",
};

/** Old views (bookmarks, links): "My todos" / "Assigned to me" are chips of My tasks now; Overdue is a status tab. */
const OLD_VIEWS: Record<string, Record<string, string>> = {
  my: { view: "mine", quick: "personal" },
  assigned: { view: "mine", quick: "assigned" },
  overdue: { view: "company", status: "overdue" },
};

const STATUS_TABS = ["", "overdue", "done", "any"] as const;
const QUICK_LABELS: Record<TaskQuickFilter, string> = {
  personal: "Personal",
  assigned: "Assigned to me",
  overdue: "Overdue",
  week: "Due this week",
  waiting: "Waiting on person",
  comments: "Has comments",
};
const SORT_LABELS: Record<(typeof TASK_SORTS)[number], string> = { due: "Due soonest", newest: "Newest first", title: "Title" };
const CONDITION_STATUSES = [
  { value: "", label: "Open" },
  { value: "todo", label: "To do" },
  { value: "in_progress", label: "In progress" },
  { value: "waiting", label: "Waiting" },
  { value: "overdue", label: "Overdue" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
  { value: "any", label: "Any status" },
];

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function TasksPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : undefined);
  const ctx = await getPageContext();
  if (str("view") === "team" && canSeeTeamTasks(ctx)) return <TeamTasksView ctx={ctx} str={str} />;
  const old = OLD_VIEWS[str("view") ?? ""];
  if (old) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && k !== "view") p.set(k, v);
    for (const [k, v] of Object.entries(old)) {
      if (k === "view" && v === "mine") continue; // the default view
      p.set(k, k === "quick" && p.get("quick") ? `${p.get("quick")},${v}` : v);
    }
    redirect(`/tasks?${p}`);
  }
  const view: PageView = str("view") === "company" ? "company" : "mine";
  const quickAllowed = view === "mine" ? TASK_QUICK_FILTERS : TASK_QUICK_FILTERS.filter((q) => q !== "personal" && q !== "assigned");
  const lf = readListFilters(sp, { statuses: [...STATUS_TABS, ...TASK_STATUS_VALUES, "open"].filter(Boolean), quick: quickAllowed, sorts: TASK_SORTS });

  const filters: TaskFilters = {
    view,
    companyId: lf.company,
    assigneeUserId: lf.userId,
    assigneePersonId: lf.personId,
    status: (lf.status || "open") as TaskFilters["status"],
    search: lf.search || null,
    quick: lf.quick as TaskQuickFilter[],
    dueFrom: lf.from,
    dueTo: lf.to,
    sort: (lf.sort || null) as TaskFilters["sort"],
  };
  const [options, tasks, counts] = await Promise.all([getTaskFormOptions(ctx), listTasks(ctx, filters), countTasksByStatus(ctx, filters)]);
  const tabCount: Record<(typeof STATUS_TABS)[number], number> = { "": counts.open, overdue: counts.overdue, done: counts.done, any: counts.any };
  const tabLabel: Record<(typeof STATUS_TABS)[number], string> = { "": "Open", overdue: "Overdue", done: "Done", any: "All" };
  const viewHref = (v: PageView | "team") => (v === "team" ? "/tasks?view=team" : v === "mine" ? "/tasks" : `/tasks?view=${v}`);
  const views: (PageView | "team")[] = canSeeTeamTasks(ctx) ? ["mine", "company", "team"] : ["mine", "company"];

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Tasks"
        actions={<NewTaskPanel options={options} defaults={{ visibility: view === "mine" ? "private" : "shared", companyId: lf.company ?? undefined }} />}
      />
      <TabNav active={view} tabs={views.map((v) => ({ key: v, label: VIEW_LABELS[v], href: viewHref(v) }))} />
      <FilterBar
        label="Filter tasks"
        path="/tasks"
        query={{ ...lf.query, ...(view === "company" ? { view } : {}) }}
        keep={["view"]}
        tabs={STATUS_TABS.map((t) => ({ value: t, label: tabLabel[t], count: tabCount[t] }))}
        status={lf.status}
        quick={quickAllowed.map((q) => ({ value: q, label: QUICK_LABELS[q] }))}
        savedKey={`fc:filters:tasks:${ctx.user.id}`}
        searchPlaceholder="Search title, person, company"
        companies={options.companies}
        people={filterPeople(options)}
        statuses={CONDITION_STATUSES}
        dateLabel="Due"
        sorts={TASK_SORTS.map((s) => ({ value: s, label: SORT_LABELS[s] }))}
      />
      <p className="eyebrow mb-2">
        <span className="num">{tasks.length}</span> {tasks.length === 1 ? "task" : "tasks"}
      </p>
      <TaskList tasks={tasks.map(toTaskItem)} today={today(ctx)} options={options} empty={EMPTY[view]} />
    </>
  );
}

function tabsFor(team: boolean, qs: (v: string) => string) {
  const views: (PageView | "team")[] = team ? ["mine", "company", "team"] : ["mine", "company"];
  return views.map((v) => ({ key: v, label: VIEW_LABELS[v], href: v === "team" ? "/tasks?view=team" : qs(v) }));
}

/** Team view (founders only): tasks grouped by founder / person, with counts and Telegram status. */
async function TeamTasksView({
  ctx,
  str,
}: {
  ctx: Awaited<ReturnType<typeof getPageContext>>;
  str: (k: string) => string | undefined;
}) {
  // Bad query-string values fall back to no filters instead of erroring.
  const raw = { companyId: str("company"), assignee: str("person"), status: str("status"), overdueOnly: str("overdue") };
  const parsed = teamTaskFiltersSchema.safeParse(raw);
  const [options, board] = await Promise.all([
    getTaskFormOptions(ctx),
    getTeamTasks(ctx, parsed.success ? raw : {}),
  ]);
  const f = board.filters;
  const persons = [
    ...options.founders.map((u) => ({ value: `user:${u.id}`, label: u.shortName })),
    ...[...new Map(Object.values(options.peopleByCompany).flat().map((p) => [p.id, p])).values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ value: `person:${p.id}`, label: p.name })),
  ];
  const total = board.groups.reduce((n, g) => n + g.tasks.length, 0);
  const tabQs = (v: string) => `/tasks?view=${v}`;

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Tasks"
        actions={<NewTaskPanel options={options} defaults={{ visibility: "shared", companyId: f.companyId }} />}
      />
      <TabNav active="team" tabs={tabsFor(true, tabQs)} />
      <TeamFilters
        companies={options.companies}
        persons={persons}
        values={{ companyId: f.companyId, assignee: f.assignee, status: f.status, overdueOnly: f.overdueOnly }}
      />
      <p className="eyebrow mb-2">
        <span className="num">{total}</span> {total === 1 ? "task" : "tasks"} · <span className="num">{board.groups.length}</span>{" "}
        {board.groups.length === 1 ? "person" : "people"}
      </p>
      <TeamCapNotice capped={board.capped} limit={board.limit} />
      <TeamBoard groups={board.groups} today={board.today} options={options} />
    </>
  );
}
