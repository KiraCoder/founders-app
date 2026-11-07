import "server-only";
import { and, asc, eq, gt, gte, inArray, isNull, notInArray, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { TASK_STATUS_VALUES } from "@/lib/schemas";
import { people, personCompanies, companies, tasks, telegramLinkCodes, telegramLinks, users } from "@/server/db/schema";
import { assertTeamTasksAccess, assertValidId, inAccessibleCompany, visiblePeopleWhere } from "./access";
import { today, type ServiceContext } from "./context";
import { ServiceError } from "./errors";
import { CLOSED_STATUSES } from "./tasks-rules";
import { queryVisibleTasks, type TaskView } from "./tasks";

/**
 * Team view of tasks (founders only): every visible task grouped by who has it — one group per
 * founder and per person, plus "Unassigned" for shared tasks nobody has. Read-only; it never
 * widens visibility (queryVisibleTasks → visibleTasksWhere). A personal todo has no assignee or
 * its owner as assignee, so it lands in its owner's group, which only that owner ever sees.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** "Done in the last 7 days" window. */
export const RECENT_DONE_DAYS = 7;
/** The Team view reads at most this many tasks; beyond it the page says so (narrow the filters). */
export const TEAM_TASKS_LIMIT = 3000;

const blankToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const TEAM_STATUS_FILTERS = ["open", "any", ...TASK_STATUS_VALUES] as const;
export type TeamStatusFilter = (typeof TEAM_STATUS_FILTERS)[number];

export const teamTaskFiltersSchema = z.object({
  companyId: z.preprocess(blankToUndef, z.uuid().optional()),
  /** "user:<id>", "person:<id>" or "unassigned". */
  assignee: z.preprocess(
    blankToUndef,
    z
      .union([z.literal("unassigned"), z.string().regex(/^(user|person):[0-9a-f-]{36}$/i)])
      .optional(),
  ),
  status: z.preprocess(blankToUndef, z.enum(TEAM_STATUS_FILTERS).default("open")),
  overdueOnly: z.preprocess((v) => v === true || v === "1" || v === "true" || v === "on", z.boolean()).default(false),
});
export type TeamTaskFilters = z.input<typeof teamTaskFiltersSchema>;

/** Telegram state shown on a group header (read from people / telegram_links / invite codes). */
export type TeamTelegramStatus = "on" | "paused" | "linked" | "invited" | "stopped" | "not_linked";

export interface TeamCounts {
  open: number;
  overdue: number;
  dueToday: number;
  waiting: number;
  doneRecent: number;
}

export interface TeamGroup {
  /** "user:<id>", "person:<id>" or "unassigned" (also the assignee filter value). */
  key: string;
  kind: "user" | "person" | "unassigned";
  id: string | null;
  name: string;
  /** People record to link to (/people/<id>); founders have one too. */
  personId: string | null;
  /** First active company of the person (preset for "Assign a task"). */
  companyId: string | null;
  left: boolean;
  telegram: TeamTelegramStatus | null;
  counts: TeamCounts;
  /** Tasks matching the status / overdue filters, in list order. */
  tasks: TaskView[];
}

export interface TeamBoard {
  today: string;
  groups: TeamGroup[];
  filters: z.output<typeof teamTaskFiltersSchema>;
  /** More tasks matched than `limit`: groups and counts cover only the first `limit` of them. */
  capped: boolean;
  limit: number;
}

const emptyCounts = (): TeamCounts => ({ open: 0, overdue: 0, dueToday: 0, waiting: 0, doneRecent: 0 });

function groupKeyOf(t: TaskView): string {
  if (t.assignee) return `${t.assignee.kind}:${t.assignee.id}`;
  // A personal todo without an assignee is its owner's own todo.
  if (t.visibility === "private") return `user:${t.ownerUserId}`;
  return "unassigned";
}

function assigneeWhere(assignee: string | undefined): SQL | undefined {
  if (!assignee) return undefined;
  if (assignee === "unassigned") {
    return and(isNull(tasks.assigneeUserId), isNull(tasks.assigneePersonId), eq(tasks.visibility, "shared"));
  }
  const [kind, id] = assignee.split(":") as ["user" | "person", string];
  if (kind === "person") return eq(tasks.assigneePersonId, id);
  return or(
    eq(tasks.assigneeUserId, id),
    and(isNull(tasks.assigneeUserId), isNull(tasks.assigneePersonId), eq(tasks.visibility, "private"), eq(tasks.ownerUserId, id)),
  );
}

function statusMatches(t: TaskView, status: TeamStatusFilter): boolean {
  if (status === "any") return true;
  if (status === "open") return !CLOSED_STATUSES.includes(t.status);
  return t.status === status;
}

async function telegramStatuses(ctx: ServiceContext, personIds: string[], userIds: string[]) {
  const out = new Map<string, TeamTelegramStatus>();
  const [rows, links, codes] = await Promise.all([
    personIds.length
      ? ctx.db
          .select({ id: people.id, botEnabled: people.botEnabled, pausedUntil: people.botPausedUntil })
          .from(people)
          .where(inArray(people.id, personIds))
      : [],
    personIds.length || userIds.length
      ? ctx.db
          .select({ personId: telegramLinks.personId, userId: telegramLinks.userId, stoppedAt: telegramLinks.stoppedAt })
          .from(telegramLinks)
          .where(
            or(
              personIds.length ? inArray(telegramLinks.personId, personIds) : undefined,
              userIds.length ? inArray(telegramLinks.userId, userIds) : undefined,
            ),
          )
      : [],
    personIds.length
      ? ctx.db
          .select({ personId: telegramLinkCodes.personId })
          .from(telegramLinkCodes)
          .where(
            and(
              inArray(telegramLinkCodes.personId, personIds),
              isNull(telegramLinkCodes.usedAt),
              gt(telegramLinkCodes.expiresAt, ctx.now),
            ),
          )
      : [],
  ]);
  const invited = new Set(codes.map((c) => c.personId));
  const linkOfPerson = new Map(links.filter((l) => l.personId).map((l) => [l.personId!, l]));
  for (const p of rows) {
    const l = linkOfPerson.get(p.id);
    let s: TeamTelegramStatus;
    if (l) {
      const paused = !!p.pausedUntil && p.pausedUntil.getTime() > ctx.now.getTime();
      s = l.stoppedAt ? "stopped" : !p.botEnabled ? "linked" : paused ? "paused" : "on";
    } else s = invited.has(p.id) ? "invited" : "not_linked";
    out.set(`person:${p.id}`, s);
  }
  // Founders get the bot's pushes once their own chat is linked (Settings → Telegram).
  const linkedUsers = new Set(links.filter((l) => l.userId).map((l) => l.userId!));
  for (const u of userIds) out.set(`user:${u}`, linkedUsers.has(u) ? "on" : "not_linked");
  return out;
}

/** The Team view: tasks grouped by founder / person, with counts. Founders only. */
export async function getTeamTasks(ctx: ServiceContext, rawFilters: TeamTaskFilters = {}, opts: { limit?: number } = {}): Promise<TeamBoard> {
  return loadBoard(ctx, rawFilters, { keepRecentDone: false, limit: opts.limit });
}

async function loadBoard(
  ctx: ServiceContext,
  rawFilters: TeamTaskFilters,
  opts: { keepRecentDone: boolean; limit?: number },
): Promise<TeamBoard> {
  assertTeamTasksAccess(ctx);
  const f = teamTaskFiltersSchema.parse(rawFilters);
  const todayIso = today(ctx);
  const since = new Date(ctx.now.getTime() - RECENT_DONE_DAYS * DAY_MS);

  const open = notInArray(tasks.status, [...CLOSED_STATUSES]);
  const recentDone = and(eq(tasks.status, "done"), gte(tasks.completedAt, since));
  // Rows for the counts (open + done this week) plus whatever the status filter shows.
  const scope =
    f.status === "any" ? undefined : or(open, recentDone, f.status === "open" ? undefined : eq(tasks.status, f.status));

  const limit = opts.limit ?? TEAM_TASKS_LIMIT;
  // One more than the limit tells whether anything was left out.
  const fetched = await queryVisibleTasks(ctx, [
    f.companyId ? eq(tasks.companyId, f.companyId) : undefined,
    assigneeWhere(f.assignee),
    scope,
  ], limit + 1);
  const capped = fetched.length > limit;
  const rows = capped ? fetched.slice(0, limit) : fetched;

  // Founders always have a group (when not filtered to someone else).
  const founders = await ctx.db
    .select({ id: users.id, shortName: users.shortName })
    .from(users)
    .where(eq(users.role, "founder"))
    .orderBy(asc(users.shortName));

  const groups = new Map<string, TeamGroup>();
  const ensure = (key: string, name: string): TeamGroup => {
    let g = groups.get(key);
    if (!g) {
      const [kind, id] = key === "unassigned" ? (["unassigned", null] as const) : (key.split(":") as ["user" | "person", string]);
      g = { key, kind, id, name, personId: kind === "person" ? id : null, companyId: null, left: false, telegram: null, counts: emptyCounts(), tasks: [] };
      groups.set(key, g);
    }
    return g;
  };

  const showGroup = (key: string) => !f.assignee || f.assignee === key;
  for (const u of founders) if (showGroup(`user:${u.id}`)) ensure(`user:${u.id}`, u.shortName);

  for (const t of rows) {
    const key = groupKeyOf(t);
    if (!showGroup(key)) continue;
    const name = t.assignee?.name ?? (key === "unassigned" ? "Unassigned" : t.ownerName);
    const g = ensure(key, name);
    const closed = CLOSED_STATUSES.includes(t.status);
    const isRecentDone = t.status === "done" && !!t.completedAt && t.completedAt.getTime() >= since.getTime();
    if (!closed) {
      g.counts.open++;
      if (t.isOverdue) g.counts.overdue++;
      if (t.dueDate === todayIso) g.counts.dueToday++;
      if (t.status === "waiting") g.counts.waiting++;
    } else if (isRecentDone) g.counts.doneRecent++;

    const shown = statusMatches(t, f.status) || (opts.keepRecentDone && isRecentDone);
    if (shown && (!f.overdueOnly || t.isOverdue)) g.tasks.push(t);
  }
  if (f.assignee === "unassigned") ensure("unassigned", "Unassigned");
  if (f.assignee?.startsWith("person:") && !groups.has(f.assignee)) {
    const id = f.assignee.slice("person:".length);
    const [p] = await ctx.db.select({ fullName: people.fullName }).from(people).where(and(eq(people.id, id), visiblePeopleWhere(ctx)));
    if (p) ensure(f.assignee, p.fullName);
  }

  // Person records (links, left, first company) and Telegram states.
  const list = [...groups.values()];
  const personIds = list.filter((g) => g.kind === "person").map((g) => g.id!);
  const userIds = list.filter((g) => g.kind === "user").map((g) => g.id!);
  if (personIds.length || userIds.length) {
    const recs = await ctx.db
      .select({ id: people.id, userId: people.userId, fullName: people.fullName, leftAt: people.leftAt })
      .from(people)
      .where(
        and(
          or(
            personIds.length ? inArray(people.id, personIds) : undefined,
            userIds.length ? inArray(people.userId, userIds) : undefined,
          ),
          visiblePeopleWhere(ctx),
        ),
      );
    const allPersonIds = recs.map((r) => r.id);
    const firstCompany = await firstCompanies(ctx, allPersonIds);
    for (const r of recs) {
      const g = r.userId ? groups.get(`user:${r.userId}`) : groups.get(`person:${r.id}`);
      if (!g) continue;
      g.personId = r.id;
      g.left = !!r.leftAt;
      g.companyId = firstCompany.get(r.id) ?? null;
      if (g.kind === "person") g.name = r.fullName;
    }
    const tg = await telegramStatuses(ctx, personIds, userIds);
    for (const g of list) g.telegram = tg.get(g.key) ?? null;
  }

  const order = (g: TeamGroup) =>
    g.kind === "user" ? (g.id === ctx.user.id ? 0 : 1) : g.kind === "person" ? 2 : 3;
  list.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
  return { today: todayIso, groups: list, filters: f, capped, limit };
}

async function firstCompanies(ctx: ServiceContext, personIds: string[]): Promise<Map<string, string>> {
  if (!personIds.length) return new Map();
  const rows = await ctx.db
    .select({ personId: personCompanies.personId, companyId: personCompanies.companyId })
    .from(personCompanies)
    .innerJoin(companies, eq(companies.id, personCompanies.companyId))
    .where(
      and(
        inArray(personCompanies.personId, personIds),
        eq(personCompanies.isActive, true),
        isNull(companies.archivedAt),
        inAccessibleCompany(ctx, personCompanies.companyId),
      ),
    )
    .orderBy(asc(companies.name));
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.personId)) out.set(r.personId, r.companyId);
  return out;
}

export interface PersonTasks {
  group: TeamGroup;
  open: TaskView[];
  overdue: TaskView[];
  doneRecent: TaskView[];
  /** Preset for "Assign a task": the assignee value of the task form and a company. */
  assignee: string;
  companyId: string | null;
}

/**
 * The person page's Tasks section: the person's (or founder's) open, overdue and recently done
 * tasks, read through the Team view so the same visibility rules apply. Founders only.
 */
export async function getPersonTasks(ctx: ServiceContext, personId: string): Promise<PersonTasks> {
  assertTeamTasksAccess(ctx);
  assertValidId(personId, "Person");
  const [p] = await ctx.db
    .select({ id: people.id, userId: people.userId })
    .from(people)
    .where(and(eq(people.id, personId), visiblePeopleWhere(ctx)));
  if (!p) throw new ServiceError("not_found", "Person not found");
  const assignee = p.userId ? `user:${p.userId}` : `person:${p.id}`;
  const board = await loadBoard(ctx, { assignee, status: "open" }, { keepRecentDone: true });
  const group =
    board.groups.find((g) => g.key === assignee) ??
    ({ key: assignee, kind: p.userId ? "user" : "person", id: p.userId ?? p.id, name: "", personId: p.id, companyId: null, left: false, telegram: null, counts: emptyCounts(), tasks: [] } satisfies TeamGroup);
  const since = ctx.now.getTime() - RECENT_DONE_DAYS * DAY_MS;
  const open = group.tasks.filter((t) => !CLOSED_STATUSES.includes(t.status) && !t.isOverdue);
  const overdue = group.tasks.filter((t) => t.isOverdue);
  const doneRecent = group.tasks.filter((t) => t.status === "done" && !!t.completedAt && t.completedAt.getTime() >= since);
  const companyId = group.companyId ?? (await firstCompanies(ctx, [p.id])).get(p.id) ?? null;
  return { group, open, overdue, doneRecent, assignee, companyId };
}
