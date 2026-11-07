import "server-only";
import { cache } from "react";
import { and, asc, desc, eq, getTableColumns, inArray, isNotNull, isNull, like, lte, or, sql } from "drizzle-orm";
import { addDays, hmToMinutes, todayInTimeZone, zonedTimeToUtc, type IsoDate } from "@/lib/dates";
import {
  askTimesOf,
  AWAIT_COMMENT_MINUTES,
  describeRoutinePlan,
  describeSchedule,
  effectiveFounderRoutineChase,
  effectiveRoutineChase,
  itemStateOf,
  minutesToHm,
  nextAskAt,
  OPEN_RUN_STATUSES,
  openItems,
  routineChaseOverrideSchema,
  routineInputSchema,
  runOutcome,
  runProgress,
  ROUTINE_TIMEZONE,
  RUN_ITEM_KEY,
  scheduleOf,
  type AwaitingComment,
  type ChecklistItem,
  type ItemState,
  type ItemStates,
  type RoutineChase,
  type RoutineChaseOverride,
  type RoutineSchedule,
  type RoutineStatus,
  type RunStatus,
} from "@/lib/routines";
import { effectiveStaffSettings, parsePersonOverride, type StaffSettings } from "@/lib/staff-schemas";
import type { Db } from "@/server/db/connect";
import {
  companies,
  notificationsOutbox,
  orgPosts,
  people,
  personCompanies,
  routineComments,
  routineRuns,
  routines,
  telegramLinks,
  users,
  type Routine,
  type RoutineRun,
} from "@/server/db/schema";
import { EXAMPLE_ROUTINE_KEY, exampleRoutineInput, routineColumns } from "@/server/db/example-routines";
import { notifyFounders } from "@/server/notifications/staff-notify";
import { enqueue, enqueueForPerson } from "@/server/notifications/outbox";
import { assertRoutineAccess, assertValidId } from "./access";
import type { ServiceContext } from "./context";
import { ServiceError } from "./errors";
import { CACHE_TAGS, sharedCache } from "@/server/cache";
import { listFounders } from "./people";
import { loadStaffDefaults, readStaffDefaults } from "./staff";

/**
 * Routines: recurring jobs assigned to a person (staff, through the Telegram bot, in Russian) or a
 * founder (their normal channel and rules). Founders manage them here (full CRUD; archive keeps the
 * history, delete only while a routine has no runs). The planner (notifications/routine-planner.ts)
 * opens ONE run on each scheduled day (within the optional start / end dates), asks at each ask
 * time, chases per the routine's / person's / global settings, escalates to the founders and closes
 * runs that were not finished as partly / missed. The assignee ticks items (done), or marks them
 * partly / can't with a comment, and can comment on the run or an item; founders see all of it.
 */

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function parseRoutineOverride(raw: unknown): RoutineChaseOverride {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = routineChaseOverrideSchema.safeParse(raw);
  if (!r.success) return {};
  return Object.fromEntries(Object.entries(r.data).filter(([, v]) => v !== undefined)) as RoutineChaseOverride;
}

/**
 * The staff settings that apply to the assignee: global defaults ← the person's override (founders:
 * the global defaults, used only for "remind until"; see `routineChase`).
 */
export async function settingsForAssignee(db: Db, personId: string | null, defaults?: StaffSettings): Promise<StaffSettings> {
  const d = defaults ?? (await loadStaffDefaults(db));
  if (!personId) return d;
  const [p] = await db.select({ staffChase: people.staffChase }).from(people).where(eq(people.id, personId));
  return effectiveStaffSettings(d, parsePersonOverride(p?.staffChase));
}

/**
 * The chase in force for a routine: a person's routine uses their staff settings (`s`) ← the
 * routine's override; a founder's routine its own defaults (FOUNDER_ROUTINE_CHASE: the ask + one
 * reminder) ← the override. `s` is the assignee's settings (founders: the global staff defaults).
 */
export function routineChase(r: Pick<Routine, "assigneePersonId">, s: StaffSettings, override: RoutineChaseOverride): RoutineChase {
  return r.assigneePersonId ? effectiveRoutineChase(s, override) : effectiveFounderRoutineChase(s, override);
}

/**
 * The instants of a day: the first ask, "remind until" (done after it = late) and the end of the
 * window in which a run may still open (the later of "until" and the last ask time).
 */
export function routineTimes(r: Pick<Routine, "time" | "times" | "timezone">, chase: RoutineChase, day: IsoDate) {
  const times = askTimesOf(r);
  const lastAsk = hmToMinutes(times[times.length - 1]!);
  const openUntil = minutesToHm(Math.min(Math.max(hmToMinutes(chase.chaseUntil), lastAsk + 1), 24 * 60 - 1));
  return {
    askAt: zonedTimeToUtc(day, times[0]!, r.timezone),
    untilAt: zonedTimeToUtc(day, chase.chaseUntil, r.timezone),
    openUntilAt: zonedTimeToUtc(day, openUntil, r.timezone),
  };
}

/** Is the routine past its "Ends on" date (in its own time zone)? */
export function routineHasEnded(r: Pick<Routine, "endsOn" | "timezone">, now: Date): boolean {
  return !!r.endsOn && todayInTimeZone(now, r.timezone) > r.endsOn;
}

// ---------------------------------------------------------------------------
// Who works where (the form's company filter, and the same rule server-side)
// ---------------------------------------------------------------------------

/**
 * The companies a person works for: their active company links (People) and the org-chart posts
 * they hold. Empty = no link anywhere (then any company may be picked).
 */
export async function personCompanyIds(db: Db, personIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!personIds.length) return out;
  const [links, posts] = await Promise.all([
    db
      .select({ personId: personCompanies.personId, companyId: personCompanies.companyId })
      .from(personCompanies)
      .where(and(inArray(personCompanies.personId, [...personIds]), eq(personCompanies.isActive, true))),
    db
      .select({ personId: orgPosts.personId, companyId: orgPosts.companyId })
      .from(orgPosts)
      .where(and(inArray(orgPosts.personId, [...personIds]), isNull(orgPosts.archivedAt))),
  ]);
  for (const row of [...links, ...posts]) {
    if (!row.personId) continue;
    const list = out.get(row.personId) ?? [];
    if (!list.includes(row.companyId)) list.push(row.companyId);
    out.set(row.personId, list);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface RoutineView {
  routine: Routine;
  /** The status shown: "ended" as soon as the end date has passed (before the planner marks it). */
  status: RoutineStatus;
  assigneeKind: "person" | "founder";
  assigneeName: string;
  companyName: string | null;
  companySlug: string | null;
  schedule: RoutineSchedule;
  scheduleText: string;
  times: string[];
  override: RoutineChaseOverride;
  /** The settings in force (routine ← person ← global). */
  chase: RoutineChase;
  /** The defaults the routine falls back to (person ← global), shown next to the form fields. */
  defaults: RoutineChase;
  /** Who is told on escalation ("Nuraaly", "both founders", "Talant"). */
  escalateNames: string;
  /** The plain-language summary ("Bot asks Asan Mon–Sat at 15:00, …"). */
  planText: string;
  today: RoutineRun | null;
  /** The latest run (today's or an earlier one). */
  lastRun: RoutineRun | null;
  /** The next ask (null when paused / archived / ended). */
  nextDueAt: Date | null;
  commentsCount: number;
  /** Staff: the bot may message them now (linked, switched on, not paused / stopped). Founders: true. */
  reachable: boolean;
}

export interface RoutineFilter {
  /** One routine (the routine page). */
  id?: string | null;
  companyId?: string | null;
  personId?: string | null;
  userId?: string | null;
  status?: RoutineStatus | "all" | null;
}

const assigneeName = (r: { pFull: string | null; pShort: string | null; uShort: string | null }) => r.pShort || r.pFull || r.uShort || "?";

export async function reachablePersonIds(db: Db, now: Date, personIds?: string[]): Promise<Set<string>> {
  if (personIds && !personIds.length) return new Set();
  const rows = await db
    .select({ id: people.id })
    .from(people)
    .innerJoin(telegramLinks, eq(telegramLinks.personId, people.id))
    .where(
      and(
        personIds ? inArray(people.id, personIds) : undefined,
        eq(people.botEnabled, true),
        isNull(people.leftAt),
        isNull(people.userId),
        isNull(telegramLinks.stoppedAt),
        or(isNull(people.botPausedUntil), lte(people.botPausedUntil, now)),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/** "Nuraaly", "both founders", "Talant" (a founder's own routine: the other founder by default). */
function escalationNames(r: Routine, chase: RoutineChase, founders: { id: string; name: string }[]): string {
  const chosen = chase.escalateTo.length ? founders.filter((f) => chase.escalateTo.includes(f.id)) : r.assigneeUserId ? founders.filter((f) => f.id !== r.assigneeUserId) : founders;
  if (!chosen.length) return "nobody";
  if (chosen.length === founders.length && founders.length === 2) return "both founders";
  return chosen.map((f) => f.name).join(" and ");
}

export async function listRoutines(ctx: ServiceContext, filter: RoutineFilter = {}): Promise<RoutineView[]> {
  assertRoutineAccess(ctx);
  const status = filter.status ?? "all";
  const where = and(
    filter.id ? eq(routines.id, filter.id) : undefined,
    filter.companyId ? eq(routines.companyId, filter.companyId) : undefined,
    filter.personId ? eq(routines.assigneePersonId, filter.personId) : undefined,
    filter.userId ? eq(routines.assigneeUserId, filter.userId) : undefined,
    status === "all" ? undefined : eq(routines.status, status),
  );
  // ONE query (queries are serial on one connection): the routine with its assignee (and their
  // chase override and whether the bot may message them), company, latest run (lateral) and
  // comment count. The defaults and the founders come from the shared cache.
  const latest = ctx.db.select().from(routineRuns).where(eq(routineRuns.routineId, routines.id)).orderBy(desc(routineRuns.runDate)).limit(1).as("latest_run");
  // Every run column, read through the lateral subquery's alias.
  const lastRun = Object.fromEntries(Object.keys(getTableColumns(routineRuns)).map((k) => [k, latest[k as keyof typeof latest]])) as unknown as typeof latest._.selectedFields;
  const [rows, defaults, founderRows] = await Promise.all([
    ctx.db
      .select({
        r: routines,
        pFull: people.fullName,
        pShort: people.shortName,
        pChase: people.staffChase,
        uShort: users.shortName,
        companyName: companies.name,
        companySlug: companies.slug,
        last: lastRun,
        comments: sql<number>`(select count(*) from ${routineComments} where ${routineComments.routineId} = ${routines.id})`.mapWith(Number),
        // Same rule as `reachablePersonIds` (linked, switched on, not stopped / paused / left).
        reachable: sql<boolean>`(${people.botEnabled} and ${people.leftAt} is null and ${people.userId} is null and (${isNull(people.botPausedUntil)} or ${lte(people.botPausedUntil, ctx.now)}) and exists (select 1 from ${telegramLinks} where ${telegramLinks.personId} = ${people.id} and ${telegramLinks.stoppedAt} is null))`.mapWith(
          (v: unknown) => v === true || v === "t" || v === "true",
        ),
      })
      .from(routines)
      .leftJoin(people, eq(people.id, routines.assigneePersonId))
      .leftJoin(users, eq(users.id, routines.assigneeUserId))
      .leftJoin(companies, eq(companies.id, routines.companyId))
      .leftJoinLateral(latest, sql`true`)
      .where(where)
      .orderBy(sql`case ${routines.status} when 'active' then 0 when 'paused' then 1 when 'ended' then 2 else 3 end`, asc(routines.title)),
    readStaffDefaults(ctx),
    listFounders(ctx),
  ]);
  if (!rows.length) return [];
  const founders = founderRows.map((f) => ({ id: f.id, name: f.shortName }));
  return rows.map((row) => {
    const r = row.r;
    const s = r.assigneePersonId ? effectiveStaffSettings(defaults, parsePersonOverride(row.pChase)) : defaults;
    const override = parseRoutineOverride(r.chase);
    const schedule = scheduleOf(r);
    const chase = routineChase(r, s, override);
    const last: RoutineRun | null = row.last?.id ? row.last : null;
    const today = last && last.runDate === todayInTimeZone(ctx.now, r.timezone) ? last : null;
    const shownStatus: RoutineStatus = r.status === "active" && routineHasEnded(r, ctx.now) ? "ended" : (r.status as RoutineStatus);
    const name = assigneeName(row);
    const escalateNames = escalationNames(r, chase, founders);
    return {
      routine: r,
      status: shownStatus,
      assigneeKind: r.assigneePersonId ? "person" : "founder",
      assigneeName: name,
      companyName: row.companyName,
      companySlug: row.companySlug,
      schedule,
      scheduleText: describeSchedule(schedule),
      times: askTimesOf(r),
      override,
      chase,
      defaults: routineChase(r, s, {}),
      escalateNames,
      planText: describeRoutinePlan({
        assigneeName: name,
        forFounder: !r.assigneePersonId,
        schedule,
        chase,
        escalateNames,
        startsOn: r.startsOn,
        endsOn: r.endsOn,
      }),
      today,
      lastRun: last,
      nextDueAt:
        shownStatus === "active"
          ? nextAskAt({ schedule, startsOn: r.startsOn, endsOn: r.endsOn, timezone: r.timezone }, ctx.now, {
              todayClosed: !!today && !OPEN_RUN_STATUSES.includes(today.status as RunStatus),
            })
          : null,
      commentsCount: row.comments,
      reachable: r.assigneePersonId ? row.reachable : true,
    };
  });
}

/**
 * Deduped per render (React `cache`): the routine page's runs and messages both start here.
 * Writes run outside a render (server actions, API, planner), so they always read the row.
 */
const loadRoutine = cache(async (ctx: ServiceContext, id: string): Promise<Routine> => {
  assertRoutineAccess(ctx);
  assertValidId(id, "Routine");
  const [r] = await ctx.db.select().from(routines).where(eq(routines.id, id));
  if (!r) throw new ServiceError("not_found", "Routine not found");
  return r;
});

export async function getRoutine(ctx: ServiceContext, id: string): Promise<RoutineView> {
  assertRoutineAccess(ctx);
  assertValidId(id, "Routine");
  const [view] = await listRoutines(ctx, { id, status: "all" });
  if (!view) throw new ServiceError("not_found", "Routine not found");
  return view;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

async function validateRefs(
  ctx: ServiceContext,
  v: { companyId: string | null; personId: string | null; userId: string | null; escalateTo?: string[] },
) {
  if (v.companyId) {
    const [c] = await ctx.db.select({ id: companies.id }).from(companies).where(and(eq(companies.id, v.companyId), isNull(companies.archivedAt)));
    if (!c) throw new ServiceError("validation", "Unknown company", { companyId: ["Unknown company"] });
  }
  if (v.personId) {
    const [p] = await ctx.db.select().from(people).where(eq(people.id, v.personId));
    if (!p || p.leftAt) throw new ServiceError("validation", "Pick someone who still works here", { assignee: ["Unknown person"] });
    if (p.userId) throw new ServiceError("validation", "Pick the founder from the Founders group", { assignee: ["Founders are assigned as founders"] });
    // The same rule as the form: a person's routine is for one of the companies they work for (or group-wide).
    if (v.companyId) {
      const theirs = (await personCompanyIds(ctx.db, [p.id])).get(p.id) ?? [];
      if (theirs.length && !theirs.includes(v.companyId)) {
        const name = p.shortName || p.fullName;
        throw new ServiceError("validation", `${name} does not work for that company`, { companyId: [`${name} does not work for this company`] });
      }
    }
  }
  if (v.userId) {
    const [u] = await ctx.db.select({ role: users.role }).from(users).where(eq(users.id, v.userId));
    if (!u || u.role !== "founder") throw new ServiceError("validation", "Unknown founder", { assignee: ["Unknown founder"] });
  }
  if (v.escalateTo?.length) {
    const found = await ctx.db.select({ id: users.id }).from(users).where(and(inArray(users.id, v.escalateTo), eq(users.role, "founder")));
    if (found.length !== new Set(v.escalateTo).size) throw new ServiceError("validation", "Pick founders to tell", { "chase.escalateTo": ["Unknown founder"] });
  }
}

function parseInput(input: unknown) {
  const r = routineInputSchema.safeParse(input);
  if (r.success) return r.data;
  const fields: Record<string, string[]> = {};
  for (const issue of r.error.issues) {
    const key = issue.path.join(".") || "form";
    (fields[key] ??= []).push(issue.message);
  }
  throw new ServiceError("validation", r.error.issues[0]?.message ?? "Check the form", fields);
}

export async function createRoutine(ctx: ServiceContext, input: unknown, opts: { seedKey?: string } = {}): Promise<Routine> {
  assertRoutineAccess(ctx);
  const p = parseInput(input);
  await validateRefs(ctx, { companyId: p.companyId, ...p.assignee, escalateTo: p.chase.escalateTo });
  if (p.endsOn && p.endsOn < todayInTimeZone(ctx.now, ROUTINE_TIMEZONE)) {
    throw new ServiceError("validation", "The end date is in the past", { endsOn: ["Pick today or a later day"] });
  }
  const [row] = await ctx.db
    .insert(routines)
    .values({ ...routineColumns(p), status: "active", createdByUserId: ctx.user.id, seedKey: opts.seedKey ?? null, createdAt: ctx.now, updatedAt: ctx.now })
    .returning();
  return row!;
}

/** What an edit did to today's run (the form's confirmation explains it before saving). */
export type TodayEffect =
  /** Today's run was open: added items joined it, removed ones left it; the person gets one updated message. */
  | "open_run_updated"
  /** Today's run was done; the founder chose "add to today too": it is open again with the new items. */
  | "reopened"
  /** Today's run was already closed: the change applies from the next run. */
  | "next_run"
  | null;

const sameItems = (a: readonly ChecklistItem[], b: readonly ChecklistItem[]) =>
  a.length === b.length &&
  a.every((x, i) => x.key === b[i]!.key && x.label === b[i]!.label && (x.details ?? "") === (b[i]!.details ?? "") && !!x.needsComment === !!b[i]!.needsComment);

/**
 * Edits a routine. When the checklist changes and today's run exists:
 * - the run is **open**: new items are added to it, removed ones dropped (their ticks too), labels /
 *   details follow; if nothing is left open it is done; the assignee gets ONE updated message;
 * - the run is **done**: it stays done (the change applies from the next run) unless
 *   `applyToToday` is set and items were added — then it reopens with them and asks again;
 * - partly / missed: closed, unchanged.
 */
export async function updateRoutine(ctx: ServiceContext, id: string, input: unknown): Promise<Routine & { todayEffect: TodayEffect }> {
  const current = await loadRoutine(ctx, id);
  if (current.status === "archived") throw new ServiceError("validation", "Restore the routine before editing it");
  const p = parseInput(input);
  await validateRefs(ctx, { companyId: p.companyId, ...p.assignee, escalateTo: p.chase.escalateTo });
  const assigneeChanged = current.assigneePersonId !== p.assignee.personId || current.assigneeUserId !== p.assignee.userId;
  const cols = routineColumns(p, current.items);
  const today = todayInTimeZone(ctx.now, current.timezone);
  // A new end date in the future (or none) brings an ended routine back.
  const status = current.status === "ended" && (!cols.endsOn || cols.endsOn >= today) ? "active" : current.status;
  const [row] = await ctx.db
    .update(routines)
    .set({ ...cols, status, updatedAt: ctx.now })
    .where(eq(routines.id, current.id))
    .returning();
  // Messages already queued for the old assignee make no sense any more.
  if (assigneeChanged) await cancelRoutineMessages(ctx.db, current.id, "reassigned");

  let todayEffect: TodayEffect = null;
  const [run] = await ctx.db.select().from(routineRuns).where(and(eq(routineRuns.routineId, current.id), eq(routineRuns.runDate, today)));
  const newItems = row!.confirmation === "checklist" ? row!.items : [];
  if (run && !sameItems(run.items, newItems)) {
    const isOpen = OPEN_RUN_STATUSES.includes(run.status as RunStatus);
    const oldKeys = new Set(run.items.map((i) => i.key));
    const added = newItems.filter((i) => !oldKeys.has(i.key));
    if (isOpen || (run.status === "done" && p.applyToToday && added.length)) {
      const keep = new Set(newItems.map((i) => i.key));
      const states: ItemStates = Object.fromEntries(Object.entries(run.itemStates ?? {}).filter(([k]) => keep.has(k) || (k === RUN_ITEM_KEY && !newItems.length)));
      const itemsDone = run.itemsDone.filter((k) => keep.has(k));
      const next = { items: newItems, itemsDone, itemStates: states };
      const left = newItems.length ? openItems(next).length : itemStateOf(next, RUN_ITEM_KEY) === "open" && run.status !== "done" ? 1 : 0;
      const finished = left === 0;
      const closeStatus = finished ? closingStatus(next) : null;
      const [updated] = await ctx.db
        .update(routineRuns)
        .set({
          ...next,
          awaitingComment: null,
          ...(finished
            ? { status: closeStatus!, doneAt: closeStatus === "done" ? (run.doneAt ?? ctx.now) : null, closedAt: run.closedAt ?? ctx.now }
            : { status: run.status === "done" ? "open" : run.status, doneAt: null, closedAt: null }),
        })
        .where(eq(routineRuns.id, run.id))
        .returning();
      todayEffect = isOpen ? "open_run_updated" : "reopened";
      if (finished) await cancelRoutineMessages(ctx.db, current.id, "done", run.id);
      else if (row!.status === "active") {
        await queueRunMessage(ctx.db, row!, updated!, {
          slot: `upd${ctx.now.getTime()}`,
          scheduledFor: ctx.now,
          expiresAt: zonedTimeToUtc(addDays(today, 1), "00:00", current.timezone),
          reminder: false,
          updated: true,
        });
      }
    } else {
      todayEffect = "next_run";
    }
  }
  return Object.assign(row!, { todayEffect });
}

/**
 * Only the checklist (the routine page's checklist card): everything else stays as it is. Same
 * effect on today's run as an edit in the dialog (`todayEffect`: the open run is updated and the
 * person gets ONE updated message; a finished run gets the new items only with `applyToToday`).
 * A routine with a plain "Done" button becomes a checklist routine.
 */
export async function updateRoutineChecklist(
  ctx: ServiceContext,
  id: string,
  items: unknown,
  opts: { applyToToday?: boolean } = {},
): Promise<Routine & { todayEffect: TodayEffect }> {
  const view = await getRoutine(ctx, id);
  const r = view.routine;
  return updateRoutine(ctx, id, {
    title: r.title,
    description: r.description,
    companyId: r.companyId ?? "",
    assignee: r.assigneePersonId ? `person:${r.assigneePersonId}` : `user:${r.assigneeUserId}`,
    scheduleKind: r.scheduleKind,
    days: r.days ?? [],
    monthDay: r.monthDay ?? "",
    times: view.times,
    startsOn: r.startsOn ?? "",
    endsOn: r.endsOn ?? "",
    confirmation: "checklist",
    items,
    chase: view.override,
    applyToToday: !!opts.applyToToday,
  });
}

/** Pause / resume / archive / restore. Pausing or archiving cancels waiting messages; today's open run is closed when the day ends. */
export async function setRoutineStatus(ctx: ServiceContext, id: string, status: RoutineStatus): Promise<Routine> {
  const current = await loadRoutine(ctx, id);
  if (!["active", "paused", "archived"].includes(status)) throw new ServiceError("validation", "Unknown status");
  if (status === "active" && routineHasEnded(current, ctx.now)) {
    throw new ServiceError("validation", `This routine ended on ${current.endsOn}: change "Ends on" to run it again`);
  }
  const [row] = await ctx.db
    .update(routines)
    .set({ status, archivedAt: status === "archived" ? ctx.now : null, updatedAt: ctx.now })
    .where(eq(routines.id, current.id))
    .returning();
  if (status !== "active") await cancelRoutineMessages(ctx.db, current.id, status);
  return row!;
}

/** Delete only a routine that never ran (its history would be lost): otherwise archive it. */
export async function deleteRoutine(ctx: ServiceContext, id: string): Promise<void> {
  const current = await loadRoutine(ctx, id);
  const [run] = await ctx.db.select({ id: routineRuns.id }).from(routineRuns).where(eq(routineRuns.routineId, current.id)).limit(1);
  if (run) throw new ServiceError("validation", "This routine has a history: archive it instead of deleting");
  await ctx.db.delete(routines).where(eq(routines.id, current.id));
}

// ---------------------------------------------------------------------------
// Runs: history and message log (the routine page)
// ---------------------------------------------------------------------------

export interface RunItemView {
  key: string;
  label: string;
  state: ItemState | "open";
  at: Date | null;
  by: string | null;
  comment: string | null;
}

export interface RunCommentView {
  id: string;
  itemKey: string | null;
  itemLabel: string | null;
  kind: string;
  text: string;
  author: string;
  at: Date;
}

export interface RunView {
  run: RoutineRun;
  outcome: ReturnType<typeof runOutcome>;
  /** Checklist labels not done. */
  missing: string[];
  progress: { done: number; total: number };
  items: RunItemView[];
  comments: RunCommentView[];
  /** Reminders sent (times). */
  reminders: Date[];
  asks: Date[];
}

export async function listRoutineRuns(ctx: ServiceContext, id: string, limit = 60): Promise<RunView[]> {
  const r = await loadRoutine(ctx, id);
  const rows = await ctx.db
    .select()
    .from(routineRuns)
    .where(eq(routineRuns.routineId, r.id))
    .orderBy(desc(routineRuns.runDate))
    .limit(Math.min(Math.max(limit, 1), 366));
  if (!rows.length) return [];
  const s = await settingsForAssignee(ctx.db, r.assigneePersonId, await readStaffDefaults(ctx));
  const chase = routineChase(r, s, parseRoutineOverride(r.chase));
  const runIds = rows.map((x) => x.id);
  const [comments, sent] = await Promise.all([
    ctx.db
      .select({ c: routineComments, pFull: people.fullName, pShort: people.shortName, uShort: users.shortName })
      .from(routineComments)
      .leftJoin(people, eq(people.id, routineComments.authorPersonId))
      .leftJoin(users, eq(users.id, routineComments.authorUserId))
      .where(inArray(routineComments.runId, runIds))
      .orderBy(asc(routineComments.createdAt)),
    ctx.db
      .select({ payload: notificationsOutbox.payload, sentAt: notificationsOutbox.sentAt })
      .from(notificationsOutbox)
      .where(
        and(
          inArray(notificationsOutbox.kind, ["staff_routine", "routine_reminder"]),
          eq(notificationsOutbox.status, "sent"),
          sql`(${notificationsOutbox.payload} ->> 'routineId') = ${r.id}`,
        ),
      ),
  ]);
  return rows.map((run) => {
    const labels = new Map(run.items.map((i) => [i.key, i.label]));
    const items: RunItemView[] = (run.items.length ? run.items : [{ key: RUN_ITEM_KEY, label: "Done" }]).map((i) => {
      const rec = run.itemStates?.[i.key];
      const st = run.items.length ? itemStateOf(run, i.key) : run.status === "done" ? "done" : itemStateOf(run, RUN_ITEM_KEY);
      return {
        key: i.key,
        label: i.label,
        state: st,
        at: rec?.at ? new Date(rec.at) : st === "done" && run.doneAt ? run.doneAt : null,
        by: rec?.by ?? null,
        comment: rec?.comment ?? null,
      };
    });
    const mine = sent.filter((m) => (m.payload as { runId?: string })?.runId === run.id && m.sentAt);
    return {
      run,
      outcome: runOutcome(
        run as { status: RunStatus; doneAt: Date | null; escalatedAt: Date | null; itemStates: ItemStates },
        routineTimes(r, chase, run.runDate).untilAt,
      ),
      missing: run.status === "done" ? [] : run.items.filter((i) => itemStateOf(run, i.key) !== "done").map((i) => i.label),
      progress: runProgress(run),
      items,
      comments: comments
        .filter((c) => c.c.runId === run.id)
        .map((c) => ({
          id: c.c.id,
          itemKey: c.c.itemKey,
          itemLabel: c.c.itemKey ? (labels.get(c.c.itemKey) ?? c.c.itemKey) : null,
          kind: c.c.kind,
          text: c.c.text,
          author: c.pShort || c.pFull || c.uShort || "?",
          at: c.c.createdAt,
        })),
      reminders: mine.filter((m) => (m.payload as { reminder?: boolean }).reminder).map((m) => m.sentAt!).sort((a, b) => a.getTime() - b.getTime()),
      asks: mine.filter((m) => !(m.payload as { reminder?: boolean }).reminder).map((m) => m.sentAt!).sort((a, b) => a.getTime() - b.getTime()),
    };
  });
}

export interface RoutineMessageView {
  id: string;
  at: Date;
  /** "Ask", "Reminder", "Updated checklist", "Escalation", "Done (to founders)", "Can't (to founders)", "Comment (to founders)". */
  kind: string;
  to: string;
  status: string;
  /** Why it was not sent (quiet hours, daily cap, stopped…). */
  reason: string | null;
}

/** Every message about the routine (to the assignee and to the founders), newest first. */
export async function listRoutineMessages(ctx: ServiceContext, id: string, limit = 100): Promise<RoutineMessageView[]> {
  const r = await loadRoutine(ctx, id);
  const o = notificationsOutbox;
  const rows = await ctx.db
    .select({ row: o, pFull: people.fullName, pShort: people.shortName, uShort: users.shortName })
    .from(o)
    .leftJoin(people, eq(people.id, o.personId))
    .leftJoin(users, eq(users.id, o.userId))
    .where(
      or(
        sql`(${o.payload} ->> 'routineId') = ${r.id}`,
        // Keys "routine-…:<runId>…" of this routine's runs (a subquery: one round trip).
        and(
          like(o.dedupeKey, "routine-%"),
          sql`split_part(${o.dedupeKey}, ':', 2) in (select ${routineRuns.id}::text from ${routineRuns} where ${routineRuns.routineId} = ${r.id})`,
        ),
      ),
    )
    .orderBy(desc(o.scheduledFor))
    .limit(Math.min(Math.max(limit, 1), 500));
  return rows.map(({ row, pFull, pShort, uShort }) => {
    const p = (row.payload ?? {}) as { reminder?: boolean; updated?: boolean };
    const key = row.dedupeKey ?? "";
    const kind = key.startsWith("routine-esc:")
      ? "Escalation"
      : key.startsWith("routine-done:")
        ? "Done (to founders)"
        : key.startsWith("routine-cant:")
          ? "Can't (to founders)"
          : key.startsWith("routine-comment:")
            ? "Comment (to founders)"
            : p.updated
              ? "Updated checklist"
              : p.reminder
                ? "Reminder"
                : "Ask";
    return {
      id: row.id,
      at: row.sentAt ?? row.scheduledFor,
      kind,
      to: pShort || pFull || uShort || "?",
      status: row.status,
      reason: row.status === "sent" ? null : row.lastError,
    };
  });
}

/** Today's run (created if needed, opened now): the row and whether it was created. */
export async function openRun(db: Db, r: Routine, day: IsoDate, now: Date): Promise<{ run: RoutineRun; created: boolean }> {
  const inserted = await db
    .insert(routineRuns)
    .values({ routineId: r.id, runDate: day, status: "open", items: r.confirmation === "checklist" ? r.items : [], itemsDone: [], itemStates: {}, startedAt: now })
    .onConflictDoNothing({ target: [routineRuns.routineId, routineRuns.runDate] })
    .returning();
  if (inserted[0]) return { run: inserted[0], created: true };
  const [existing] = await db.select().from(routineRuns).where(and(eq(routineRuns.routineId, r.id), eq(routineRuns.runDate, day)));
  return { run: existing!, created: false };
}

/** Queues a message about a run for its assignee (person: staff rules; founder: the founder's rules). */
export async function queueRunMessage(
  db: Db,
  r: Routine,
  run: RoutineRun,
  m: { slot: number | string; scheduledFor: Date; expiresAt: Date | null; reminder: boolean; updated?: boolean },
) {
  const base = {
    dedupeKey: `routine:${run.id}:${m.slot}`,
    scheduledFor: m.scheduledFor,
    expiresAt: m.expiresAt,
    priority: "normal" as const,
    payload: { runId: run.id, routineId: r.id, slot: m.slot, reminder: m.reminder, ...(m.updated ? { updated: true } : {}) },
  };
  if (r.assigneePersonId) return enqueueForPerson(db, { ...base, personId: r.assigneePersonId, kind: "staff_routine" });
  return enqueue(db, { ...base, userId: r.assigneeUserId!, kind: "routine_reminder" });
}

/**
 * "Run now": opens today's run (even on a day that is not scheduled) and asks right away. On a run
 * that is still open it asks again now; a closed run is refused (use Re-run).
 */
export async function runRoutineNow(ctx: ServiceContext, id: string): Promise<RoutineRun> {
  const r = await loadRoutine(ctx, id);
  if (routineHasEnded(r, ctx.now) || r.status === "ended") throw new ServiceError("validation", `This routine ended on ${r.endsOn}: change "Ends on" first`);
  if (r.status !== "active") throw new ServiceError("validation", "Resume the routine first");
  const day = todayInTimeZone(ctx.now, r.timezone);
  const { run } = await openRun(ctx.db, r, day, ctx.now);
  if (!OPEN_RUN_STATUSES.includes(run.status as RunStatus)) throw new ServiceError("conflict", "Today's run is already closed: use Re-run to ask about what is missing");
  await queueRunMessage(ctx.db, r, run, {
    slot: `now${ctx.now.getTime()}`,
    scheduledFor: ctx.now,
    expiresAt: zonedTimeToUtc(addDays(day, 1), "00:00", r.timezone),
    reminder: false,
  });
  return run;
}

/**
 * "Re-run": asks again about today's MISSING items. A closed run of today (partly / missed / can't)
 * reopens: items not done become open again (comments stay); a fully done run is refused. Without a
 * run today it is the same as Run now.
 */
export async function rerunRoutineToday(ctx: ServiceContext, id: string): Promise<RoutineRun> {
  const r = await loadRoutine(ctx, id);
  const day = todayInTimeZone(ctx.now, r.timezone);
  const [run] = await ctx.db.select().from(routineRuns).where(and(eq(routineRuns.routineId, r.id), eq(routineRuns.runDate, day)));
  if (!run || OPEN_RUN_STATUSES.includes(run.status as RunStatus)) return runRoutineNow(ctx, id);
  if (run.status === "done") throw new ServiceError("conflict", "Nothing is missing today: the run is done");
  if (r.status !== "active" || routineHasEnded(r, ctx.now)) throw new ServiceError("validation", "Resume the routine first");
  const states: ItemStates = Object.fromEntries(Object.entries(run.itemStates ?? {}).filter(([, v]) => v.state === "done"));
  const [reopened] = await ctx.db
    .update(routineRuns)
    .set({ status: "open", itemStates: states, closedAt: null, doneAt: null, awaitingComment: null })
    .where(eq(routineRuns.id, run.id))
    .returning();
  await queueRunMessage(ctx.db, r, reopened!, {
    slot: `rerun${ctx.now.getTime()}`,
    scheduledFor: ctx.now,
    expiresAt: zonedTimeToUtc(addDays(day, 1), "00:00", r.timezone),
    reminder: false,
  });
  return reopened!;
}

/** Cancels the messages still waiting about a routine (all its runs). */
export async function cancelRoutineMessages(db: Db, routineId: string, reason: string, runId?: string): Promise<void> {
  await db
    .update(notificationsOutbox)
    .set({ status: "cancelled", lastError: `routine_${reason}`, nextAttemptAt: null })
    .where(
      and(
        inArray(notificationsOutbox.kind, ["staff_routine", "routine_reminder"]),
        inArray(notificationsOutbox.status, ["pending", "not_linked", "parked"]),
        runId
          ? like(notificationsOutbox.dedupeKey, `routine:${runId}:%`)
          : sql`(${notificationsOutbox.payload} ->> 'routineId') = ${routineId}`,
      ),
    );
}

// ---------------------------------------------------------------------------
// The assignee: tick, partly / can't, comments (bot)
// ---------------------------------------------------------------------------

export type TickActor = { personId: string } | { userId: string };

export interface TickResult {
  status: "ticked" | "done" | "already" | "closed";
  /** The ticked item's label (routine_tick). */
  label: string | null;
  /** The ticked item asks for a comment ("needs a comment"). */
  needsComment: boolean;
  remaining: { key: string; label: string }[];
  routine: Routine;
  run: RoutineRun;
}

async function actorName(db: Db, actor: TickActor): Promise<string> {
  if ("personId" in actor) {
    const [p] = await db.select({ full: people.fullName, short: people.shortName }).from(people).where(eq(people.id, actor.personId));
    return p?.short || p?.full || "?";
  }
  const [u] = await db.select({ short: users.shortName }).from(users).where(eq(users.id, actor.userId));
  return u?.short ?? "?";
}

const actorIds = (actor: TickActor) => ("personId" in actor ? { byPersonId: actor.personId } : { byUserId: actor.userId });

/** The status a run closes with once nothing is open: done (all done), partly (something done / partly), else missed. */
function closingStatus(run: { items: readonly ChecklistItem[]; itemsDone: readonly string[]; itemStates: ItemStates }): RunStatus {
  const keys = run.items.length ? run.items.map((i) => i.key) : [RUN_ITEM_KEY];
  const states = keys.map((k) => (run.items.length ? itemStateOf(run, k) : (run.itemStates[RUN_ITEM_KEY]?.state ?? "done")));
  if (states.every((s) => s === "done")) return "done";
  return states.some((s) => s === "done" || s === "partly") ? "partly" : "missed";
}

async function lockRun(tx: Db, runId: string, actor: TickActor) {
  const [row] = await tx
    .select({ run: routineRuns, routine: routines })
    .from(routineRuns)
    .innerJoin(routines, eq(routines.id, routineRuns.routineId))
    .where(eq(routineRuns.id, runId))
    .for("update", { of: routineRuns });
  const mine = row && ("personId" in actor ? row.routine.assigneePersonId === actor.personId : row.routine.assigneeUserId === actor.userId);
  if (!row || !mine || row.routine.status === "archived") throw new ServiceError("not_found", "Routine not found");
  return row;
}

async function afterClose(db: Db, routine: Routine, run: RoutineRun, now: Date) {
  await cancelRoutineMessages(db, routine.id, "done", run.id);
  if (run.status === "done" && routine.assigneePersonId) {
    const [p] = await db.select({ full: people.fullName, short: people.shortName }).from(people).where(eq(people.id, routine.assigneePersonId));
    await notifyFounders(db, {
      userIds: null,
      line: `${p?.short || p?.full || "Someone"} finished the routine "${routine.title}" (Telegram)`,
      dedupeKey: `routine-done:${run.id}`,
      now,
    });
  }
}

/**
 * The assignee ticks one checklist item (`item`) or the whole run (`item` = null: «✅ Готово» /
 * «✅ Всё готово» — every open item). Only the routine's assignee (a person through the bot, or the
 * founder it is assigned to); anyone else gets not_found. Nothing open any more → the run is
 * done (or partly when some items were marked partly / can't), waiting messages are cancelled and
 * (staff, all done) the founders get one summary line. Row-locked, so two taps at once are safe.
 */
export async function tickRoutineRun(db: Db, runId: string, actor: TickActor, item: string | null, now: Date): Promise<TickResult> {
  assertValidId(runId, "Routine run");
  const by = await actorName(db, actor);
  const result = await db.transaction(async (tx) => {
    const { run, routine } = await lockRun(tx as unknown as Db, runId, actor);
    const states: ItemStates = { ...(run.itemStates ?? {}) };
    const done = new Set(run.itemsDone);
    const cur = { items: run.items, itemsDone: [...done], itemStates: states };
    const left = () => openItems({ items: run.items, itemsDone: [...done], itemStates: states }).map((i) => ({ key: i.key, label: i.label }));
    if (!OPEN_RUN_STATUSES.includes(run.status as RunStatus)) {
      return { status: run.status === "done" ? ("already" as const) : ("closed" as const), label: null, needsComment: false, remaining: left(), routine, run };
    }
    const mark = (key: string) => {
      states[key] = { state: "done", at: now.toISOString(), by, ...actorIds(actor), comment: states[key]?.comment ?? null };
      done.add(key);
    };
    let label: string | null = null;
    let needsComment = false;
    if (item !== null) {
      const it = run.items.find((i) => i.key === item);
      if (!it) throw new ServiceError("not_found", "Item not found");
      label = it.label;
      if (itemStateOf(cur, item) !== "open") return { status: "already" as const, label, needsComment: false, remaining: left(), routine, run };
      mark(item);
      needsComment = !!it.needsComment;
    } else if (run.items.length) {
      for (const i of openItems(cur)) mark(i.key);
    } else {
      mark(RUN_ITEM_KEY);
    }
    const finished = run.items.length ? left().length === 0 : true;
    const next = { items: run.items, itemsDone: [...done], itemStates: states };
    const status = finished ? closingStatus(next) : (run.status as RunStatus);
    const [updated] = await tx
      .update(routineRuns)
      .set({
        itemsDone: [...done],
        itemStates: states,
        ...(finished ? { status, doneAt: status === "done" ? now : null, closedAt: now } : {}),
      })
      .where(eq(routineRuns.id, run.id))
      .returning();
    return { status: finished ? ("done" as const) : ("ticked" as const), label, needsComment, remaining: left(), routine, run: updated! };
  });
  if (result.status === "done") await afterClose(db, result.routine, result.run, now);
  return result;
}

/**
 * «🟡 Частично» / «❌ Не могу» with the (required) comment: marks one item, every open item
 * (`item` = null on a checklist) or the run itself (a routine without a checklist). The comment is
 * stored; «Не могу» tells the founders (one push through their normal rules: quiet hours, budget,
 * else a line in the next summary). Nothing left open → the run closes as partly / missed.
 */
export async function markRoutineItems(
  db: Db,
  runId: string,
  actor: TickActor,
  m: { item: string | null; state: "partly" | "cant"; comment: string },
  now: Date,
): Promise<{ routine: Routine; run: RoutineRun; labels: string[]; closed: boolean }> {
  assertValidId(runId, "Routine run");
  const text = m.comment.trim().slice(0, 2000);
  if (!text) throw new ServiceError("validation", "A comment is required");
  const by = await actorName(db, actor);
  const res = await db.transaction(async (tx) => {
    const { run, routine } = await lockRun(tx as unknown as Db, runId, actor);
    if (!OPEN_RUN_STATUSES.includes(run.status as RunStatus)) throw new ServiceError("conflict", "Today's run is already closed");
    const states: ItemStates = { ...(run.itemStates ?? {}) };
    const cur = { items: run.items, itemsDone: run.itemsDone, itemStates: states };
    let keys: string[];
    if (!run.items.length) keys = [RUN_ITEM_KEY];
    else if (m.item) {
      if (!run.items.some((i) => i.key === m.item)) throw new ServiceError("not_found", "Item not found");
      keys = [m.item];
    } else keys = openItems(cur).map((i) => i.key);
    for (const k of keys) states[k] = { state: m.state, at: now.toISOString(), by, ...actorIds(actor), comment: text };
    const itemsDone = run.itemsDone.filter((k) => !keys.includes(k));
    const next = { items: run.items, itemsDone, itemStates: states };
    const closed = run.items.length ? openItems(next).length === 0 : true;
    const status = closed ? closingStatus(next) : (run.status as RunStatus);
    const [updated] = await tx
      .update(routineRuns)
      .set({ itemsDone, itemStates: states, awaitingComment: null, ...(closed ? { status, closedAt: now, doneAt: status === "done" ? now : null } : {}) })
      .where(eq(routineRuns.id, run.id))
      .returning();
    await tx.insert(routineComments).values({
      routineId: routine.id,
      runId: run.id,
      itemKey: m.item && run.items.length ? m.item : null,
      kind: m.state,
      text,
      authorPersonId: "personId" in actor ? actor.personId : null,
      authorUserId: "userId" in actor ? actor.userId : null,
      createdAt: now,
    });
    const labels = run.items.length ? run.items.filter((i) => keys.includes(i.key)).map((i) => i.label) : [];
    return { routine, run: updated!, labels, closed };
  });
  if (res.closed) await afterClose(db, res.routine, res.run, now);
  const about = res.labels.length ? ` (${res.labels.join(", ")})` : "";
  if (m.state === "cant") {
    const line = `${by} can't do "${res.routine.title}"${about} today: ${text}`;
    await notifyFounders(db, {
      userIds: res.routine.assigneeUserId ? await founderIdsExcept(db, res.routine.assigneeUserId) : null,
      line,
      dedupeKey: `routine-cant:${res.run.id}:${m.item ?? "all"}`,
      now,
      push: { priority: "normal", message: { title: "Routine: can't do it", lines: [{ text: line }, { text: "Open Routines in the app for the details.", style: "muted" }] } },
    });
  } else {
    await notifyFounders(db, {
      userIds: res.routine.assigneeUserId ? await founderIdsExcept(db, res.routine.assigneeUserId) : null,
      line: `${by}: "${res.routine.title}"${about} partly done — ${text}`,
      dedupeKey: `routine-partly:${res.run.id}:${m.item ?? "all"}`,
      now,
    });
  }
  return res;
}

async function founderIdsExcept(db: Db, userId: string): Promise<string[]> {
  return (await db.select({ id: users.id }).from(users).where(eq(users.role, "founder"))).map((u) => u.id).filter((id) => id !== userId);
}

/**
 * A comment on the run (`item` null) or an item, from the assignee. Kept on the run (shown on the
 * routine page); when the item has a state, its comment is set too. The founders get one line in
 * their next summary (no push).
 */
export async function addRoutineComment(
  db: Db,
  runId: string,
  actor: TickActor,
  m: { item: string | null; text: string; kind?: "comment" | "done" },
  now: Date,
): Promise<{ routine: Routine; run: RoutineRun }> {
  assertValidId(runId, "Routine run");
  const text = m.text.trim().slice(0, 2000);
  if (!text) throw new ServiceError("validation", "Empty comment");
  const by = await actorName(db, actor);
  const res = await db.transaction(async (tx) => {
    const { run, routine } = await lockRun(tx as unknown as Db, runId, actor);
    const key = m.item && run.items.some((i) => i.key === m.item) ? m.item : null;
    const states: ItemStates = { ...(run.itemStates ?? {}) };
    const stateKey = key ?? (run.items.length ? null : RUN_ITEM_KEY);
    if (stateKey && states[stateKey]) states[stateKey] = { ...states[stateKey]!, comment: text };
    const [updated] = await tx.update(routineRuns).set({ itemStates: states, awaitingComment: null }).where(eq(routineRuns.id, run.id)).returning();
    const [c] = await tx
      .insert(routineComments)
      .values({
        routineId: routine.id,
        runId: run.id,
        itemKey: key,
        kind: m.kind ?? "comment",
        text,
        authorPersonId: "personId" in actor ? actor.personId : null,
        authorUserId: "userId" in actor ? actor.userId : null,
        createdAt: now,
      })
      .returning({ id: routineComments.id });
    const label = key ? run.items.find((i) => i.key === key)?.label : null;
    return { routine, run: updated!, commentId: c!.id, label };
  });
  await notifyFounders(db, {
    userIds: res.routine.assigneeUserId ? await founderIdsExcept(db, res.routine.assigneeUserId) : null,
    line: `${by} commented on "${res.routine.title}"${res.label ? ` (${res.label})` : ""}: ${text}`,
    dedupeKey: `routine-comment:${res.run.id}:${res.commentId}`,
    now,
  });
  return { routine: res.routine, run: res.run };
}

/** A run of one of the actor's own routines (the bot's buttons), or not_found. */
export async function loadRunForActor(db: Db, runId: string, actor: TickActor): Promise<{ routine: Routine; run: RoutineRun }> {
  assertValidId(runId, "Routine run");
  const [row] = await db
    .select({ run: routineRuns, routine: routines })
    .from(routineRuns)
    .innerJoin(routines, eq(routines.id, routineRuns.routineId))
    .where(eq(routineRuns.id, runId));
  const mine = row && ("personId" in actor ? row.routine.assigneePersonId === actor.personId : row.routine.assigneeUserId === actor.userId);
  if (!row || !mine || row.routine.status === "archived") throw new ServiceError("not_found", "Routine not found");
  return row;
}

/** Remembers that the assignee's next text message is a comment (or clears it). */
export async function setAwaitingComment(db: Db, runId: string, actor: TickActor, awaiting: AwaitingComment | null): Promise<void> {
  assertValidId(runId, "Routine run");
  await db.transaction(async (tx) => {
    await lockRun(tx as unknown as Db, runId, actor);
    await tx.update(routineRuns).set({ awaitingComment: awaiting }).where(eq(routineRuns.id, runId));
  });
}

/** The run (of the actor's own routines) waiting for a comment from them right now, if any. */
export async function findAwaitingComment(
  db: Db,
  actor: TickActor,
  now: Date,
): Promise<{ routine: Routine; run: RoutineRun; awaiting: AwaitingComment } | null> {
  const rows = await db
    .select({ routine: routines, run: routineRuns })
    .from(routineRuns)
    .innerJoin(routines, eq(routines.id, routineRuns.routineId))
    .where(
      and(
        "personId" in actor ? eq(routines.assigneePersonId, actor.personId) : eq(routines.assigneeUserId, actor.userId),
        isNotNull(routineRuns.awaitingComment),
      ),
    );
  const fresh = rows
    .map((r) => ({ ...r, awaiting: r.run.awaitingComment as AwaitingComment }))
    .filter((r) => r.awaiting?.since && now.getTime() - new Date(r.awaiting.since).getTime() <= AWAIT_COMMENT_MINUTES * 60_000)
    .sort((a, b) => b.awaiting.since.localeCompare(a.awaiting.since));
  return fresh[0] ?? null;
}

/** The person's runs still open today (the /routines command), oldest ask first. */
export async function listOpenRunsForPerson(db: Db, personId: string, now: Date): Promise<{ routine: Routine; run: RoutineRun }[]> {
  const rows = await db
    .select({ routine: routines, run: routineRuns })
    .from(routineRuns)
    .innerJoin(routines, eq(routines.id, routineRuns.routineId))
    .where(
      and(
        eq(routines.assigneePersonId, personId),
        eq(routines.status, "active"),
        inArray(routineRuns.status, [...OPEN_RUN_STATUSES]),
      ),
    )
    .orderBy(asc(routines.time));
  return rows.filter((r) => r.run.runDate === todayInTimeZone(now, r.routine.timezone));
}

/** What a routine message shows besides the run: the company name and "remind until". */
export async function routineMessageContext(db: Db, r: Routine): Promise<{ companyName: string | null; until: string }> {
  const [c] = r.companyId ? await db.select({ name: companies.name }).from(companies).where(eq(companies.id, r.companyId)) : [];
  const s = await settingsForAssignee(db, r.assigneePersonId);
  return { companyName: c?.name ?? null, until: routineChase(r, s, parseRoutineOverride(r.chase)).chaseUntil };
}

/** The message input for a run (messages-ru / messages builders). */
export async function routineMessageInput(db: Db, routine: Routine, run: RoutineRun) {
  const extra = await routineMessageContext(db, routine);
  return {
    runId: run.id,
    title: routine.title,
    description: routine.description,
    confirmation: routine.confirmation as "button" | "checklist",
    items: run.items,
    itemsDone: run.itemsDone,
    itemStates: run.itemStates,
    status: run.status,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// The founder's first routine: Elmurat — daily 1C entries for all companies (src/server/db/example-routines.ts)
// ---------------------------------------------------------------------------

/** "Use example: Elmurat 1C" on the Routines page: creates it if no routine with that key exists. */
export async function createExampleRoutine(ctx: ServiceContext): Promise<Routine> {
  assertRoutineAccess(ctx);
  const [existing] = await ctx.db.select().from(routines).where(eq(routines.seedKey, EXAMPLE_ROUTINE_KEY));
  if (existing) throw new ServiceError("conflict", "The Elmurat 1C routine already exists");
  const ex = await exampleRoutineInput(ctx.db);
  if (!ex) throw new ServiceError("validation", "Elmurat is not in People (or no company is active)");
  return createRoutine(ctx, ex, { seedKey: EXAMPLE_ROUTINE_KEY });
}

/** Can the example be offered (Elmurat exists and the routine is absent)? */
export async function exampleRoutineAvailable(ctx: ServiceContext, listed?: readonly RoutineView[]): Promise<boolean> {
  assertRoutineAccess(ctx);
  // The caller's unfiltered list already shows whether it exists.
  if (listed?.some((v) => v.routine.seedKey === EXAMPLE_ROUTINE_KEY)) return false;
  const [existing] = await ctx.db.select({ id: routines.id }).from(routines).where(eq(routines.seedKey, EXAMPLE_ROUTINE_KEY));
  return !existing && !!(await exampleRoutineInput(ctx.db));
}

/**
 * Choices for the routine form: founders, people (not app users, still here) with the companies
 * they work for (the company select is limited to those), live companies, and the defaults.
 */
export async function routineFormOptions(ctx: ServiceContext) {
  assertRoutineAccess(ctx);
  // Shared founder data (routines are founders-only): one cached entry, dropped by any write to
  // people / their links, companies, org posts or the bot's defaults.
  return sharedCache(["routines:form-options"], [CACHE_TAGS.people, CACHE_TAGS.companies, CACHE_TAGS.org, CACHE_TAGS.staffSettings], () => queryRoutineFormOptions(ctx));
}

async function queryRoutineFormOptions(ctx: ServiceContext) {
  const [founders, persons, comps, defaults] = await Promise.all([
    ctx.db.select({ id: users.id, name: users.shortName }).from(users).where(eq(users.role, "founder")).orderBy(asc(users.shortName)),
    ctx.db
      .select({ id: people.id, name: people.fullName, short: people.shortName, staffChase: people.staffChase })
      .from(people)
      .where(and(isNull(people.leftAt), isNull(people.userId)))
      .orderBy(asc(people.fullName)),
    ctx.db.select({ id: companies.id, name: companies.name }).from(companies).where(isNull(companies.archivedAt)).orderBy(asc(companies.sort), asc(companies.name)),
    loadStaffDefaults(ctx.db),
  ]);
  const links = await personCompanyIds(
    ctx.db,
    persons.map((p) => p.id),
  );
  const live = new Set(comps.map((c) => c.id));
  return {
    founders,
    people: persons.map((p) => ({
      id: p.id,
      name: p.short || p.name,
      companyIds: (links.get(p.id) ?? []).filter((id) => live.has(id)),
      /** This person's chase defaults (their override ← global). */
      defaults: effectiveRoutineChase(effectiveStaffSettings(defaults, parsePersonOverride(p.staffChase)), {}),
    })),
    companies: comps,
    defaults: effectiveRoutineChase(defaults, {}),
    founderDefaults: effectiveFounderRoutineChase(defaults, {}),
  };
}
export type RoutineFormOptionsData = Awaited<ReturnType<typeof routineFormOptions>>;

/**
 * Reassigns a routine from the list (0034, inline like a task's assignee): "user:<id>" (a founder)
 * or "person:<id>". Same checks as the form (the person must work for the routine's company);
 * messages already queued for the old assignee are cancelled.
 */
export async function setRoutineAssignee(ctx: ServiceContext, id: string, assignee: string): Promise<Routine> {
  const current = await loadRoutine(ctx, id);
  if (current.status === "archived") throw new ServiceError("validation", "Restore the routine before editing it");
  const m = /^(user|person):([0-9a-f-]{36})$/i.exec(assignee);
  if (!m) throw new ServiceError("validation", "Pick who does it", { assignee: ["Pick who does it"] });
  const personId = m[1] === "person" ? m[2]! : null;
  const userId = m[1] === "user" ? m[2]! : null;
  if (personId === current.assigneePersonId && userId === current.assigneeUserId) return current;
  await validateRefs(ctx, { companyId: current.companyId, personId, userId });
  const [row] = await ctx.db
    .update(routines)
    .set({ assigneePersonId: personId, assigneeUserId: userId, updatedAt: ctx.now })
    .where(eq(routines.id, current.id))
    .returning();
  await cancelRoutineMessages(ctx.db, current.id, "reassigned");
  return row!;
}
