import "server-only";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { TASK_PRIORITY_VALUES, TASK_STATUS_VALUES, type TaskUpdateInput } from "@/lib/schemas";
import type { Db } from "@/server/db/connect";
import type { ServiceContext } from "@/server/services/context";
import { toServiceError, ServiceError } from "@/server/services/errors";
import { listPeople } from "@/server/services/people";
import { createProject, getProject, listProjects, type ProjectView } from "@/server/services/projects";
import { addTaskComment } from "@/server/services/task-comments";
import { changeTaskStatus, createTask, getTask, listTasks, updateTask, type TaskView } from "@/server/services/tasks";
import { listCompanies } from "@/server/services/companies";
import { listFounders } from "@/server/services/people";
import { resolveAssignee, resolveCompany, resolveProject, type AssigneeRef } from "./resolve";

/**
 * The Founder Cockpit MCP tools. Thin wrappers over the services: every call runs as the founder
 * who authorized the connector (ServiceContext), so the normal access rules apply — private
 * todos stay private to that founder, tasks for staff are shared company tasks, and everything
 * the services refuse is refused here with the same message.
 */

export const SERVER_INSTRUCTIONS = [
  "Founder Cockpit is the task and project tracker of the Asqa Zou group founders (Nuraaly and Talant).",
  "Use create_project to save a plan: one project in a company with its tasks; each task can be assigned to a founder or to a person who works at that company, and the Cockpit then chases the assignees (Telegram reminders).",
  "Companies, projects and assignees are given by name; when a name is ambiguous or unknown the tool answers with the candidates — ask the user which one is meant, then call again with the full name.",
  "Dates are YYYY-MM-DD in the group's timezone. Tasks are shared with the other founder unless private is true (a personal todo, which can only be assigned to the founder themself).",
].join(" ");

const MAX_TASKS = 100;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const taskInput = z.object({
  title: z.string().trim().min(1).max(300).describe("What has to be done"),
  assignee: z
    .string()
    .max(200)
    .optional()
    .describe("Who does it: a founder's name (Nuraaly, Talant), 'me', or the name of a person who works at the company. Omit to leave it unassigned."),
  due_date: isoDate.optional().describe("Deadline, YYYY-MM-DD"),
  priority: z.enum(TASK_PRIORITY_VALUES).optional().describe("urgent | high | normal (default) | low"),
  notes: z.string().max(5000).optional().describe("Details, links, acceptance criteria"),
  private: z.boolean().optional().describe("true = a personal todo only you can see (cannot be assigned to anyone else). Default false (shared company task)."),
});
type TaskInput = z.infer<typeof taskInput>;

export interface ToolEnv {
  ctx: ServiceContext;
  /** Public base URL of the app, for links. */
  baseUrl: string;
}

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

function taskOut(t: TaskView, base: string) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    due_date: t.dueDate,
    overdue: t.isOverdue,
    private: t.visibility === "private",
    company: t.company?.name ?? null,
    project: t.project ? { id: t.project.id, name: t.project.name } : null,
    assignee: t.assignee ? `${t.assignee.name}${t.assignee.kind === "user" ? " (founder)" : ""}` : null,
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

function result(summary: string, data: unknown): CallToolResult {
  return { content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }] };
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    const se = toServiceError(err);
    if (se) return failure(se.message);
    console.error("[mcp] unexpected error", err);
    return failure("Unexpected error in Founder Cockpit; nothing more was saved. Try again.");
  }
}

function taskLine(t: TaskView): string {
  const bits = [t.assignee ? `→ ${t.assignee.name}` : "unassigned", t.dueDate ? `due ${t.dueDate}` : null, t.priority !== "normal" ? t.priority : null];
  return `- ${t.title} (${bits.filter(Boolean).join(", ")})`;
}

// ---------------------------------------------------------------------------
// Task creation shared by create_project and add_tasks
// ---------------------------------------------------------------------------

interface ResolvedTask {
  input: TaskInput;
  assignee: AssigneeRef | null;
}

/** Resolves every task's assignee first, reporting all problems at once (nothing is written). */
async function resolveTasks(ctx: ServiceContext, items: TaskInput[], company: { id: string; name: string }): Promise<ResolvedTask[]> {
  const problems: string[] = [];
  const out: ResolvedTask[] = [];
  for (const [i, t] of items.entries()) {
    let assignee: AssigneeRef | null = null;
    if (t.assignee && t.assignee.trim()) {
      try {
        assignee = await resolveAssignee(ctx, t.assignee, company.id, company.name);
      } catch (err) {
        const se = toServiceError(err);
        if (!se) throw err;
        problems.push(`Task ${i + 1} “${t.title}”: ${se.message}`);
      }
    }
    if (t.private && assignee && !(assignee.kind === "user" && assignee.id === ctx.user.id)) {
      problems.push(`Task ${i + 1} “${t.title}”: a private todo can only be assigned to you; drop "private" to assign it to ${assignee.name}.`);
    }
    out.push({ input: t, assignee });
  }
  if (problems.length) throw new ServiceError("validation", `Nothing was saved.\n${problems.join("\n")}`);
  return out;
}

async function insertTasks(tx: ServiceContext, project: { id: string; companyId: string }, items: ResolvedTask[]): Promise<TaskView[]> {
  const created: TaskView[] = [];
  for (const { input, assignee } of items) {
    created.push(
      await createTask(tx, {
        title: input.title,
        notes: input.notes ?? null,
        dueDate: input.due_date ?? null,
        priority: input.priority ?? "normal",
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

function inTransaction<T>(ctx: ServiceContext, fn: (tx: ServiceContext) => Promise<T>): Promise<T> {
  return ctx.db.transaction(async (raw) => fn({ ...ctx, db: raw as unknown as Db }));
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export function buildCockpitServer({ ctx, baseUrl: base }: ToolEnv): McpServer {
  const server = new McpServer({ name: "founder-cockpit", title: "Founder Cockpit", version: "1.0.0" }, { instructions: SERVER_INSTRUCTIONS });
  const read = { readOnlyHint: true, openWorldHint: false } as const;
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

  server.registerTool(
    "list_companies",
    { title: "List companies", description: "The group's companies (name, slug). Use the name in other tools.", inputSchema: {}, annotations: read },
    () =>
      run(async () => {
        const rows = await listCompanies(ctx);
        return result(`${rows.length} companies.`, rows.map((c) => ({ id: c.id, slug: c.slug, name: c.name, kind: c.kind })));
      }),
  );

  server.registerTool(
    "list_people",
    {
      title: "List people of a company",
      description: "The founders (can be assigned anywhere) and the active people of one company who can be assigned tasks.",
      inputSchema: { company: z.string().min(1).max(200).describe("Company name or slug, e.g. 'Kiwi Go'") },
      annotations: read,
    },
    ({ company }) =>
      run(async () => {
        const c = await resolveCompany(ctx, company);
        const [founders, persons] = await Promise.all([listFounders(ctx), listPeople(ctx, { companyId: c.id })]);
        const staff = persons
          .filter((p) => !p.isUser)
          .map((p) => ({ id: p.id, name: p.fullName, short_name: p.shortName, roles: p.roles.filter((r) => r.isActive).map((r) => [r.role, r.title].filter(Boolean).join(" — ")) }));
        return result(`${c.name}: ${founders.length} founders, ${staff.length} people.`, {
          company: c.name,
          founders: founders.map((f) => ({ id: f.id, name: f.shortName, full_name: f.name })),
          people: staff,
        });
      }),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "Projects with progress, optionally of one company.",
      inputSchema: { company: z.string().max(200).optional().describe("Company name or slug; omit for all companies") },
      annotations: read,
    },
    ({ company }) =>
      run(async () => {
        const c = company ? await resolveCompany(ctx, company) : null;
        const rows = await listProjects(ctx, c ? { companyId: c.id } : {});
        return result(`${rows.length} projects${c ? ` in ${c.name}` : ""}.`, rows.map((p) => projectOut(p, base)));
      }),
  );

  server.registerTool(
    "get_project",
    {
      title: "Get a project",
      description: "One project with all its tasks (that you can see).",
      inputSchema: {
        project: z.string().min(1).max(300).describe("Project id or name"),
        company: z.string().max(200).optional().describe("Company name, to tell same-named projects apart"),
      },
      annotations: read,
    },
    ({ project, company }) =>
      run(async () => {
        const c = company ? await resolveCompany(ctx, company) : null;
        const ref = await resolveProject(ctx, project, c?.id);
        const [p, tasks] = await Promise.all([getProject(ctx, ref.id), listTasks(ctx, { projectId: ref.id, status: "any", limit: 500 })]);
        return result(`Project “${p.name}” (${p.companyName}): ${p.doneTasks}/${p.totalTasks} done.`, { ...projectOut(p, base), tasks: tasks.map((t) => taskOut(t, base)) });
      }),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description: "Tasks you can see, filtered. Default: open tasks (not done or cancelled).",
      inputSchema: {
        company: z.string().max(200).optional().describe("Company name or slug"),
        project: z.string().max(300).optional().describe("Project id or name"),
        assignee: z.string().max(200).optional().describe("Founder name, 'me', or a person's name"),
        status: z.enum([...TASK_STATUS_VALUES, "open", "any"]).optional().describe("open (default) | any | todo | in_progress | waiting | done | cancelled"),
        overdue: z.boolean().optional().describe("true = only open tasks past their deadline"),
        limit: z.number().int().min(1).max(200).optional().describe("At most this many (default 50)"),
      },
      annotations: read,
    },
    (args) =>
      run(async () => {
        const c = args.company ? await resolveCompany(ctx, args.company) : null;
        const p = args.project ? await resolveProject(ctx, args.project, c?.id) : null;
        const who = args.assignee ? await resolveAssignee(ctx, args.assignee, c?.id ?? "any", c?.name) : null;
        const rows = await listTasks(ctx, {
          companyId: c?.id ?? p?.companyId,
          projectId: p?.id,
          status: args.overdue ? "open" : (args.status ?? "open"),
          view: args.overdue ? "overdue" : undefined,
          limit: 500,
        });
        const filtered = who ? rows.filter((t) => t.assignee?.kind === who.kind && t.assignee.id === who.id) : rows;
        const limit = args.limit ?? 50;
        const shown = filtered.slice(0, limit);
        const more = filtered.length > shown.length ? ` (showing ${shown.length}; ask with a higher limit or narrower filters)` : "";
        return result(`${filtered.length} tasks${more}.`, shown.map((t) => taskOut(t, base)));
      }),
  );

  server.registerTool(
    "create_project",
    {
      title: "Create a project with tasks",
      description:
        "Saves a plan to Founder Cockpit: creates a project in a company and its tasks in one step (all or nothing). " +
        "Assignees are founders (Nuraaly, Talant, or 'me') or people who work at that company, by name. " +
        "If a company or assignee name is ambiguous or unknown, nothing is saved and the answer lists the candidates — ask the user and call again. " +
        "Returns the project and task links.",
      inputSchema: {
        company: z.string().min(1).max(200).describe("Company name or slug, e.g. 'Kiwi Go'"),
        name: z.string().trim().min(1).max(200).describe("Project name"),
        description: z.string().max(5000).optional().describe("Goal / context of the project"),
        start_date: isoDate.optional().describe("YYYY-MM-DD"),
        due_date: isoDate.optional().describe("Project deadline, YYYY-MM-DD"),
        tasks: z.array(taskInput).max(MAX_TASKS).optional().describe("The plan's tasks"),
      },
      annotations: write,
    },
    (args) =>
      run(async () => {
        const c = await resolveCompany(ctx, args.company);
        const items = await resolveTasks(ctx, args.tasks ?? [], c);
        const { project, tasks } = await inTransaction(ctx, async (tx) => {
          const p = await createProject(tx, {
            companyId: c.id,
            name: args.name,
            description: args.description ?? null,
            startDate: args.start_date ?? null,
            dueDate: args.due_date ?? null,
          });
          return { project: p, tasks: await insertTasks(tx, { id: p.id, companyId: p.companyId }, items) };
        });
        const fresh = await getProject(ctx, project.id);
        const summary = [`Created project “${fresh.name}” in ${c.name} with ${tasks.length} task${tasks.length === 1 ? "" : "s"}: ${base}/projects/${fresh.id}`, ...tasks.map(taskLine)].join("\n");
        return result(summary, { project: projectOut(fresh, base), tasks: tasks.map((t) => taskOut(t, base)) });
      }),
  );

  server.registerTool(
    "add_tasks",
    {
      title: "Add tasks to a project",
      description: "Adds tasks to an existing project (all or nothing). Same assignee rules as create_project.",
      inputSchema: {
        project: z.string().min(1).max(300).describe("Project id or name"),
        company: z.string().max(200).optional().describe("Company name, to tell same-named projects apart"),
        tasks: z.array(taskInput).min(1).max(MAX_TASKS),
      },
      annotations: write,
    },
    (args) =>
      run(async () => {
        const c = args.company ? await resolveCompany(ctx, args.company) : null;
        const p = await resolveProject(ctx, args.project, c?.id);
        const items = await resolveTasks(ctx, args.tasks, { id: p.companyId, name: p.companyName });
        const tasks = await inTransaction(ctx, (tx) => insertTasks(tx, { id: p.id, companyId: p.companyId }, items));
        const summary = [`Added ${tasks.length} task${tasks.length === 1 ? "" : "s"} to “${p.name}” (${p.companyName}): ${base}/projects/${p.id}`, ...tasks.map(taskLine)].join("\n");
        return result(summary, tasks.map((t) => taskOut(t, base)));
      }),
  );

  server.registerTool(
    "update_task",
    {
      title: "Update a task",
      description: "Changes a task's title, notes, status, priority, deadline or assignee. Only the fields given change; null clears notes, due_date or assignee.",
      inputSchema: {
        id: z.uuid().describe("Task id (from list_tasks / get_project)"),
        title: z.string().trim().min(1).max(300).optional(),
        notes: z.string().max(5000).nullable().optional(),
        status: z.enum(TASK_STATUS_VALUES).optional(),
        priority: z.enum(TASK_PRIORITY_VALUES).optional(),
        due_date: isoDate.nullable().optional().describe("YYYY-MM-DD, or null to clear"),
        assignee: z.string().max(200).nullable().optional().describe("Founder name, 'me', a person at the task's company, or null to unassign"),
      },
      annotations: write,
    },
    ({ id, ...f }) =>
      run(async () => {
        const current = await getTask(ctx, id);
        const patch: TaskUpdateInput = {};
        if (f.title !== undefined) patch.title = f.title;
        if (f.notes !== undefined) patch.notes = f.notes;
        if (f.status !== undefined) patch.status = f.status;
        if (f.priority !== undefined) patch.priority = f.priority;
        if (f.due_date !== undefined) patch.dueDate = f.due_date;
        if (f.assignee !== undefined) {
          if (f.assignee === null || !f.assignee.trim()) {
            patch.assigneeUserId = null;
            patch.assigneePersonId = null;
          } else {
            const who = await resolveAssignee(ctx, f.assignee, current.company?.id ?? null, current.company?.name);
            patch.assigneeUserId = who.kind === "user" ? who.id : null;
            patch.assigneePersonId = who.kind === "person" ? who.id : null;
          }
        }
        if (Object.keys(patch).length === 0) throw new ServiceError("validation", "Nothing to update");
        const t = await updateTask(ctx, id, patch);
        return result(`Updated “${t.title}”: ${base}/tasks/${t.id}`, taskOut(t, base));
      }),
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete a task",
      description: "Marks a task done.",
      inputSchema: { id: z.uuid().describe("Task id") },
      annotations: { ...write, idempotentHint: true },
    },
    ({ id }) =>
      run(async () => {
        const t = await changeTaskStatus(ctx, id, "done");
        return result(`Done: “${t.title}”.`, taskOut(t, base));
      }),
  );

  server.registerTool(
    "add_task_comment",
    {
      title: "Comment on a task",
      description: "Adds a comment to a task (shown on the task page and, for staff tasks, in the delivery trail).",
      inputSchema: { id: z.uuid().describe("Task id"), text: z.string().trim().min(1).max(4000).describe("The comment") },
      annotations: write,
    },
    ({ id, text }) =>
      run(async () => {
        const c = await addTaskComment(ctx, id, text);
        const t = await getTask(ctx, id);
        return result(`Comment added to “${t.title}”: ${base}/tasks/${t.id}`, { comment_id: c.id, task: taskOut(t, base) });
      }),
  );

  return server;
}
