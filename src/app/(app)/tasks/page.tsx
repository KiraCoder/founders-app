import Link from "next/link";
import { NewTaskPanel } from "@/components/tasks/NewTaskPanel";
import { PRIORITY_OPTIONS, STATUS_OPTIONS } from "@/components/tasks/labels";
import { TaskList } from "@/components/tasks/TaskList";
import { EstimateIcon, PriorityIcon, StatusIcon } from "@/components/tasks/TaskIcons";
import { TeamBoard, TeamCapNotice } from "@/components/tasks/TeamBoard";
import { TeamFilters } from "@/components/tasks/TeamFilters";
import { toTaskItem } from "@/components/tasks/types";
import { CompanyDot, InitialsAvatar, PageHeader } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { ListToolbar, type FilterField, type ToolbarChip } from "@/components/ui/ListToolbar";
import { toolbarChip } from "@/components/ui/toolbar-chip";
import { DEFAULT_HIDDEN_PROPERTIES, parseTaskListParams } from "@/lib/task-list-params";
import { getPageContext } from "@/server/context";
import { canSeeTeamTasks } from "@/server/services/access";
import { today } from "@/server/services/context";
import { getTaskFormOptions, type TaskFormOptions } from "@/server/services/options";
import { countTasksByStatus, listTasks, openTaskAssignees } from "@/server/services/tasks";
import { getTeamTasks, teamTaskFiltersSchema } from "@/server/services/team-tasks";

export const metadata = { title: "Tasks" };

type SP = Promise<Record<string, string | string[] | undefined>>;

const GROUPINGS = [
  { value: "status", label: "Status" },
  { value: "assignee", label: "Assignee" },
  { value: "priority", label: "Priority" },
  { value: "company", label: "Company" },
  { value: "project", label: "Project" },
  { value: "none", label: "No grouping" },
];
const ORDERINGS = [
  { value: "priority", label: "Priority" },
  { value: "due", label: "Due date" },
  { value: "updated", label: "Last updated" },
  { value: "created", label: "Created" },
];
const PROPERTIES = [
  { value: "key", label: "Key" },
  { value: "priority", label: "Priority" },
  { value: "labels", label: "Labels" },
  { value: "company", label: "Company" },
  { value: "project", label: "Project" },
  { value: "due", label: "Due date" },
  { value: "estimate", label: "Estimate" },
  { value: "assignee", label: "Assignee" },
  { value: "created", label: "Created" },
  { value: "updated", label: "Updated" },
  { value: "activity", label: "Activity" },
];

/** The Filter menu's properties and their values. */
function filterFields(options: TaskFormOptions, people: { kind: "user" | "person"; id: string; name: string }[]): FilterField[] {
  const persons = [
    ...options.founders.map((f) => ({ value: `user:${f.id}`, label: f.shortName, icon: <InitialsAvatar name={f.shortName} size="xs" /> })),
    ...people.filter((p) => p.kind === "person").map((p) => ({ value: `person:${p.id}`, label: p.name, icon: <InitialsAvatar name={p.name} size="xs" tone="neutral" /> })),
  ];
  return [
    { param: "status", label: "Status", icon: <StatusIcon status="in_progress" size={12} />, options: STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label, icon: <StatusIcon status={o.value} /> })) },
    { param: "priority", label: "Priority", icon: <PriorityIcon priority="high" size={12} />, options: PRIORITY_OPTIONS.map((o) => ({ value: o.value, label: o.label, icon: <PriorityIcon priority={o.value} /> })) },
    { param: "assignee", label: "Assignee", options: [{ value: "unassigned", label: "No assignee" }, ...persons] },
    { param: "company", label: "Company", options: options.companies.map((c) => ({ value: c.id, label: c.name, icon: <CompanyDot color={c.color} size={8} /> })) },
    { param: "project", label: "Project", options: options.projects.map((p) => ({ value: p.id, label: p.name })) },
    { param: "label", label: "Labels", options: options.labels.map((l) => ({ value: l.id, label: l.name, icon: <span className="size-2.5 rounded-full" style={{ background: l.color }} /> })) },
    {
      param: "due",
      label: "Due date",
      options: [
        { value: "overdue", label: "Overdue" },
        { value: "today", label: "Due today" },
        { value: "week", label: "Due in the next 7 days" },
        { value: "later", label: "Due later" },
        { value: "none", label: "No due date" },
      ],
    },
    {
      param: "estimate",
      label: "Estimate",
      icon: <EstimateIcon />,
      options: [{ value: "0", label: "No estimate" }, ...[1, 2, 3, 5, 8, 13].map((n) => ({ value: String(n), label: `${n} point${n === 1 ? "" : "s"}` }))],
    },
    { param: "over", label: "Over estimate", single: true, options: [{ value: "1", label: "In progress longer than the estimate" }] },
  ];
}

export default async function TasksPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const ctx = await getPageContext();
  const team = canSeeTeamTasks(ctx);
  if (sp.view === "team" && team) return <TeamTasksView ctx={ctx} sp={sp} />;
  const p = parseTaskListParams(sp);
  const countFilters = { ...p.filters, status: undefined, statuses: undefined };
  const [options, tasks, counts, assignees] = await Promise.all([getTaskFormOptions(ctx), listTasks(ctx, p.filters), countTasksByStatus(ctx, countFilters), openTaskAssignees(ctx)]);

  const views: ToolbarChip[] = [
    { value: "active", label: "Active", count: counts.active, icon: <StatusIcon status="in_progress" size={12} /> },
    { value: "backlog", label: "Backlog", count: counts.backlog, icon: <StatusIcon status="backlog" size={12} /> },
    { value: "all", label: "All", count: counts.any },
  ];
  const countOf = (kind: string, id: string) => assignees.find((a) => a.kind === kind && a.id === id)?.count;
  const me = options.founders.find((f) => f.id === ctx.user.id);
  const chosen = (p.query.company ?? "").split(",").filter(Boolean);
  const persons: ToolbarChip[] = [
    { value: "me", label: `${me?.shortName ?? "Me"} (me)`, icon: <InitialsAvatar name={me?.shortName ?? ctx.user.shortName} size="xs" /> },
    ...options.founders.filter((f) => f.id !== ctx.user.id).map((f) => ({ value: `user:${f.id}`, label: f.shortName, count: countOf("user", f.id), icon: <InitialsAvatar name={f.shortName} size="xs" /> })),
    // Company → people: with a company filter, only that company's people.
    ...assignees
      .filter((a) => a.kind === "person" && (!chosen.length || chosen.some((c) => options.peopleByCompany[c]?.some((x) => x.id === a.id))))
      .map((a) => ({ value: `person:${a.id}`, label: a.name, count: a.count, icon: <InitialsAvatar name={a.name} size="xs" tone="neutral" /> })),
  ];
  const points = tasks.reduce((n, t) => n + (t.estimate ?? 0), 0);

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Tasks"
        actions={<NewTaskPanel options={options} defaults={{ visibility: p.who === "me" || !p.companyId ? "private" : "shared", companyId: p.companyId ?? undefined }} />}
      />
      <ListToolbar
        label="Filter tasks"
        path="/tasks"
        query={p.query}
        views={views}
        view="active"
        persons={persons}
        who={p.who}
        filters={filterFields(options, assignees)}
        display={{ groupings: GROUPINGS, orderings: ORDERINGS, properties: PROPERTIES, defaults: { group: "status", order: "priority", hide: [...DEFAULT_HIDDEN_PROPERTIES] } }}
        savedKey={`fc:filters:tasks:${ctx.user.id}`}
        searchPlaceholder="Search title, key, person"
        extra={
          team ? (
            <Link href="/tasks?view=team" className={`${toolbarChip(false)} border-line`}>
              <Icon name="people" size={14} /> Team
            </Link>
          ) : null
        }
      />
      <p className="eyebrow mb-2 flex items-center gap-2">
        <span>
          <span className="num">{tasks.length}</span> {tasks.length === 1 ? "task" : "tasks"}
        </span>
        {points > 0 && (
          <span className="inline-flex items-center gap-1" title="Estimate points (1 point = 1 working hour)">
            · <EstimateIcon /> <span className="num">{points}</span> points
          </span>
        )}
      </p>
      <TaskList
        full
        tasks={tasks.map(toTaskItem)}
        today={today(ctx)}
        options={options}
        empty="No tasks match these filters."
        group={p.group}
        order={p.order}
        hidden={p.hidden as never}
        statusScope={p.statusScope}
        createDefaults={{ companyId: p.companyId }}
      />
    </>
  );
}

/** Team view (founders only): tasks grouped by founder / person, with counts, points and Telegram status. */
async function TeamTasksView({ ctx, sp }: { ctx: Awaited<ReturnType<typeof getPageContext>>; sp: Record<string, string | string[] | undefined> }) {
  const str = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : undefined);
  // Bad query-string values fall back to no filters instead of erroring.
  const raw = { companyId: str("company"), assignee: str("person"), status: str("status"), overdueOnly: str("overdue") };
  const parsed = teamTaskFiltersSchema.safeParse(raw);
  const [options, board] = await Promise.all([getTaskFormOptions(ctx), getTeamTasks(ctx, parsed.success ? raw : {})]);
  const f = board.filters;
  const persons = [
    ...options.founders.map((u) => ({ value: `user:${u.id}`, label: u.shortName })),
    ...[...new Map(Object.values(options.peopleByCompany).flat().map((p) => [p.id, p])).values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ value: `person:${p.id}`, label: p.name })),
  ];
  const total = board.groups.reduce((n, g) => n + g.tasks.length, 0);
  const points = board.groups.reduce((n, g) => n + g.counts.points, 0);

  return (
    <>
      <PageHeader eyebrow="Workspace" title="Tasks" actions={<NewTaskPanel options={options} defaults={{ visibility: "shared", companyId: f.companyId }} />} />
      <nav className="mb-3 flex flex-wrap items-center gap-2" aria-label="Views">
        <div className="flex items-center gap-0.5 rounded-[10px] border border-line bg-sunk p-0.5">
          <Link href="/tasks" className={toolbarChip(false)}>
            <StatusIcon status="in_progress" size={12} /> Active
          </Link>
          <Link href="/tasks?view=backlog" className={toolbarChip(false)}>
            <StatusIcon status="backlog" size={12} /> Backlog
          </Link>
          <Link href="/tasks?view=all" className={toolbarChip(false)}>
            All
          </Link>
          <Link href="/tasks?view=team" aria-current="page" className={toolbarChip(true)}>
            <Icon name="people" size={14} /> Team
          </Link>
        </div>
      </nav>
      <TeamFilters companies={options.companies} persons={persons} values={{ companyId: f.companyId, assignee: f.assignee, status: f.status, overdueOnly: f.overdueOnly }} />
      <p className="eyebrow mb-2">
        <span className="num">{total}</span> {total === 1 ? "task" : "tasks"} · <span className="num">{board.groups.length}</span> {board.groups.length === 1 ? "person" : "people"}
        {points > 0 && (
          <>
            {" "}
            · <span className="num">{points}</span> points open
          </>
        )}
      </p>
      <TeamCapNotice capped={board.capped} limit={board.limit} />
      <TeamBoard groups={board.groups} today={board.today} options={options} />
    </>
  );
}
