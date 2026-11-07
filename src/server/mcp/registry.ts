import "server-only";
import { z } from "zod";
import { TASK_ESTIMATE_VALUES, TASK_PRIORITY_VALUES, TASK_STATUS_VALUES, type TaskUpdateInput } from "@/lib/schemas";
import type { Db } from "@/server/db/connect";
import type { ServiceContext } from "@/server/services/context";
import { toServiceError, ServiceError } from "@/server/services/errors";
import { listFounders, listPeople } from "@/server/services/people";
import { createProject, getProject, listProjects, type ProjectView } from "@/server/services/projects";
import { addTaskComment } from "@/server/services/task-comments";
import { changeTaskStatus, createTask, findTaskByKey, getTask, listTasks, updateTask, type TaskView } from "@/server/services/tasks";
import { listLabels } from "@/server/services/task-labels";
import { listCompanies } from "@/server/services/companies";
import { normalizeName, pickOne, resolveAssignee, resolveCompany, resolveProject, type AssigneeRef } from "./resolve";

/**
 * The ONE tool registry of Founder Cockpit, shared by the Claude connector (MCP, src/server/mcp/tools.ts)
 * and the in-app AI assistant (src/server/assistant). Every tool is a thin wrapper over the services
 * and runs as the signed-in founder (ServiceContext), so the normal access rules apply — private
 * todos stay private to their owner, salaries are never read, and everything the services refuse is
 * refused here with the same message.
 *
 * Read tools have `run`. Write tools are split in two: `prepare` resolves names and validates
 * WITHOUT writing (returning a stored plan and a preview card), `commit` writes the plan. MCP runs
 * both back to back (Claude asks the user itself); the assistant shows the preview and only commits
 * when the founder clicks the card's button (services/assistant confirm token).
 */

export type ToolSurface = "mcp" | "assistant";
/** Groups for the assistant's tool router (only relevant groups are sent to the model). */
export type ToolGroup = "core" | "tasks" | "projects" | "routines";

export interface ToolEnv {
  ctx: ServiceContext;
  /** Public base URL of the app, for links. */
  baseUrl: string;
}

export interface ToolOutput {
  /** One-paragraph human summary (first line of the MCP text result). */
  summary: string;
  data: unknown;
}

export interface PreviewField {
  label: string;
  value: string;
}

/** The confirm card the assistant shows before any write. */
export interface ActionPreview {
  title: string;
  fields: PreviewField[];
  /** Label of the confirm button ("Create", "Save changes", ...). */
  confirm: string;
}

interface ToolBase<S extends z.ZodRawShape> {
  name: string;
  title: string;
  /** Full description (MCP). */
  description: string;
  /** Short description for the assistant's model (fewer tokens). */
  brief: string;
  input: S;
  surfaces: readonly ToolSurface[];
  group: ToolGroup;
  idempotent?: boolean;
}

export interface ReadTool<S extends z.ZodRawShape = z.ZodRawShape> extends ToolBase<S> {
  kind: "read";
  run(env: ToolEnv, args: z.infer<z.ZodObject<S>>): Promise<ToolOutput>;
}

export interface WriteTool<S extends z.ZodRawShape = z.ZodRawShape, P = unknown> extends ToolBase<S> {
  kind: "write";
  prepare(env: ToolEnv, args: z.infer<z.ZodObject<S>>): Promise<{ plan: P; preview: ActionPreview }>;
  commit(env: ToolEnv, plan: P): Promise<ToolOutput>;
}

export type AnyTool = ReadTool<z.ZodRawShape> | WriteTool<z.ZodRawShape, unknown>;

export function readTool<S extends z.ZodRawShape>(t: Omit<ReadTool<S>, "kind">): AnyTool {
  return { ...t, kind: "read" } as unknown as AnyTool;
}

export function writeTool<S extends z.ZodRawShape, P>(t: Omit<WriteTool<S, P>, "kind">): AnyTool {
  return { ...t, kind: "write" } as unknown as AnyTool;
}

/** Runs a write tool in one step (MCP): prepare, then commit. */
export async function runNow(tool: AnyTool, env: ToolEnv, args: unknown): Promise<ToolOutput> {
  if (tool.kind === "read") return tool.run(env, args as never);
  const { plan } = await tool.prepare(env, args as never);
  return tool.commit(env, plan);
}

/** ServiceError → its message; anything else → logged and a generic message. */
export function toolErrorMessage(err: unknown, tag = "tools"): string {
  const se = toServiceError(err);
  if (se) return se.message;
  if (err instanceof z.ZodError) return `Invalid input: ${err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`;
  console.error(`[${tag}] unexpected error`, err instanceof Error ? err.name : typeof err);
  return "Unexpected error in Founder Cockpit; nothing more was saved. Try again.";
}

export const MAX_TASKS = 100;
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
/** Old names ("normal", "waiting") are still understood. */
const priorityInput = z.preprocess((v) => (v === "normal" ? "medium" : v), z.enum(TASK_PRIORITY_VALUES));
const statusInput = z.preprocess((v) => (v === "waiting" ? "in_review" : v === "canceled" ? "cancelled" : v), z.enum(TASK_STATUS_VALUES));
const estimateInput = z.number().int().refine((n) => (TASK_ESTIMATE_VALUES as readonly number[]).includes(n), { message: "Use 1, 2, 3, 5, 8 or 13" });

export const taskInput = z.object({
  title: z.string().trim().min(1).max(300).describe("What has to be done"),
  assignee: z
    .string()
    .max(200)
    .optional()
    .describe("Who does it: a founder's name (Nuraaly, Talant), 'me', or the name of a person who works at the company. Omit to leave it unassigned."),
  due_date: isoDate.optional().describe("Deadline, YYYY-MM-DD"),
  priority: priorityInput.optional().describe("none (default) | urgent | high | medium | low"),
  status: statusInput.optional().describe("backlog | todo (default) | in_progress | in_review | done | cancelled"),
  estimate: estimateInput.optional().describe("Estimate points 1, 2, 3, 5, 8 or 13 (1 point = 1 working hour)"),
  labels: z.array(z.string().min(1).max(40)).max(10).optional().describe("Label names, e.g. ['Operations']"),
  notes: z.string().max(5000).optional().describe("Details, links, acceptance criteria"),
  private: z.boolean().optional().describe("true = a personal todo only you can see (cannot be assigned to anyone else). Default false (shared company task)."),
});
type TaskInput = z.infer<typeof taskInput>;

/** Label names → ids (case-insensitive, active labels only); unknown names list the labels there are. */
export async function resolveLabels(ctx: ServiceContext, names: readonly string[] | undefined): Promise<{ id: string; name: string }[]> {
  if (!names?.length) return [];
  const all = await listLabels(ctx);
  return [...new Set(names.map((n) => n.trim()).filter(Boolean))].map((n) =>
    pickOne(n, all.map((l) => ({ value: { id: l.id, name: l.name }, label: l.name, keys: [l.id, normalizeName(l.name)] })), "label"),
  );
}

/** A task by id or key ("UPS-12"). */
export async function resolveTaskRef(ctx: ServiceContext, ref: string): Promise<TaskView> {
  if (/^[0-9a-f-]{36}$/i.test(ref.trim())) return getTask(ctx, ref.trim());
  const t = await findTaskByKey(ctx, ref);
  if (!t) throw new ServiceError("not_found", `No task ${ref.trim().toUpperCase()} (use the id or key from list_tasks)`);
  return t;
}

const STATUS_WORDS: Record<string, string> = { backlog: "Backlog", todo: "Todo", in_progress: "In Progress", in_review: "In Review", done: "Done", cancelled: "Canceled" };
const statusWord = (s: string) => STATUS_WORDS[s] ?? s;

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

export function taskOut(t: TaskView, base: string) {
  return {
    id: t.id,
    key: t.key,
    title: t.title,
    status: t.status,
    priority: t.priority,
    estimate: t.estimate,
    labels: t.labels.map((l) => l.name),
    due_date: t.dueDate,
    overdue: t.isOverdue,
    over_estimate: t.overEstimate,
    private: t.visibility === "private",
    company: t.company?.name ?? null,
    project: t.project ? { id: t.project.id, name: t.project.name } : null,
    assignee: t.assignee ? `${t.assignee.name}${t.assignee.kind === "user" ? " (founder)" : ""}` : null,
    needs_review: t.assignee?.kind === "person" ? t.needsReview : undefined,
    notes: t.notes,
    url: `${base}/tasks/${t.id}`,
  };
}

function projectOut(p: ProjectView, base: string) {
  return {
    id: p.id,
    name: p.name,
    company: p.companyName,
    status: p.status,
    description: p.description,
    start_date: p.startDate,
    due_date: p.dueDate,
    tasks_total: p.totalTasks,
    tasks_done: p.doneTasks,
    progress_percent: p.progress,
    url: `${base}/projects/${p.id}`,
  };
}

const prio = (p: string | undefined) => (p && p !== "none" ? p : null);

function taskLine(t: TaskView): string {
  const bits = [
    t.assignee ? `→ ${t.assignee.name}` : "unassigned",
    t.status !== "todo" ? statusWord(t.status) : null,
    t.dueDate ? `due ${t.dueDate}` : null,
    prio(t.priority),
    t.estimate ? `▲ ${t.estimate}` : null,
    t.labels.length ? t.labels.map((l) => l.name).join(", ") : null,
  ];
  return `- ${t.key} ${t.title} (${bits.filter(Boolean).join(", ")})`;
}

function plannedLine(t: ResolvedTask): string {
  const i = t.input;
  const bits = [
    t.assignee ? `→ ${t.assignee.name}` : "unassigned",
    i.status && i.status !== "todo" ? statusWord(i.status) : null,
    i.due_date ? `due ${i.due_date}` : null,
    prio(i.priority),
    i.estimate ? `▲ ${i.estimate}` : null,
    t.labels.length ? t.labels.map((l) => l.name).join(", ") : null,
    i.private ? "private" : null,
  ];
  return `${i.title} (${bits.filter(Boolean).join(", ")})`;
}

// ---------------------------------------------------------------------------
// Task creation shared by create_project and add_tasks
// ---------------------------------------------------------------------------

interface ResolvedTask {
  input: TaskInput;
  assignee: AssigneeRef | null;
  labels: { id: string; name: string }[];
}

/** Resolves every task's assignee and labels first, reporting all problems at once (nothing is written). */
async function resolveTasks(ctx: ServiceContext, items: TaskInput[], company: { id: string; name: string } | null): Promise<ResolvedTask[]> {
  const problems: string[] = [];
  const out: ResolvedTask[] = [];
  for (const [i, t] of items.entries()) {
    let assignee: AssigneeRef | null = null;
    let labels: { id: string; name: string }[] = [];
    if (t.assignee && t.assignee.trim()) {
      try {
        assignee = await resolveAssignee(ctx, t.assignee, company?.id ?? null, company?.name);
      } catch (err) {
        const se = toServiceError(err);
        if (!se) throw err;
        problems.push(`Task ${i + 1} “${t.title}”: ${se.message}`);
      }
    }
    try {
      labels = await resolveLabels(ctx, t.labels);
    } catch (err) {
      const se = toServiceError(err);
      if (!se) throw err;
      problems.push(`Task ${i + 1} “${t.title}”: ${se.message}`);
    }
    if (t.private && assignee && !(assignee.kind === "user" && assignee.id === ctx.user.id)) {
      problems.push(`Task ${i + 1} “${t.title}”: a private todo can only be assigned to you; drop "private" to assign it to ${assignee.name}.`);
    }
    out.push({ input: t, assignee, labels });
  }
  if (problems.length) throw new ServiceError("validation", `Nothing was saved.\n${problems.join("\n")}`);
  return out;
}

async function insertTasks(tx: ServiceContext, project: { id: string | null; companyId: string | null }, items: ResolvedTask[]): Promise<TaskView[]> {
  const created: TaskView[] = [];
  for (const { input, assignee, labels } of items) {
    created.push(
      await createTask(tx, {
        title: input.title,
        notes: input.notes ?? null,
        dueDate: input.due_date ?? null,
        priority: input.priority ?? "none",
        status: input.status ?? "todo",
        estimate: input.estimate ?? null,
        labelIds: labels.map((l) => l.id),
        visibility: input.private ? "private" : "shared",
        companyId: project.companyId,
        projectId: project.id,
        assigneeUserId: assignee?.kind === "user" ? assignee.id : null,
        assigneePersonId: assignee?.kind === "person" ? assignee.id : null,
      }),
    );
  }
  return created;
}

export function inTransaction<T>(ctx: ServiceContext, fn: (tx: ServiceContext) => Promise<T>): Promise<T> {
  return ctx.db.transaction(async (raw) => fn({ ...ctx, db: raw as unknown as Db }));
}

const tasksField = (items: ResolvedTask[]): PreviewField[] => (items.length ? [{ label: `Tasks (${items.length})`, value: items.map(plannedLine).join("\n") }] : []);


// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

const BOTH = ["mcp", "assistant"] as const;

const listCompaniesTool = readTool({
  name: "list_companies",
  title: "List companies",
  description: "The group's companies (name, slug). Use the name in other tools.",
  brief: "The group's companies.",
  input: {},
  surfaces: BOTH,
  group: "core",
  async run({ ctx }) {
    const rows = await listCompanies(ctx);
    return { summary: `${rows.length} companies.`, data: rows.map((c) => ({ id: c.id, slug: c.slug, name: c.name, kind: c.kind })) };
  },
});

const listPeopleTool = readTool({
  name: "list_people",
  title: "List people of a company",
  description: "The founders (can be assigned anywhere) and the active people of one company who can be assigned tasks.",
  brief: "Founders and active people of one company (no salaries).",
  input: { company: z.string().min(1).max(200).describe("Company name or slug, e.g. 'Kiwi Go'") },
  surfaces: BOTH,
  group: "core",
  async run({ ctx }, { company }) {
    const c = await resolveCompany(ctx, company);
    const [founders, persons] = await Promise.all([listFounders(ctx), listPeople(ctx, { companyId: c.id })]);
    const staff = persons
      .filter((p) => !p.isUser)
      .map((p) => ({ id: p.id, name: p.fullName, short_name: p.shortName, roles: p.roles.filter((r) => r.isActive).map((r) => [r.role, r.title].filter(Boolean).join(" — ")) }));
    return {
      summary: `${c.name}: ${founders.length} founders, ${staff.length} people.`,
      data: { company: c.name, founders: founders.map((f) => ({ id: f.id, name: f.shortName, full_name: f.name })), people: staff },
    };
  },
});

const listProjectsTool = readTool({
  name: "list_projects",
  title: "List projects",
  description: "Projects with progress, optionally of one company.",
  brief: "Projects with progress, optionally of one company.",
  input: { company: z.string().max(200).optional().describe("Company name or slug; omit for all companies") },
  surfaces: BOTH,
  group: "projects",
  async run({ ctx, baseUrl }, { company }) {
    const c = company ? await resolveCompany(ctx, company) : null;
    const rows = await listProjects(ctx, c ? { companyId: c.id } : {});
    return { summary: `${rows.length} projects${c ? ` in ${c.name}` : ""}.`, data: rows.map((p) => projectOut(p, baseUrl)) };
  },
});

const getProjectTool = readTool({
  name: "get_project",
  title: "Get a project",
  description: "One project with all its tasks (that you can see).",
  brief: "One project with its tasks.",
  input: {
    project: z.string().min(1).max(300).describe("Project id or name"),
    company: z.string().max(200).optional().describe("Company name, to tell same-named projects apart"),
  },
  surfaces: BOTH,
  group: "projects",
  async run({ ctx, baseUrl }, { project, company }) {
    const c = company ? await resolveCompany(ctx, company) : null;
    const ref = await resolveProject(ctx, project, c?.id);
    const [p, tasks] = await Promise.all([getProject(ctx, ref.id), listTasks(ctx, { projectId: ref.id, status: "any", limit: 500 })]);
    return { summary: `Project “${p.name}” (${p.companyName}): ${p.doneTasks}/${p.totalTasks} done.`, data: { ...projectOut(p, baseUrl), tasks: tasks.map((t) => taskOut(t, baseUrl)) } };
  },
});

const listTasksTool = readTool({
  name: "list_tasks",
  title: "List tasks",
  description:
    "Tasks you can see, filtered. Default: open tasks (not done or cancelled). Statuses: backlog, todo, in_progress, in_review, done, cancelled; " +
    "'active' = todo + in_progress + in_review. Each task has a key like UPS-12 (usable as the id in other tools).",
  brief: "Tasks you can see, filtered. Default: open tasks.",
  input: {
    company: z.string().max(200).optional().describe("Company name or slug"),
    project: z.string().max(300).optional().describe("Project id or name"),
    assignee: z.string().max(200).optional().describe("Founder name, 'me', or a person's name"),
    status: z
      .preprocess((v) => (v === "waiting" ? "in_review" : v), z.enum([...TASK_STATUS_VALUES, "open", "active", "any"]))
      .optional()
      .describe("open (default) | active | any | backlog | todo | in_progress | in_review | done | cancelled"),
    priority: priorityInput.optional().describe("none | urgent | high | medium | low"),
    label: z.string().max(40).optional().describe("Only tasks with this label"),
    search: z.string().max(200).optional().describe("Words of the title, or a key like UPS-12"),
    overdue: z.boolean().optional().describe("true = only open tasks past their deadline"),
    over_estimate: z.boolean().optional().describe("true = only tasks in progress longer than their estimate"),
    limit: z.number().int().min(1).max(200).optional().describe("At most this many (default 50)"),
  },
  surfaces: BOTH,
  group: "core",
  async run({ ctx, baseUrl }, args) {
    const c = args.company ? await resolveCompany(ctx, args.company) : null;
    const p = args.project ? await resolveProject(ctx, args.project, c?.id) : null;
    const who = args.assignee ? await resolveAssignee(ctx, args.assignee, c?.id ?? "any", c?.name) : null;
    const labels = args.label ? await resolveLabels(ctx, [args.label]) : [];
    // The assignee is filtered in SQL, so it is never lost behind the first 500 rows.
    const rows = await listTasks(ctx, {
      companyId: c?.id ?? p?.companyId,
      projectId: p?.id,
      assigneeUserId: who?.kind === "user" ? who.id : undefined,
      assigneePersonId: who?.kind === "person" ? who.id : undefined,
      status: args.overdue ? "open" : (args.status ?? "open"),
      priority: args.priority,
      labelIds: labels.map((l) => l.id),
      q: args.search,
      overEstimate: args.over_estimate,
      view: args.overdue ? "overdue" : undefined,
      limit: 500,
    });
    const limit = args.limit ?? 50;
    const shown = rows.slice(0, limit);
    const total = rows.length >= 500 ? "500+" : String(rows.length);
    const more = rows.length > shown.length ? ` (showing ${shown.length}; ask with a higher limit or narrower filters)` : "";
    return { summary: `${total} tasks${more}.`, data: shown.map((t) => taskOut(t, baseUrl)) };
  },
});

interface CreateProjectPlan {
  company: { id: string; name: string };
  name: string;
  description: string | null;
  startDate: string | null;
  dueDate: string | null;
  tasks: ResolvedTask[];
}

const createProjectTool = writeTool({
  name: "create_project",
  title: "Create a project with tasks",
  description:
    "Saves a plan to Founder Cockpit: creates a project in a company and its tasks in one step (all or nothing). " +
    "Assignees are founders (Nuraaly, Talant, or 'me') or people who work at that company, by name. " +
    "If a company or assignee name is ambiguous or unknown, nothing is saved and the answer lists the candidates — ask the user and call again. " +
    "Returns the project and task links.",
  brief: "Create a project in a company with its tasks.",
  input: {
    company: z.string().min(1).max(200).describe("Company name or slug, e.g. 'Kiwi Go'"),
    name: z.string().trim().min(1).max(200).describe("Project name"),
    description: z.string().max(5000).optional().describe("Goal / context of the project"),
    start_date: isoDate.optional().describe("YYYY-MM-DD"),
    due_date: isoDate.optional().describe("Project deadline, YYYY-MM-DD"),
    tasks: z.array(taskInput).max(MAX_TASKS).optional().describe("The plan's tasks"),
  },
  surfaces: BOTH,
  group: "projects",
  async prepare({ ctx }, args): Promise<{ plan: CreateProjectPlan; preview: ActionPreview }> {
    const c = await resolveCompany(ctx, args.company);
    const items = await resolveTasks(ctx, args.tasks ?? [], c);
    if (args.start_date && args.due_date && args.due_date < args.start_date) throw new ServiceError("validation", "Due date is before start date");
    const plan: CreateProjectPlan = {
      company: { id: c.id, name: c.name },
      name: args.name,
      description: args.description ?? null,
      startDate: args.start_date ?? null,
      dueDate: args.due_date ?? null,
      tasks: items,
    };
    return {
      plan,
      preview: {
        title: "New project",
        confirm: "Create",
        fields: [
          { label: "Company", value: c.name },
          { label: "Project", value: args.name },
          ...(plan.dueDate ? [{ label: "Due", value: plan.dueDate }] : []),
          ...(plan.description ? [{ label: "Goal", value: plan.description }] : []),
          ...tasksField(items),
        ],
      },
    };
  },
  async commit({ ctx, baseUrl: base }, plan: CreateProjectPlan) {
    const { project, tasks } = await inTransaction(ctx, async (tx) => {
      const p = await createProject(tx, {
        companyId: plan.company.id,
        name: plan.name,
        description: plan.description,
        startDate: plan.startDate,
        dueDate: plan.dueDate,
      });
      return { project: p, tasks: await insertTasks(tx, { id: p.id, companyId: p.companyId }, plan.tasks) };
    });
    const fresh = await getProject(ctx, project.id);
    const summary = [`Created project “${fresh.name}” in ${plan.company.name} with ${tasks.length} task${tasks.length === 1 ? "" : "s"}: ${base}/projects/${fresh.id}`, ...tasks.map(taskLine)].join("\n");
    return { summary, data: { project: projectOut(fresh, base), tasks: tasks.map((t) => taskOut(t, base)) } };
  },
});

interface AddTasksPlan {
  project: { id: string; name: string; companyId: string; companyName: string };
  tasks: ResolvedTask[];
}

const addTasksTool = writeTool({
  name: "add_tasks",
  title: "Add tasks to a project",
  description: "Adds tasks to an existing project (all or nothing). Same assignee rules as create_project.",
  brief: "Add tasks to an existing project.",
  input: {
    project: z.string().min(1).max(300).describe("Project id or name"),
    company: z.string().max(200).optional().describe("Company name, to tell same-named projects apart"),
    tasks: z.array(taskInput).min(1).max(MAX_TASKS),
  },
  surfaces: BOTH,
  group: "tasks",
  async prepare({ ctx }, args): Promise<{ plan: AddTasksPlan; preview: ActionPreview }> {
    const c = args.company ? await resolveCompany(ctx, args.company) : null;
    const p = await resolveProject(ctx, args.project, c?.id);
    const items = await resolveTasks(ctx, args.tasks, { id: p.companyId, name: p.companyName });
    return {
      plan: { project: p, tasks: items },
      preview: { title: items.length === 1 ? "New task" : "New tasks", confirm: "Create", fields: [{ label: "Project", value: `${p.name} (${p.companyName})` }, ...tasksField(items)] },
    };
  },
  async commit({ ctx, baseUrl: base }, { project: p, tasks: items }: AddTasksPlan) {
    const tasks = await inTransaction(ctx, (tx) => insertTasks(tx, { id: p.id, companyId: p.companyId }, items));
    const summary = [`Added ${tasks.length} task${tasks.length === 1 ? "" : "s"} to “${p.name}” (${p.companyName}): ${base}/projects/${p.id}`, ...tasks.map(taskLine)].join("\n");
    return { summary, data: tasks.map((t) => taskOut(t, base)) };
  },
});

interface CreateTaskPlan {
  company: { id: string; name: string } | null;
  task: ResolvedTask;
}

const createTaskTool = writeTool({
  name: "create_task",
  title: "Create a task",
  description:
    "Creates one task in a company (no project needed), or a private personal todo (private: true, no company needed). " +
    "Same assignee rules as create_project; status, priority, estimate points and labels are optional.",
  brief: "Create one task in a company (or a private todo).",
  input: {
    company: z.string().max(200).optional().describe("Company name or slug (required unless private)"),
    ...taskInput.shape,
  },
  surfaces: BOTH,
  group: "tasks",
  async prepare({ ctx }, { company, ...t }): Promise<{ plan: CreateTaskPlan; preview: ActionPreview }> {
    const c = company ? await resolveCompany(ctx, company) : null;
    if (!c && !t.private) throw new ServiceError("validation", "Name the company (or make it a private todo)");
    const [item] = await resolveTasks(ctx, [t], c ? { id: c.id, name: c.name } : null);
    const fields: PreviewField[] = [
      ...(c ? [{ label: "Company", value: c.name }] : [{ label: "Who sees it", value: "Only you (personal todo)" }]),
      { label: "Task", value: t.title },
      ...(item!.assignee ? [{ label: "Assignee", value: item!.assignee.name }] : []),
      ...(t.status ? [{ label: "Status", value: statusWord(t.status) }] : []),
      ...(prio(t.priority) ? [{ label: "Priority", value: prio(t.priority)! }] : []),
      ...(t.estimate ? [{ label: "Estimate", value: `▲ ${t.estimate} (${t.estimate} h)` }] : []),
      ...(item!.labels.length ? [{ label: "Labels", value: item!.labels.map((l) => l.name).join(", ") }] : []),
      ...(t.due_date ? [{ label: "Due", value: t.due_date }] : []),
    ];
    return { plan: { company: c ? { id: c.id, name: c.name } : null, task: item! }, preview: { title: "New task", confirm: "Create", fields } };
  },
  async commit({ ctx, baseUrl: base }, plan: CreateTaskPlan) {
    const [t] = await inTransaction(ctx, (tx) => insertTasks(tx, { id: null, companyId: plan.company?.id ?? null }, [plan.task]));
    return { summary: `Created ${t!.key} “${t!.title}”: ${base}/tasks/${t!.id}`, data: taskOut(t!, base) };
  },
});

interface UpdateTaskPlan {
  id: string;
  patch: TaskUpdateInput;
}

const updateTaskTool = writeTool({
  name: "update_task",
  title: "Update a task",
  description:
    "Changes a task's title, notes, status, priority, estimate, labels, deadline, assignee or 'needs review'. Only the fields given change; " +
    "null clears notes, due_date, estimate or assignee. labels replaces the task's labels ([] removes them all).",
  brief: "Change a task's fields (only those given; null clears).",
  input: {
    id: z.string().min(1).max(60).describe("Task id or key (UPS-12) from list_tasks / get_project"),
    title: z.string().trim().min(1).max(300).optional(),
    notes: z.string().max(5000).nullable().optional(),
    status: statusInput.optional().describe("backlog | todo | in_progress | in_review | done | cancelled"),
    priority: priorityInput.optional().describe("none | urgent | high | medium | low"),
    estimate: estimateInput.nullable().optional().describe("1, 2, 3, 5, 8, 13 points, or null to clear"),
    labels: z.array(z.string().min(1).max(40)).max(10).optional().describe("Label names (replaces the set)"),
    needs_review: z.boolean().optional().describe("Staff tasks: true = «Готово» goes to In Review for a founder to approve"),
    due_date: isoDate.nullable().optional().describe("YYYY-MM-DD, or null to clear"),
    assignee: z.string().max(200).nullable().optional().describe("Founder name, 'me', a person at the task's company, or null to unassign"),
  },
  surfaces: BOTH,
  group: "tasks",
  async prepare({ ctx }, { id: ref, ...f }): Promise<{ plan: UpdateTaskPlan; preview: ActionPreview }> {
    const current = await resolveTaskRef(ctx, ref);
    const id = current.id;
    const patch: TaskUpdateInput = {};
    const fields: PreviewField[] = [{ label: "Task", value: `${current.key} ${current.title}` }];
    if (f.title !== undefined) {
      patch.title = f.title;
      fields.push({ label: "Title", value: f.title });
    }
    if (f.notes !== undefined) {
      patch.notes = f.notes;
      fields.push({ label: "Notes", value: f.notes ?? "(cleared)" });
    }
    if (f.status !== undefined) {
      patch.status = f.status;
      fields.push({ label: "Status", value: `${statusWord(current.status)} → ${statusWord(f.status)}` });
    }
    if (f.priority !== undefined) {
      patch.priority = f.priority;
      fields.push({ label: "Priority", value: `${current.priority} → ${f.priority}` });
    }
    if (f.estimate !== undefined) {
      patch.estimate = f.estimate;
      fields.push({ label: "Estimate", value: `${current.estimate ? `▲ ${current.estimate}` : "none"} → ${f.estimate ? `▲ ${f.estimate}` : "none"}` });
    }
    if (f.labels !== undefined) {
      const labels = await resolveLabels(ctx, f.labels);
      patch.labelIds = labels.map((l) => l.id);
      fields.push({ label: "Labels", value: `${current.labels.map((l) => l.name).join(", ") || "none"} → ${labels.map((l) => l.name).join(", ") || "none"}` });
    }
    if (f.needs_review !== undefined) {
      patch.needsReview = f.needs_review;
      fields.push({ label: "Needs review", value: f.needs_review ? "yes" : "no" });
    }
    if (f.due_date !== undefined) {
      patch.dueDate = f.due_date;
      fields.push({ label: "Due", value: `${current.dueDate ?? "none"} → ${f.due_date ?? "none"}` });
    }
    if (f.assignee !== undefined) {
      if (f.assignee === null || !f.assignee.trim()) {
        patch.assigneeUserId = null;
        patch.assigneePersonId = null;
        fields.push({ label: "Assignee", value: "unassigned" });
      } else {
        const who = await resolveAssignee(ctx, f.assignee, current.company?.id ?? null, current.company?.name);
        patch.assigneeUserId = who.kind === "user" ? who.id : null;
        patch.assigneePersonId = who.kind === "person" ? who.id : null;
        fields.push({ label: "Assignee", value: `${current.assignee?.name ?? "unassigned"} → ${who.name}` });
      }
    }
    if (Object.keys(patch).length === 0) throw new ServiceError("validation", "Nothing to update");
    return { plan: { id, patch }, preview: { title: "Change task", confirm: "Save changes", fields } };
  },
  async commit({ ctx, baseUrl: base }, { id, patch }: UpdateTaskPlan) {
    const t = await updateTask(ctx, id, patch);
    return { summary: `Updated ${t.key} “${t.title}”: ${base}/tasks/${t.id}`, data: taskOut(t, base) };
  },
});

const completeTaskTool = writeTool({
  name: "complete_task",
  title: "Complete a task",
  description: "Marks a task done (also approves a task In Review).",
  brief: "Mark a task done.",
  input: { id: z.string().min(1).max(60).describe("Task id or key (UPS-12)") },
  surfaces: BOTH,
  group: "tasks",
  idempotent: true,
  async prepare({ ctx }, { id: ref }): Promise<{ plan: { id: string }; preview: ActionPreview }> {
    const t = await resolveTaskRef(ctx, ref);
    return {
      plan: { id: t.id },
      preview: { title: "Complete task", confirm: "Mark done", fields: [{ label: "Task", value: `${t.key} ${t.title}` }, ...(t.assignee ? [{ label: "Assignee", value: t.assignee.name }] : [])] },
    };
  },
  async commit({ ctx, baseUrl: base }, { id }: { id: string }) {
    const t = await changeTaskStatus(ctx, id, "done");
    return { summary: `Done: ${t.key} “${t.title}”.`, data: taskOut(t, base) };
  },
});

const addTaskCommentTool = writeTool({
  name: "add_task_comment",
  title: "Comment on a task",
  description: "Adds a comment to a task (shown in the task's activity and, for staff tasks, in the delivery trail).",
  brief: "Comment on a task.",
  input: { id: z.string().min(1).max(60).describe("Task id or key (UPS-12)"), text: z.string().trim().min(1).max(4000).describe("The comment") },
  surfaces: BOTH,
  group: "tasks",
  async prepare({ ctx }, { id: ref, text }): Promise<{ plan: { id: string; text: string }; preview: ActionPreview }> {
    const t = await resolveTaskRef(ctx, ref);
    return { plan: { id: t.id, text }, preview: { title: "Comment on task", confirm: "Add comment", fields: [{ label: "Task", value: `${t.key} ${t.title}` }, { label: "Comment", value: text }] } };
  },
  async commit({ ctx, baseUrl: base }, { id, text }: { id: string; text: string }) {
    const c = await addTaskComment(ctx, id, text);
    const t = await getTask(ctx, id);
    return { summary: `Comment added to “${t.title}”: ${base}/tasks/${t.id}`, data: { comment_id: c.id, task: taskOut(t, base) } };
  },
});


/** Connector + assistant tools over tasks and projects. Routine tools are added by the assistant. */
export const COCKPIT_TOOLS: readonly AnyTool[] = [
  listCompaniesTool,
  listPeopleTool,
  listProjectsTool,
  getProjectTool,
  listTasksTool,
  createProjectTool,
  addTasksTool,
  createTaskTool,
  updateTaskTool,
  completeTaskTool,
  addTaskCommentTool,
];
