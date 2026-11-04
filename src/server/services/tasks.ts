import "server-only";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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

export async function listTasks(ctx: ServiceContext, rawFilters: TaskFilters = {}): Promise<TaskView[]> {
  const f = taskFiltersSchema.parse(rawFilters);
  const todayIso = today(ctx);
  const where: (SQL | undefined)[] = [
    visibleTasksWhere(ctx),
    // Tasks of archived companies are hidden (personal todos have no company).
    sql`(${tasks.companyId} is null or ${tasks.companyId} in (select ${companies.id} from ${companies} where ${companies.archivedAt} is null))`,
  ];

  switch (f.view) {
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
  if (f.priority) where.push(eq(tasks.priority, f.priority));
  if (f.status === "open") where.push(openWhere());
  else if (f.status && f.status !== "any") where.push(eq(tasks.status, f.status));
  if (f.q) where.push(ilike(tasks.title, `%${escapeLike(f.q)}%`));

  const rows = await baseSelect(ctx)
    .where(and(...where))
    .orderBy(
      asc(closedRank),
      sql`${tasks.dueDate} asc nulls last`,
      asc(priorityRank),
      desc(tasks.createdAt),
    )
    .limit(f.limit ?? 200);
  return rows.map((r) => toView(r, todayIso));
}

/** Returns the task or throws not_found (also for private tasks of the other founder). */
export async function getTask(ctx: ServiceContext, id: string): Promise<TaskView> {
  assertValidId(id, "Task");
  const [row] = await baseSelect(ctx).where(and(eq(tasks.id, id), visibleTasksWhere(ctx)));
  if (!row) throw new ServiceError("not_found", "Task not found");
  return toView(row, today(ctx));
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
  const mine = and(visibleTasksWhere(ctx), relevantToMe(ctx), openWhere());
  const order = [sql`${tasks.dueDate} asc nulls last`, asc(priorityRank), desc(tasks.createdAt)];

  const [overdue, dueToday, thisWeek, personal] = await Promise.all([
    baseSelect(ctx).where(and(mine, lt(tasks.dueDate, todayIso))).orderBy(...order),
    baseSelect(ctx).where(and(mine, eq(tasks.dueDate, todayIso))).orderBy(...order),
    baseSelect(ctx)
      .where(and(mine, gte(tasks.dueDate, week.from), lte(tasks.dueDate, week.to)))
      .orderBy(...order),
    baseSelect(ctx)
      .where(and(eq(tasks.ownerUserId, ctx.user.id), eq(tasks.visibility, "private"), openWhere()))
      .orderBy(...order)
      .limit(50),
  ]);
  const v = (rows: Row[]) => rows.map((r) => toView(r, todayIso));
  return { today: todayIso, overdue: v(overdue), dueToday: v(dueToday), thisWeek: v(thisWeek), personal: v(personal) };
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

  if (companyId) await assertCompanyAccess(ctx, companyId);

  if (r.assigneeUserId && r.assigneePersonId) {
    throw new ServiceError("validation", "Assign to a founder or a person, not both");
  }

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

  if (r.assigneePersonId) {
    if (!companyId) throw new ServiceError("validation", "Pick a company before assigning a person");
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
  });
  next.companyId = companyId;
  next.completedAt = nextCompletedAt(current, next.status, ctx.now);

  const changed = TRACKED_FIELDS.filter((f) => (current[f] ?? null) !== (next[f] ?? null));
  if (changed.length === 0) return getTask(ctx, id);

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
  return getTask(ctx, id);
}

export async function changeTaskStatus(ctx: ServiceContext, id: string, status: TaskStatus) {
  return updateTask(ctx, id, { status });
}

export async function changeTaskDeadline(ctx: ServiceContext, id: string, dueDate: IsoDate | null) {
  return updateTask(ctx, id, { dueDate });
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
