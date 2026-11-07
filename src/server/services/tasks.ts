import "server-only";
import {
  and,
  asc,
  desc,
  eq,
  gt,
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
import { addDays, type IsoDate } from "@/lib/dates";
import { parseTaskKey, PERSONAL_PREFIX, prefixFromSlug, taskKey } from "@/lib/task-keys";
import {
  companies,
  orgDepartments,
  people,
  personCompanies,
  projects,
  taskComments,
  taskEvents,
  taskLabelLinks,
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
import { overEstimateIds } from "./estimates";
import { ACTIVE_STATUSES, CLOSED_STATUSES, isOverdue, nextCompletedAt, nextStartedAt, thisWeekRange } from "./tasks-rules";
import { assertTaskDepartment } from "./org";
import { parseTaskOverride } from "@/lib/staff-schemas";
import { queueStaffTaskUpdate } from "./task-staff-updates";
import { labelNames, labelsForTasks, replaceTaskLabels, validLabelIds, type LabelView } from "./task-labels";

/** A task row enriched for display / API output. */
export interface TaskView {
  id: string;
  /** "UPS-1583" (company prefix) or "ME-12" (a personal todo without a company). */
  key: string;
  number: number;
  title: string;
  notes: string | null;
  visibility: TaskVisibility;
  status: TaskStatus;
  priority: TaskPriority;
  /** Estimate points (1, 2, 3, 5, 8, 13), 1 point = 1 working hour. */
  estimate: number | null;
  /** Staff «Готово» → In Review (true) or Done. */
  needsReview: boolean;
  dueDate: IsoDate | null;
  completedAt: Date | null;
  startedAt: Date | null;
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
  labels: LabelView[];
  parentTaskId: string | null;
  isOverdue: boolean;
  /** In Progress longer than the estimate (working hours of the assignee's window). */
  overEstimate: boolean;
}

const owner = alias(users, "owner");
const assigneeUser = alias(users, "assignee_user");

const priorityRank = sql<number>`case ${tasks.priority} when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end`;
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
      companyPrefix: companies.taskPrefix,
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

/** The key prefix of a row: the company's (or derived from its slug), else ME. */
function prefixOf(row: Pick<Row, "company" | "companyPrefix">): string {
  if (!row.company?.id) return PERSONAL_PREFIX;
  return row.companyPrefix ?? prefixFromSlug(row.company.slug);
}

function toView(row: Row, todayIso: IsoDate, extra: { labels?: LabelView[]; overEstimate?: boolean } = {}): TaskView {
  const t = row.task;
  return {
    id: t.id,
    key: taskKey(prefixOf(row), t.number),
    number: t.number,
    title: t.title,
    notes: t.notes,
    visibility: t.visibility,
    status: t.status,
    priority: t.priority,
    estimate: t.estimate,
    needsReview: t.needsReview,
    dueDate: t.dueDate,
    completedAt: t.completedAt,
    startedAt: t.startedAt,
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
    labels: extra.labels ?? [],
    parentTaskId: t.parentTaskId,
    isOverdue: isOverdue(t, todayIso),
    overEstimate: extra.overEstimate ?? false,
  };
}

/** Rows → views with their labels and the over-estimate flag (two small reads for the whole list). */
async function toViews(ctx: ServiceContext, rows: Row[]): Promise<TaskView[]> {
  if (!rows.length) return [];
  const todayIso = today(ctx);
  const [labels, over] = await Promise.all([
    labelsForTasks(ctx.db, rows.map((r) => r.task.id)),
    overEstimateIds(ctx.db, ctx.timeZone, ctx.now, rows.map((r) => r.task)),
  ]);
  return rows.map((r) => toView(r, todayIso, { labels: labels.get(r.task.id) ?? [], overEstimate: over.has(r.task.id) }));
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
const activeWhere = () => inArray(tasks.status, [...ACTIVE_STATUSES]);

/** A key typed in a search box ("UPS-12", "me-3") or a bare number ("12"). */
function keySearchWhere(ctx: ServiceContext, text: string): SQL | undefined {
  const key = parseTaskKey(text);
  if (key) {
    if (key.prefix === PERSONAL_PREFIX) return and(isNull(tasks.companyId), eq(tasks.ownerUserId, ctx.user.id), eq(tasks.number, key.number));
    return and(eq(companies.taskPrefix, key.prefix), eq(tasks.number, key.number));
  }
  if (/^\d{1,7}$/.test(text.trim())) return eq(tasks.number, Number(text.trim()));
  return undefined;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

type ParsedTaskFilters = ReturnType<typeof taskFiltersSchema.parse>;

function assigneeRefWhere(ref: string): SQL | undefined {
  if (ref === "unassigned") return and(isNull(tasks.assigneeUserId), isNull(tasks.assigneePersonId));
  const [kind, id] = ref.split(":") as ["user" | "person", string];
  return kind === "user" ? eq(tasks.assigneeUserId, id) : and(isNull(tasks.assigneeUserId), eq(tasks.assigneePersonId, id));
}

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
  // The Filter menu: any of the values of one property, every property.
  if (f.statuses?.length) where.push(inArray(tasks.status, f.statuses));
  if (f.priorities?.length) where.push(inArray(tasks.priority, f.priorities));
  if (f.assignees?.length) where.push(or(...f.assignees.map(assigneeRefWhere)));
  if (f.companyIds?.length) where.push(inArray(tasks.companyId, f.companyIds));
  if (f.projectIds?.length) where.push(inArray(tasks.projectId, f.projectIds));
  if (f.labelIds?.length) {
    where.push(sql`exists (select 1 from ${taskLabelLinks} where ${taskLabelLinks.taskId} = ${tasks.id} and ${inArray(taskLabelLinks.labelId, f.labelIds)})`);
  }
  if (f.estimates?.length) {
    const points = f.estimates.filter((n) => n > 0);
    where.push(or(points.length ? inArray(tasks.estimate, points) : undefined, f.estimates.includes(0) ? isNull(tasks.estimate) : undefined));
  }
  if (f.due?.length) {
    const week = addDays(todayIso, 7);
    const parts = f.due.map((d) =>
      d === "overdue"
        ? and(openWhere(), lt(tasks.dueDate, todayIso))
        : d === "today"
          ? eq(tasks.dueDate, todayIso)
          : d === "week"
            ? and(gte(tasks.dueDate, todayIso), lte(tasks.dueDate, week))
            : d === "later"
              ? gt(tasks.dueDate, week)
              : isNull(tasks.dueDate),
    );
    where.push(or(...parts));
  }
  if (f.overEstimate) where.push(eq(tasks.status, "in_progress"), isNotNull(tasks.estimate), isNotNull(tasks.startedAt));
  if (f.q) where.push(or(ilike(tasks.title, `%${escapeLike(f.q)}%`), keySearchWhere(ctx, f.q)));
  if (f.search) {
    const like = `%${escapeLike(f.search)}%`;
    where.push(
      or(ilike(tasks.title, like), ilike(people.fullName, like), ilike(assigneeUser.shortName, like), ilike(companies.name, like), keySearchWhere(ctx, f.search)),
    );
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
  if (status === "active") return activeWhere();
  if (status === "overdue") return and(openWhere(), lt(tasks.dueDate, todayIso));
  if (status && status !== "any") return eq(tasks.status, status);
  return undefined;
}

function orderFor(sort: ParsedTaskFilters["sort"]) {
  switch (sort) {
    case "newest":
    case "created":
      return [desc(tasks.createdAt)];
    case "updated":
      return [desc(tasks.updatedAt), desc(tasks.createdAt)];
    case "title":
      return [asc(sql`lower(${tasks.title})`), desc(tasks.createdAt)];
    case "priority":
      return [asc(priorityRank), sql`${tasks.dueDate} asc nulls last`, desc(tasks.updatedAt)];
    default:
      return [asc(closedRank), sql`${tasks.dueDate} asc nulls last`, asc(priorityRank), desc(tasks.createdAt)];
  }
}

export async function listTasks(ctx: ServiceContext, rawFilters: TaskFilters = {}): Promise<TaskView[]> {
  const f = taskFiltersSchema.parse(rawFilters);
  const todayIso = today(ctx);
  const where = [...taskListWhere(ctx, f, todayIso), statusWhere(f.status, todayIso)];
  const rows = await baseSelect(ctx)
    .where(and(...where))
    .orderBy(...orderFor(f.sort))
    .limit(f.limit ?? 200);
  const views = await toViews(ctx, rows);
  return f.overEstimate ? views.filter((t) => t.overEstimate) : views;
}

export interface TaskStatusCounts {
  open: number;
  active: number;
  backlog: number;
  overdue: number;
  done: number;
  any: number;
}

/** The view chips' counts for a list (same filters, every status), in one query. */
export async function countTasksByStatus(ctx: ServiceContext, rawFilters: TaskFilters = {}): Promise<TaskStatusCounts> {
  const f = taskFiltersSchema.parse(rawFilters);
  const todayIso = today(ctx);
  const open = sql`${tasks.status} not in ('done', 'cancelled')`;
  const [row] = await ctx.db
    .select({
      open: sql<number>`count(*) filter (where ${open})`.mapWith(Number),
      active: sql<number>`count(*) filter (where ${tasks.status} in ('todo', 'in_progress', 'in_review'))`.mapWith(Number),
      backlog: sql<number>`count(*) filter (where ${tasks.status} = 'backlog')`.mapWith(Number),
      overdue: sql<number>`count(*) filter (where ${open} and ${tasks.dueDate} < ${todayIso})`.mapWith(Number),
      done: sql<number>`count(*) filter (where ${tasks.status} = 'done')`.mapWith(Number),
      any: sql<number>`count(*)`.mapWith(Number),
    })
    .from(tasks)
    .leftJoin(companies, eq(companies.id, tasks.companyId))
    .leftJoin(assigneeUser, eq(assigneeUser.id, tasks.assigneeUserId))
    .leftJoin(people, eq(people.id, tasks.assigneePersonId))
    .where(and(...taskListWhere(ctx, f, todayIso)));
  return row ?? { open: 0, active: 0, backlog: 0, overdue: 0, done: 0, any: 0 };
}

/**
 * One visible task (not_found also for private tasks of the other founder). Deduped per render
 * (React `cache`): the task page and the services it calls (comments, deadline requests,
 * timeline, checklist) all check access through it. Server actions and API routes run outside a
 * render, so a write followed by a read always sees the new row.
 */
export const getTask = cache(async (ctx: ServiceContext, id: string): Promise<TaskView> => {
  assertValidId(id, "Task");
  const [row] = await baseSelect(ctx).where(and(eq(tasks.id, id), visibleTasksWhere(ctx)));
  if (!row) throw new ServiceError("not_found", "Task not found");
  return (await toViews(ctx, [row]))[0]!;
});

/** A visible task by its key ("UPS-12"), or null. */
export async function findTaskByKey(ctx: ServiceContext, key: string): Promise<TaskView | null> {
  const where = parseTaskKey(key) ? keySearchWhere(ctx, key) : undefined;
  if (!where) return null;
  const [row] = await baseSelect(ctx).where(and(where, visibleTasksWhere(ctx))).limit(1);
  return row ? (await toViews(ctx, [row]))[0]! : null;
}

/**
 * Visible tasks (access rule + archived companies hidden, like listTasks) matching extra
 * conditions, in list order. Read-only building block for other views (services/team-tasks.ts).
 */
export async function queryVisibleTasks(ctx: ServiceContext, extra: (SQL | undefined)[], limit = 1000): Promise<TaskView[]> {
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
  return toViews(ctx, rows);
}

export interface TodaySummary {
  today: IsoDate;
  overdue: TaskView[];
  dueToday: TaskView[];
  thisWeek: TaskView[];
  personal: TaskView[];
  /** In Review and mine to approve (I created it, or it is assigned to me). */
  review: TaskView[];
}

/**
 * Today (and the founder planner): planned work only — Todo, In Progress, In Review. Backlog is
 * not planned yet, so it is never on Today and never chased.
 */
export async function getTodaySummary(ctx: ServiceContext): Promise<TodaySummary> {
  const todayIso = today(ctx);
  const week = thisWeekRange(todayIso);
  const personalWhere = and(eq(tasks.ownerUserId, ctx.user.id), eq(tasks.visibility, "private"))!;
  const reviewWhere = and(eq(tasks.status, "in_review"), or(eq(tasks.ownerUserId, ctx.user.id), eq(tasks.assigneeUserId, ctx.user.id)))!;

  // ONE query for the lists (queries are serial on one connection): every active task that is
  // relevant to me and due up to the end of the week, my active personal todos (always visible:
  // they are my own) and what waits for my review. Split below in JS; the shared ORDER BY keeps
  // each list's order.
  const rows = await baseSelect(ctx)
    .where(and(visibleTasksWhere(ctx), activeWhere(), or(and(relevantToMe(ctx), lte(tasks.dueDate, week.to)), personalWhere, reviewWhere)))
    .orderBy(sql`${tasks.dueDate} asc nulls last`, asc(priorityRank), desc(tasks.createdAt));
  const views = await toViews(ctx, rows);

  const overdue: TaskView[] = [];
  const dueToday: TaskView[] = [];
  const thisWeek: TaskView[] = [];
  const personal: TaskView[] = [];
  const review: TaskView[] = [];
  for (const view of views) {
    // Same rule as relevantToMe: assigned to me, or mine and not assigned to another founder.
    const founderAssignee = view.assignee?.kind === "user" ? view.assignee.id : null;
    const relevant = founderAssignee === ctx.user.id || (founderAssignee === null && view.ownerUserId === ctx.user.id);
    const due = view.dueDate;
    if (relevant && due !== null) {
      if (due < todayIso) overdue.push(view);
      else if (due === todayIso) dueToday.push(view);
      else if (due >= week.from && due <= week.to) thisWeek.push(view);
    }
    if (view.ownerUserId === ctx.user.id && view.visibility === "private" && personal.length < 50) personal.push(view);
    if (view.status === "in_review" && (view.ownerUserId === ctx.user.id || (view.assignee?.kind === "user" && view.assignee.id === ctx.user.id))) review.push(view);
  }
  return { today: todayIso, overdue, dueToday, thisWeek, personal, review };
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
  const labelIds = data.labelIds ? await validLabelIds(ctx.db, data.labelIds) : [];
  if (data.parentTaskId) await getTask(ctx, data.parentTaskId);

  const id = await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(tasks)
      .values({
        title: data.title,
        notes: data.notes ?? null,
        visibility: data.visibility,
        status: data.status,
        priority: data.priority,
        estimate: data.estimate ?? null,
        needsReview: data.needsReview ?? true,
        dueDate: data.dueDate ?? null,
        companyId,
        projectId: rel.projectId,
        assigneeUserId: rel.assigneeUserId,
        assigneePersonId: rel.assigneePersonId,
        orgDepartmentId: rel.orgDepartmentId ?? null,
        parentTaskId: data.parentTaskId ?? null,
        ownerUserId: ctx.user.id,
        completedAt: data.status === "done" ? ctx.now : null,
        startedAt: data.status === "in_progress" ? ctx.now : null,
      })
      .returning({ id: tasks.id });
    if (labelIds.length) await replaceTaskLabels(tx as never, row!.id, labelIds);
    await tx.insert(taskEvents).values({
      taskId: row!.id,
      companyId,
      actorUserId: ctx.user.id,
      visibility: data.visibility,
      ownerUserId: ctx.user.id,
      kind: "created",
      newValue: { title: data.title, dueDate: data.dueDate ?? null, status: data.status, priority: data.priority, estimate: data.estimate ?? null },
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
  "estimate",
  "needsReview",
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
  const { labelIds: wantedLabels, ...patch } = taskUpdateSchema.parse(input);
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
  next.startedAt = nextStartedAt(current, next.status, ctx.now);
  const restarted = (next.startedAt?.getTime() ?? null) !== (current.startedAt?.getTime() ?? null) || next.estimate !== current.estimate;

  const changed = TRACKED_FIELDS.filter((f) => (current[f] ?? null) !== (next[f] ?? null));
  let labelChange: { before: string[]; after: string[] } | null = null;
  if (wantedLabels !== undefined) {
    const currentLabels = (await labelsForTasks(ctx.db, [id])).get(id)?.map((l) => l.id) ?? [];
    const ids = await validLabelIds(ctx.db, wantedLabels, currentLabels);
    const same = ids.length === currentLabels.length && ids.every((x) => currentLabels.includes(x));
    if (!same) labelChange = { before: currentLabels, after: ids };
  }
  if (changed.length === 0 && !labelChange) return { task: await getTask(ctx, id), staffNotice: { notified: false, personName: null } };

  const names = labelChange ? await labelNames(ctx.db, [...labelChange.before, ...labelChange.after]) : new Map<string, string>();
  await ctx.db.transaction(async (tx) => {
    if (changed.length) {
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
          estimate: next.estimate,
          needsReview: next.needsReview,
          dueDate: next.dueDate,
          completedAt: next.completedAt,
          startedAt: next.startedAt,
          // A new In Progress stint (or a new estimate) may be nudged once again.
          ...(restarted ? { overEstimateNotifiedAt: null } : {}),
          updatedAt: ctx.now,
        })
        .where(eq(tasks.id, id));
    } else {
      await tx.update(tasks).set({ updatedAt: ctx.now }).where(eq(tasks.id, id));
    }
    if (labelChange) await replaceTaskLabels(tx as never, id, labelChange.after);

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
    if (labelChange) {
      const n = (ids: string[]) => ids.map((x) => names.get(x) ?? "?");
      events.push({ ...base, kind: "updated", field: "labels", oldValue: n(labelChange.before), newValue: n(labelChange.after) });
    }
    if (events.length) await tx.insert(taskEvents).values(events);
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

export interface BulkResult {
  updated: number;
  failed: { id: string; error: string }[];
}

/**
 * The same change for several tasks (the list's bulk bar). Each task is updated on its own
 * (access, relations and history per task); a refused task is reported, the others are saved.
 * `addLabelIds` / `removeLabelIds` change the label sets instead of replacing them.
 */
export async function bulkUpdateTasks(
  ctx: ServiceContext,
  ids: readonly string[],
  patch: TaskUpdateInput | Record<string, never>,
  labels: { add?: string[]; remove?: string[] } = {},
): Promise<BulkResult> {
  const unique = [...new Set(ids)].slice(0, 500);
  const out: BulkResult = { updated: 0, failed: [] };
  const current = labels.add?.length || labels.remove?.length ? await labelsForTasks(ctx.db, unique) : new Map<string, LabelView[]>();
  for (const id of unique) {
    try {
      const p: TaskUpdateInput = { ...(patch as TaskUpdateInput) };
      if (labels.add?.length || labels.remove?.length) {
        const have = (current.get(id) ?? []).map((l) => l.id);
        p.labelIds = [...new Set([...have, ...(labels.add ?? [])])].filter((x) => !(labels.remove ?? []).includes(x));
      }
      if (Object.keys(p).length === 0) continue;
      await updateTaskDetailed(ctx, id, p);
      out.updated++;
    } catch (err) {
      out.failed.push({ id, error: err instanceof ServiceError ? err.message : "Could not save" });
      if (!(err instanceof ServiceError)) console.error("[tasks] bulk update failed", err);
    }
  }
  return out;
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

/** People and founders with open visible tasks, and how many (the list's person chips). */
export async function openTaskAssignees(ctx: ServiceContext): Promise<{ kind: "user" | "person"; id: string; name: string; count: number }[]> {
  const rows = await ctx.db
    .select({
      userId: tasks.assigneeUserId,
      personId: tasks.assigneePersonId,
      userName: assigneeUser.shortName,
      personName: people.fullName,
      personShort: people.shortName,
      n: sql<number>`count(*)`.mapWith(Number),
    })
    .from(tasks)
    .leftJoin(assigneeUser, eq(assigneeUser.id, tasks.assigneeUserId))
    .leftJoin(people, eq(people.id, tasks.assigneePersonId))
    .where(
      and(
        visibleTasksWhere(ctx),
        openWhere(),
        or(isNotNull(tasks.assigneeUserId), isNotNull(tasks.assigneePersonId)),
        sql`(${tasks.companyId} is null or ${tasks.companyId} in (select ${companies.id} from ${companies} where ${companies.archivedAt} is null))`,
      ),
    )
    .groupBy(tasks.assigneeUserId, tasks.assigneePersonId, assigneeUser.shortName, people.fullName, people.shortName);
  return rows
    .map((r) =>
      r.userId
        ? { kind: "user" as const, id: r.userId, name: r.userName ?? "?", count: r.n }
        : { kind: "person" as const, id: r.personId!, name: r.personShort || r.personName || "?", count: r.n },
    )
    .sort((a, b) => (a.kind === b.kind ? b.count - a.count || a.name.localeCompare(b.name) : a.kind === "user" ? -1 : 1));
}

/** Tasks promoted from this task's sub-tasks (tasks.parent_task_id), visible ones only. */
export async function listChildTasks(ctx: ServiceContext, parentId: string): Promise<TaskView[]> {
  await getTask(ctx, parentId);
  return queryVisibleTasks(ctx, [eq(tasks.parentTaskId, parentId)], 200);
}
