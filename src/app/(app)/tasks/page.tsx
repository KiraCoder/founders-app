import { NewTaskPanel } from "@/components/tasks/NewTaskPanel";
import { TaskFilters } from "@/components/tasks/TaskFilters";
import { TaskList } from "@/components/tasks/TaskList";
import { TeamBoard } from "@/components/tasks/TeamBoard";
import { TeamFilters } from "@/components/tasks/TeamFilters";
import { toTaskItem } from "@/components/tasks/types";
import { PageHeader, TabNav } from "@/components/ui";
import { TASK_VIEWS, taskFiltersSchema, type TaskView } from "@/lib/schemas";
import { getPageContext } from "@/server/context";
import { today } from "@/server/services/context";
import { getTaskFormOptions } from "@/server/services/options";
import { listTasks } from "@/server/services/tasks";
import { canSeeTeamTasks } from "@/server/services/access";
import { getTeamTasks, teamTaskFiltersSchema } from "@/server/services/team-tasks";

export const metadata = { title: "Tasks" };

const VIEW_LABELS: Record<TaskView | "team", string> = {
  my: "My todos",
  assigned: "Assigned to me",
  company: "All company tasks",
  overdue: "Overdue",
  team: "Team",
};

const EMPTY: Record<TaskView, string> = {
  my: "No personal todos match. Personal todos are visible only to you.",
  assigned: "Nothing assigned to you matches these filters.",
  company: "No company tasks match these filters.",
  overdue: "Nothing overdue.",
};

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function TasksPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : undefined);
  if (str("view") === "team") {
    const ctx = await getPageContext();
    if (canSeeTeamTasks(ctx)) return <TeamTasksView ctx={ctx} str={str} />;
  }
  const view: TaskView = (TASK_VIEWS as readonly string[]).includes(str("view") ?? "") ? (str("view") as TaskView) : "my";
  const companyId = str("company");
  const status = str("status") ?? "open";
  const priority = str("priority");

  // Bad query-string values fall back to the view only instead of erroring.
  const parsed = taskFiltersSchema.safeParse({ view, companyId, status, priority });
  const filters = parsed.success ? parsed.data : { view };

  const ctx = await getPageContext();
  const [options, tasks] = await Promise.all([
    getTaskFormOptions(ctx),
    listTasks(ctx, filters),
  ]);

  const qs = (v: string) => {
    const p = new URLSearchParams({ view: v });
    if (companyId) p.set("company", companyId);
    if (status !== "open") p.set("status", status);
    if (priority) p.set("priority", priority);
    return `/tasks?${p}`;
  };

  return (
    <>
      <PageHeader eyebrow="Workspace" title="Tasks" />
      <div className="mb-4">
        <NewTaskPanel
          options={options}
          defaults={{ visibility: view === "my" ? "private" : "shared", companyId: companyId }}
        />
      </div>
      <TabNav active={view} tabs={tabsFor(canSeeTeamTasks(ctx), qs)} />
      <TaskFilters view={view} companies={options.companies} values={{ companyId, status, priority }} />
      <p className="eyebrow mb-2">
        <span className="num">{tasks.length}</span> {tasks.length === 1 ? "task" : "tasks"}
      </p>
      <TaskList tasks={tasks.map(toTaskItem)} today={today(ctx)} options={options} empty={EMPTY[view]} />
    </>
  );
}

function tabsFor(team: boolean, qs: (v: string) => string) {
  const views: (TaskView | "team")[] = team ? [...TASK_VIEWS, "team"] : [...TASK_VIEWS];
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
      <PageHeader eyebrow="Workspace" title="Tasks" />
      <div className="mb-4">
        <NewTaskPanel options={options} defaults={{ visibility: "shared", companyId: f.companyId }} />
      </div>
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
      <TeamBoard groups={board.groups} today={board.today} options={options} />
    </>
  );
}
