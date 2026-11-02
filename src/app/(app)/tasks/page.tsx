import { NewTaskPanel } from "@/components/tasks/NewTaskPanel";
import { TaskFilters } from "@/components/tasks/TaskFilters";
import { TaskList } from "@/components/tasks/TaskList";
import { toTaskItem } from "@/components/tasks/types";
import { PageHeader, TabNav } from "@/components/ui";
import { TASK_VIEWS, taskFiltersSchema, type TaskView } from "@/lib/schemas";
import { getPageContext } from "@/server/context";
import { today } from "@/server/services/context";
import { getTaskFormOptions } from "@/server/services/options";
import { listTasks } from "@/server/services/tasks";

export const metadata = { title: "Tasks" };

const VIEW_LABELS: Record<TaskView, string> = {
  my: "My todos",
  assigned: "Assigned to me",
  company: "All company tasks",
  overdue: "Overdue",
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
      <TabNav active={view} tabs={TASK_VIEWS.map((v) => ({ key: v, label: VIEW_LABELS[v], href: qs(v) }))} />
      <TaskFilters view={view} companies={options.companies} values={{ companyId, status, priority }} />
      <p className="eyebrow mb-2">
        <span className="num">{tasks.length}</span> {tasks.length === 1 ? "task" : "tasks"}
      </p>
      <TaskList tasks={tasks.map(toTaskItem)} today={today(ctx)} options={options} empty={EMPTY[view]} />
    </>
  );
}
