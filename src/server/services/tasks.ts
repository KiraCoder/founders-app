import "server-only";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { cache } from "react";
import {
  taskCreateSchema,
  taskFiltersSchema,
  taskUpdateSchema,
  type TaskCreateInput,
  type TaskFilters,
  type TaskUpdateInput,
} from "@/lib/schemas";
import type { IsoDate } from "@/lib/dates";
import {
  companies,
  orgDepartments,
  people,
  personCompanies,
  projects,
  taskComments,
  taskEvents,
  tasks,
  users,
  type Task,
  type TaskEvent,
  type TaskPriority,
  type TaskStatus,
  type TaskVisibility,
} from "@/server/db/schema";
import { assertCompanyAccess, assertValidId, visibleEventsWhere, visibleTasksWhere } from "./access";
import { today, type ServiceContext } from "./context";
import { ServiceError } from "./errors";
import { CLOSED_STATUSES, isOverdue, nextCompletedAt, thisWeekRange } from "./tasks-rules";
import { assertTaskDepartment } from "./org";
import { parseTaskOverride } from "@/lib/staff-schemas";
import { queueStaffTaskUpdate } from "./task-staff-updates";

/** A task row enriched for display / API output. */
export interface TaskView {
  id: string;
  title: string;
  notes: string | null;
  visibility: TaskVisibility;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: IsoDate | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  ownerUserId: string;
  ownerName: string;
  company: { id: string; slug: string; name: string; color: string } | null;
  project: { id: string; name: string } | null;
  /** Department of the company's org chart ("21 Отдел владельца"), when set. */
  orgDepartment: { id: string; number: number; name: string } | null;
  assignee:
    | { kind: "user"; id: string; name: string }
    | { kind: "person"; id: string; name: string }
    | null;
  isOverdue: boolean;
}

const owner = alias(users, "owner");
const assigneeUser = alias(users, "assignee_user");

const priorityRank = sql<number>`case ${tasks.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`;
const closedRank = sql<number>`case when ${tasks.status} in ('done','cancelled') then 1 else 0 end`;

function baseSelect(ctx: ServiceContext) {
  return ctx.db
    .select({
      task: tasks,
      ownerName: owner.shortName,
      company: {
        id: companies.id,
        slug: companies.slug,
        name: companies.name,
        color: companies.color,
      },
      project: { id: projects.id, name: projects.name },
      orgDepartment: { id: orgDepartments.id, number: orgDepartments.number, name: orgDepartments.name },
      assigneeUserName: assigneeUser.shortName,
      assigneePersonName: people.fullName,
    })
    .from(tasks)
    .innerJoin(owner, eq(owner.id, tasks.ownerUserId))
    .leftJoin(companies, eq(companies.id, tasks.companyId))
    .leftJoin(projects, eq(projects.id, tasks.projectId))
    .leftJoin(orgDepartments, eq(orgDepartments.id, tasks.orgDepartmentId))
    .leftJoin(assigneeUser, eq(assigneeUser.id, tasks.assigneeUserId))
    .leftJoin(people, eq(people.id, tasks.assigneePersonId));
}

type Row = Awaited<ReturnType<ReturnType<typeof baseSelect>["execute"]>>[number];

function toView(row: Row, todayIso: IsoDate): TaskView {
  const t = row.task;
  return {
    id: t.id,
    title: t.title,
    notes: t.notes,
    visibility: t.visibility,
    status: t.status,
    priority: t.priority,
    dueDate: t.dueDate,
    completedAt: t.completedAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    ownerUserId: t.ownerUserId,
    ownerName: row.ownerName,
    company: row.company?.id ? row.company : null,
    project: row.project?.id ? row.project : null,
    orgDepartment: row.orgDepartment?.id ? row.orgDepartment : null,
    assignee: t.assigneeUserId
      ? { kind: "user", id: t.assigneeUserId, name: row.assigneeUserName ?? "?" }
      : t.assigneePersonId
        ? { kind: "person", id: t.assigneePersonId, name: row.assigneePersonName ?? "?" }
        : null,
    isOverdue: isOverdue(t, todayIso),
  };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** "Mine" = assigned to me, or created by me and not assigned to another founder. */
function relevantToMe(ctx: ServiceContext): SQL {
  return or(
    eq(tasks.assigneeUserId, ctx.user.id),
    and(isNull(tasks.assigneeUserId), eq(tasks.ownerUserId, ctx.user.id)),
  )!;
}

const openWhere = () => notInArray(tasks.status, [...CLOSED_STATUSES]);

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

type ParsedTaskFilters = ReturnType<typeof taskFiltersSchema.parse>;

/** Every condition of a task list except its status (the status tabs count across statuses). */
function taskListWhere(ctx: ServiceContext, f: ParsedTaskFilters, todayIso: IsoDate): (SQL | undefined)[] {
  const where: (SQL | undefined)[] = [
    visibleTasksWhere(ctx),
    // Tasks of archived companies are hidden (personal todos have no company).
    sql`(${tasks.companyId} is null or ${tasks.companyId} in (select ${companies.id} from ${companies} where ${companies.archivedAt} is null))`,
  ];
  const personal = and(eq(tasks.visibility, "private"), eq(tasks.ownerUserId, ctx.user.id));
  const assignedToMe = eq(tasks.assigneeUserId, ctx.user.id);

  switch (f.view) {
    case "mine":
      where.push(or(personal, assignedToMe, and(eq(tasks.ownerUserId, ctx.user.id), isNull(tasks.assigneeUserId), isNull(tasks.assigneePersonId))));
      break;
    case "my":
      where.push(eq(tasks.visibility, "private"), eq(tasks.ownerUserId, ctx.user.id));
      break;
    case "assigned":
      where.push(eq(tasks.assigneeUserId, ctx.user.id));
      break;
    case "company":
      where.push(eq(tasks.visibility, "shared"));
      break;
    case "overdue":
      where.push(openWhere(), lt(tasks.dueDate, todayIso));
      break;
  }
  if (f.companyId) where.push(eq(tasks.companyId, f.companyId));
  if (f.projectId) where.push(eq(tasks.projectId, f.projectId));
  if (f.assigneeUserId) where.push(eq(tasks.assigneeUserId, f.assigneeUserId));
  // A person's task (the view shows a founder assignee first when both are set).
  if (f.assigneePersonId) where.push(isNull(tasks.assigneeUserId), eq(tasks.assigneePersonId, f.assigneePersonId));
  if (f.priority) where.push(eq(tasks.priority, f.priority));
  if (f.q) where.push(ilike(tasks.title, `%${escapeLike(f.q)}%`));
  if (f.search) {
    const like = `%${escapeLike(f.search)}%`;
    where.push(or(ilike(tasks.title, like), ilike(people.fullName, like), ilike(assigneeUser.shortName, like), ilike(companies.name, like)));
  }
  if (f.dueFrom) where.push(gte(tasks.dueDate, f.dueFrom));
  if (f.dueTo) where.push(lte(tasks.dueDate, f.dueTo));
  const week = thisWeekRange(todayIso);
  for (const q of new Set(f.quick ?? [])) {
    if (q === "personal") where.push(personal);
    else if (q === "assigned") where.push(assignedToMe);
    else if (q === "overdue") where.push(openWhere(), lt(tasks.dueDate, todayIso));
    else if (q === "week") where.push(gte(tasks.dueDate, todayIso), lte(tasks.dueDate, week.to));
    // Waiting on a person: open and assigned to a staff member (they answer through the bot).
    else if (q === "waiting") where.push(openWhere(), isNull(tasks.assigneeUserId), isNotNull(tasks.assigneePersonId));
    else if (q === "comments") where.push(sql`exists (select 1 from ${taskComments} where ${taskComments.taskId} = ${tasks.id})`);
  }
  return where;
}

function statusWhere(status: ParsedTaskFilters["status"], todayIso: IsoDate): SQL | undefined {
  if (status === "open") return openWhere();
  if (status === "overdue") return and(openWhere(), lt(tasks.dueDate, todayIso));
  if (status && status !== "any") return eq(tasks.status, status);
  return undefined;
}

export async function listTasks(ctx: ServiceContext, rawFilters: TaskFilters = {}): Promise<TaskView[]> {
  const f = taskFiltersSchema.parse(rawFilters);
  const todayIso = today(ctx);
  const where = [...taskListWhere(ctx, f, todayIso), statusWhere(f.status, todayIso)];
  const order =
    f.sort === "newest"
      ? [desc(tasks.createdAt)]
      : f.sort === "title"
        ? [asc(sql`lower(${tasks.title})`), desc(tasks.createdAt)]
        : [asc(closedRank), sql`${tasks.dueDate} asc nulls last`, asc(priorityRank), desc(tasks.createdAt)];
  const rows = await baseSelect(ctx)
    .where(and(...where))
    .orderBy(...order)
    .limit(f.limit ?? 200);
  return rows.map((r) => toView(r, todayIso));
}

export interface TaskStatusCounts {
  open: number;
  overdue: number;
  done: number;
  any: number;
}

/** The status tabs' counts for a list (same filters, every status), in one query. */
export async function countTasksByStatus(ctx: ServiceContext, rawFilters: TaskFilters = {}): Promise<TaskStatusCounts> {
  const f = taskFiltersSchema.parse(rawFilters);
  const todayIso = today(ctx);
  const open = sql`${tasks.status} not in ('done', 'cancelled')`;
  const [row] = await ctx.db
    .select({
      open: sql<number>`count(*) filter (where ${open})`.mapWith(Number),
      overdue: sql<number>`count(*) filter (where ${open} and ${tasks.dueDate} < ${todayIso})`.mapWith(Number),
      done: sql<number>`count(*) filter (where ${tasks.status} = 'done')`.mapWith(Number),
      any: sql<number>`count(*)`.mapWith(Number),
    })
    .from(tasks)
    .leftJoin(companies, eq(companies.id, tasks.companyId))
    .leftJoin(assigneeUser, eq(assigneeUser.id, tasks.assigneeUserId))
    .leftJoin(people, eq(people.id, tasks.assigneePersonId))
    .where(and(...taskListWhere(ctx, f, todayIso)));
  return row ?? { open: 0, overdue: 0, done: 0, any: 0 };
}

/** Returns the task or throws not_found (also for private tasks of the other founder). */
/**
 * One visible task. Deduped per render (React `cache`): the task page and the services it calls
 * (comments, deadline requests, timeline, checklist) all check access through it. Server actions
 * and API routes run outside a render, so a write followed by a read always sees the new row.
 */
export const getTask = cache(async (ctx: ServiceContext, id: string): Promise<TaskView> => {
  assertValidId(id, "Task");
  const [row] = await baseSelect(ctx).where(and(eq(tasks.id, id), visibleTasksWhere(ctx)));
  if (!row) throw new ServiceError("not_found", "Task not found");
  return toView(row, today(ctx));
});

/**
 * Visible tasks (access rule + archived companies hidden, like listTasks) matching extra
 * conditions, in list order. Read-only building block for other views (services/team-tasks.ts).
 */
export async function queryVisibleTasks(ctx: ServiceContext, extra: (SQL | undefined)[], limit = 1000): Promise<TaskView[]> {
  const todayIso = today(ctx);
  const rows = await baseSelect(ctx)
    .where(
      and(
        visibleTasksWhere(ctx),
        sql`(${tasks.companyId} is null or ${tasks.companyId} in (select ${companies.id} from ${companies} where ${companies.archivedAt} is null))`,
        ...extra,
      ),
    )
    .orderBy(asc(closedRank), sql`${tasks.dueDate} asc nulls last`, asc(priorityRank), desc(tasks.createdAt))
    .limit(Math.min(Math.max(limit, 1), 5000));
  return rows.map((r) => toView(r, todayIso));
}

export interface TodaySummary {
  today: IsoDate;
  overdue: TaskView[];
  dueToday: TaskView[];
  thisWeek: TaskView[];
  personal: TaskView[];
}

export async function getTodaySummary(ctx: ServiceContext): Promise<TodaySummary> {
  const todayIso = today(ctx);
  const week = thisWeekRange(todayIso);
  const personalWhere = and(eq(tasks.ownerUserId, ctx.user.id), eq(tasks.visibility, "private"))!;

  // ONE query for the four lists (queries are serial on one connection): every open task that
  // is relevant to me and due up to the end of the week, plus my open personal todos (always
  // visible: they are my own). Split below in JS; the shared ORDER BY keeps each list's order.
  const rows = await baseSelect(ctx)
    .where(and(visibleTasksWhere(ctx), openWhere(), or(and(relevantToMe(ctx), lte(tasks.dueDate, week.to)), personalWhere)))
    .orderBy(sql`${tasks.dueDate} asc nulls last`, asc(priorityRank), desc(tasks.createdAt));

  const overdue: TaskView[] = [];
  const dueToday: TaskView[] = [];
  const thisWeek: TaskView[] = [];
  const personal: TaskView[] = [];
  for (const r of rows) {
    const t = r.task;
    const view = toView(r, todayIso);
    const relevant = t.assigneeUserId === ctx.user.id || (t.assigneeUserId === null && t.ownerUserId === ctx.user.id);
    const due = t.dueDate;
    if (relevant && due !== null) {
      if (due < todayIso) overdue.push(view);
      else if (due === todayIso) dueToday.push(view);
      else if (due >= week.from && due <= week.to) thisWeek.push(view);
    }
    if (t.ownerUserId === ctx.user.id && t.visibility === "private" && personal.length < 50) personal.push(view);
  }
  return { today: todayIso, overdue, dueToday, thisWeek, personal };
}

export async function listTaskEvents(ctx: ServiceContext, taskId: string): Promise<TaskEvent[]> {
  await getTask(ctx, taskId); // access check
  return ctx.db
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), visibleEventsWhere(ctx)))
    .orderBy(asc(taskEvents.createdAt));
}

// ---------------------------------------------------------------------------
// Validation of relations (company isolation)
// ---------------------------------------------------------------------------

interface Relations {
  visibility: TaskVisibility;
  companyId: string | null;
  projectId: string | null;
  assigneeUserId: string | null;
  assigneePersonId: string | null;
  ownerUserId: string;
  /** Department of the org chart; checked only when it is new or the company changed. */
  orgDepartmentId?: string | null;
  checkDepartment?: boolean;
  /**
   * The person assignment is new (or its company changed): the person must work for the company
   * NOW (active link, not left) — the same list the task form offers. An unchanged assignment
   * of someone who left since is kept (only new assignments are checked strictly).
   */
  checkPerson?: boolean;
}

/** Companies a person works for right now (active link, not left), by name. */
export async function personActiveCompanies(ctx: ServiceContext, personId: string): Promise<{ id: string; name: string }[]> {
  return ctx.db
    .select({ id: companies.id, name: companies.name })
    .from(personCompanies)
    .innerJoin(people, eq(people.id, personCompanies.personId))
    .innerJoin(companies, eq(companies.id, personCompanies.companyId))
    .where(
      and(
        eq(personCompanies.personId, personId),
        eq(personCompanies.isActive, true),
        isNull(people.leftAt),
        isNull(companies.archivedAt),
      ),
    )
    .orderBy(asc(companies.name));
}

/** Validates cross-row rules and returns the (possibly inherited) companyId. */
async function validateRelations(ctx: ServiceContext, r: Relations): Promise<string | null> {
  let companyId = r.companyId;

  if (r.projectId) {
    const [project] = await ctx.db
      .select({ id: projects.id, companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, r.projectId));
    if (!project) throw new ServiceError("validation", "Project not found", { projectId: ["Not found"] });
    if (companyId && companyId !== project.companyId) {
      throw new ServiceError("validation", "Project belongs to a different company", {
        projectId: ["Project belongs to a different company"],
      });
    }
    companyId = project.companyId;
  }

  if (r.assigneeUserId && r.assigneePersonId) {
    throw new ServiceError("validation", "Assign to a founder or a person, not both");
  }

  // A shared task for a person who works for exactly one company: that company (the form does
  // the same when the person is picked first).
  let personCompanyList: { id: string; name: string }[] | null = null;
  if (r.assigneePersonId && r.visibility === "shared" && r.checkPerson !== false) {
    personCompanyList = await personActiveCompanies(ctx, r.assigneePersonId);
    if (!companyId && personCompanyList.length === 1) companyId = personCompanyList[0]!.id;
    if (!companyId && personCompanyList.length > 1) {
      const msg = `Pick a company: ${personCompanyList.map((c) => c.name).join(", ")}`;
      throw new ServiceError("validation", msg, { companyId: [msg] });
    }
  }

  if (companyId) await assertCompanyAccess(ctx, companyId);

  if (r.visibility === "shared" && !companyId) {
    throw new ServiceError("validation", "Shared tasks need a company", { companyId: ["Required"] });
  }

  if (r.visibility === "private") {
    if (r.assigneePersonId || (r.assigneeUserId && r.assigneeUserId !== r.ownerUserId)) {
      throw new ServiceError(
        "validation",
        "A personal todo can only be assigned to its owner. Make it shared to assign it.",
        { visibility: ["Private tasks cannot be assigned to others"] },
      );
    }
  }

  if (r.assigneeUserId) {
    const [u] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.id, r.assigneeUserId));
    if (!u) throw new ServiceError("validation", "Assignee not found", { assigneeUserId: ["Not found"] });
  }

  if (r.assigneePersonId && personCompanyList && companyId && !personCompanyList.some((c) => c.id === companyId)) {
    const [person] = await ctx.db.select({ name: people.fullName, short: people.shortName }).from(people).where(eq(people.id, r.assigneePersonId));
    const name = person?.short || person?.name || "This person";
    const msg = personCompanyList.length
      ? `${name} works for ${personCompanyList.map((c) => c.name).join(", ")} — pick one of those companies`
      : `${name} does not work for any company right now`;
    throw new ServiceError("validation", msg, { companyId: [msg], assigneePersonId: ["Not linked to this company"] });
  }

  if (r.assigneePersonId) {
    if (!companyId) throw new ServiceError("validation", "Pick a company before assigning a person", { companyId: ["Pick a company"] });
    const [link] = await ctx.db
      .select({ id: personCompanies.id })
      .from(personCompanies)
      .where(and(eq(personCompanies.personId, r.assigneePersonId), eq(personCompanies.companyId, companyId)));
    if (!link) {
      throw new ServiceError("validation", "This person does not work for the task's company", {
        assigneePersonId: ["Not linked to this company"],
      });
    }
  }

  if (r.orgDepartmentId && r.checkDepartment !== false) await assertTaskDepartment(ctx, r.orgDepartmentId, companyId);

  return companyId;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function createTask(ctx: ServiceContext, input: TaskCreateInput): Promise<TaskView> {
  const data = taskCreateSchema.parse(input);
  const rel: Relations = {
    visibility: data.visibility,
    companyId: data.companyId ?? null,
    projectId: data.projectId ?? null,
    assigneeUserId: data.assigneeUserId ?? null,
    assigneePersonId: data.assigneePersonId ?? null,
    ownerUserId: ctx.user.id,
    orgDepartmentId: data.orgDepartmentId ?? null,
  };
  const companyId = await validateRelations(ctx, rel);

  const id = await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(tasks)
      .values({
        title: data.title,
        notes: data.notes ?? null,
        visibility: data.visibility,
        status: data.status,
        priority: data.priority,
        dueDate: data.dueDate ?? null,
        companyId,
        projectId: rel.projectId,
        assigneeUserId: rel.assigneeUserId,
        assigneePersonId: rel.assigneePersonId,
        orgDepartmentId: rel.orgDepartmentId ?? null,
        ownerUserId: ctx.user.id,
        completedAt: data.status === "done" ? ctx.now : null,
      })
      .returning({ id: tasks.id });
    await tx.insert(taskEvents).values({
      taskId: row!.id,
      companyId,
      actorUserId: ctx.user.id,
      visibility: data.visibility,
      ownerUserId: ctx.user.id,
      kind: "created",
      newValue: { title: data.title, dueDate: data.dueDate ?? null, status: data.status },
    });
    return row!.id;
  });
  return getTask(ctx, id);
}

const TRACKED_FIELDS = [
  "title",
  "notes",
  "companyId",
  "projectId",
  "visibility",
  "assigneeUserId",
  "assigneePersonId",
  "orgDepartmentId",
  "status",
  "priority",
  "dueDate",
] as const;

export async function updateTask(ctx: ServiceContext, id: string, input: TaskUpdateInput): Promise<TaskView> {
  return (await updateTaskDetailed(ctx, id, input)).task;
}

/** Fields the assigned person sees on their card: a change to them sends one updated card. */
const CARD_FIELDS = ["title", "dueDate", "priority"] as const;

/**
 * updateTask + whether the task's person gets an updated Telegram card ("Elmurat will get an
 * updated message"): only when the person already got the task and keeps it (a reassignment
 * gets its own new-task message) and the title, deadline, priority or shared notes changed.
 */
export async function updateTaskDetailed(
  ctx: ServiceContext,
  id: string,
  input: TaskUpdateInput,
  opts: { notifyStaff?: boolean } = {},
): Promise<{ task: TaskView; staffNotice: { notified: boolean; personName: string | null } }> {
  const patch = taskUpdateSchema.parse(input);
  const current = await loadRawVisibleTask(ctx, id);

  if (patch.visibility && patch.visibility !== current.visibility && current.ownerUserId !== ctx.user.id) {
    throw new ServiceError("forbidden", "Only the task's creator can change who sees it");
  }

  // Assigning one kind of assignee clears the other.
  if (patch.assigneeUserId) patch.assigneePersonId ??= null;
  if (patch.assigneePersonId) patch.assigneeUserId ??= null;

  const next = {
    ...current,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
  } as Task;
  // A changed company invalidates a project from the old company unless a new one is given.
  if (patch.companyId !== undefined && patch.projectId === undefined && patch.companyId !== current.companyId) {
    next.projectId = null;
  }
  // Same for the org department: it belongs to one company.
  if (patch.companyId !== undefined && patch.orgDepartmentId === undefined && patch.companyId !== current.companyId) {
    next.orgDepartmentId = null;
  }

  const companyId = await validateRelations(ctx, {
    visibility: next.visibility,
    companyId: next.companyId,
    projectId: next.projectId,
    assigneeUserId: next.assigneeUserId,
    assigneePersonId: next.assigneePersonId,
    ownerUserId: current.ownerUserId,
    orgDepartmentId: next.orgDepartmentId,
    // An unchanged link to a department archived since stays (only new links are checked).
    checkDepartment: next.orgDepartmentId !== current.orgDepartmentId || next.companyId !== current.companyId,
    checkPerson: next.assigneePersonId !== current.assigneePersonId || next.companyId !== current.companyId,
  });
  next.companyId = companyId;
  next.completedAt = nextCompletedAt(current, next.status, ctx.now);

  const changed = TRACKED_FIELDS.filter((f) => (current[f] ?? null) !== (next[f] ?? null));
  if (changed.length === 0) return { task: await getTask(ctx, id), staffNotice: { notified: false, personName: null } };

  await ctx.db.transaction(async (tx) => {
    await tx
      .update(tasks)
      .set({
        title: next.title,
        notes: next.notes,
        companyId: next.companyId,
        projectId: next.projectId,
        visibility: next.visibility,
        assigneeUserId: next.assigneeUserId,
        assigneePersonId: next.assigneePersonId,
        orgDepartmentId: next.orgDepartmentId,
        status: next.status,
        priority: next.priority,
        dueDate: next.dueDate,
        completedAt: next.completedAt,
        updatedAt: ctx.now,
      })
      .where(eq(tasks.id, id));

    // The audit log follows the task: when it becomes private (or shared), so does its history.
    if (next.visibility !== current.visibility) {
      await tx.update(taskEvents).set({ visibility: next.visibility }).where(eq(taskEvents.taskId, id));
    }

    const events: (typeof taskEvents.$inferInsert)[] = [];
    const base = {
      taskId: id,
      companyId: next.companyId,
      actorUserId: ctx.user.id,
      visibility: next.visibility,
      ownerUserId: current.ownerUserId,
    };
    for (const field of changed) {
      const kind =
        field === "dueDate"
          ? "deadline_changed"
          : field === "status"
            ? "status_changed"
            : field === "assigneeUserId" || field === "assigneePersonId"
              ? "assignee_changed"
              : "updated";
      events.push({ ...base, kind, field, oldValue: current[field] ?? null, newValue: next[field] ?? null });
    }
    await tx.insert(taskEvents).values(events);
  });
  const cardChanged =
    CARD_FIELDS.some((f) => (changed as readonly string[]).includes(f)) || (changed.includes("notes") && parseTaskOverride(current.staffChase).shareNotes === true);
  const samePerson = !!next.assigneePersonId && next.assigneePersonId === current.assigneePersonId;
  const staffNotice =
    opts.notifyStaff !== false && cardChanged && samePerson && !CLOSED_STATUSES.includes(next.status as never)
      ? await queueStaffTaskUpdate(ctx.db, id, ctx.now).then((n) => ({ notified: n.queued, personName: n.personName }))
      : { notified: false, personName: null };
  return { task: await getTask(ctx, id), staffNotice };
}

export async function changeTaskStatus(ctx: ServiceContext, id: string, status: TaskStatus) {
  return updateTask(ctx, id, { status });
}

/** A deadline approved from a person's request: they already get a line about it, no extra card. */
export async function changeTaskDeadline(ctx: ServiceContext, id: string, dueDate: IsoDate | null) {
  return (await updateTaskDetailed(ctx, id, { dueDate }, { notifyStaff: false })).task;
}

export async function deleteTask(ctx: ServiceContext, id: string): Promise<void> {
  const current = await loadRawVisibleTask(ctx, id);
  await ctx.db.transaction(async (tx) => {
    await tx.insert(taskEvents).values({
      taskId: id,
      companyId: current.companyId,
      actorUserId: ctx.user.id,
      visibility: current.visibility,
      ownerUserId: current.ownerUserId,
      kind: "deleted",
      oldValue: {
        title: current.title,
        status: current.status,
        dueDate: current.dueDate,
        visibility: current.visibility,
        ownerUserId: current.ownerUserId,
      },
    });
    await tx.delete(tasks).where(eq(tasks.id, id));
  });
}

async function loadRawVisibleTask(ctx: ServiceContext, id: string): Promise<Task> {
  assertValidId(id, "Task");
  const [row] = await ctx.db.select().from(tasks).where(and(eq(tasks.id, id), visibleTasksWhere(ctx)));
  if (!row) throw new ServiceError("not_found", "Task not found");
  return row;
}

/** Counts of visible tasks per company: open and overdue. */
export async function taskCountsByCompany(
  ctx: ServiceContext,
  companyIds?: string[],
): Promise<Map<string, { open: number; overdue: number }>> {
  const todayIso = today(ctx);
  const rows = await ctx.db
    .select({
      companyId: tasks.companyId,
      open: sql<number>`count(*) filter (where ${tasks.status} not in ('done','cancelled'))`.mapWith(Number),
      overdue: sql<number>`count(*) filter (where ${tasks.status} not in ('done','cancelled') and ${tasks.dueDate} < ${todayIso})`.mapWith(
        Number,
      ),
    })
    .from(tasks)
    .where(and(visibleTasksWhere(ctx), companyIds ? inArray(tasks.companyId, companyIds) : undefined))
    .groupBy(tasks.companyId);
  return new Map(rows.filter((r) => r.companyId).map((r) => [r.companyId!, { open: r.open, overdue: r.overdue }]));
}
