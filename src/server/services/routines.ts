import "server-only";
import { and, asc, desc, eq, inArray, isNull, like, lte, or, sql } from "drizzle-orm";
import { addDays, todayInTimeZone, zonedTimeToUtc, type IsoDate } from "@/lib/dates";
import {
  describeSchedule,
  effectiveRoutineChase,
  OPEN_RUN_STATUSES,
  routineChaseOverrideSchema,
  routineInputSchema,
  runOutcome,
  scheduleOf,
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
  people,
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
import { loadStaffDefaults } from "./staff";

/**
 * Routines: recurring jobs assigned to a person (staff, through the Telegram bot, in Russian) or a
 * founder (their normal channel and rules). Founders manage them here (full CRUD; archive keeps the
 * history, delete only while a routine has no runs). The planner (notifications/routine-planner.ts)
 * opens a run on each scheduled day, asks, chases per the routine's / person's / global settings,
 * escalates to the founders and closes runs that were not finished as partly / missed.
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

/** The staff settings that apply to the assignee: global defaults ← the person's override (founders: the global defaults). */
export async function settingsForAssignee(db: Db, personId: string | null, defaults?: StaffSettings): Promise<StaffSettings> {
  const d = defaults ?? (await loadStaffDefaults(db));
  if (!personId) return d;
  const [p] = await db.select({ staffChase: people.staffChase }).from(people).where(eq(people.id, personId));
  return effectiveStaffSettings(d, parsePersonOverride(p?.staffChase));
}

export function routineTimes(r: Pick<Routine, "time" | "timezone">, chase: RoutineChase, day: IsoDate) {
  return { askAt: zonedTimeToUtc(day, r.time, r.timezone), untilAt: zonedTimeToUtc(day, chase.chaseUntil, r.timezone) };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface RoutineView {
  routine: Routine;
  assigneeKind: "person" | "founder";
  assigneeName: string;
  companyName: string | null;
  companySlug: string | null;
  schedule: RoutineSchedule;
  scheduleText: string;
  override: RoutineChaseOverride;
  /** The settings in force (routine ← person ← global). */
  chase: RoutineChase;
  /** The defaults the routine falls back to (person ← global), shown next to the form fields. */
  defaults: RoutineChase;
  today: RoutineRun | null;
  /** Staff: the bot may message them now (linked, switched on, not paused / stopped). Founders: true. */
  reachable: boolean;
}

export interface RoutineFilter {
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

export async function listRoutines(ctx: ServiceContext, filter: RoutineFilter = {}): Promise<RoutineView[]> {
  assertRoutineAccess(ctx);
  const status = filter.status ?? "all";
  const where = and(
    filter.companyId ? eq(routines.companyId, filter.companyId) : undefined,
    filter.personId ? eq(routines.assigneePersonId, filter.personId) : undefined,
    filter.userId ? eq(routines.assigneeUserId, filter.userId) : undefined,
    status === "all" ? undefined : eq(routines.status, status),
  );
  const rows = await ctx.db
    .select({
      r: routines,
      pFull: people.fullName,
      pShort: people.shortName,
      uShort: users.shortName,
      companyName: companies.name,
      companySlug: companies.slug,
    })
    .from(routines)
    .leftJoin(people, eq(people.id, routines.assigneePersonId))
    .leftJoin(users, eq(users.id, routines.assigneeUserId))
    .leftJoin(companies, eq(companies.id, routines.companyId))
    .where(where)
    .orderBy(sql`case ${routines.status} when 'active' then 0 when 'paused' then 1 else 2 end`, asc(routines.title));
  if (!rows.length) return [];
  const defaults = await loadStaffDefaults(ctx.db);
  const personIds = [...new Set(rows.map((r) => r.r.assigneePersonId).filter((x): x is string => !!x))];
  const [reachable, overrides, todays] = await Promise.all([
    reachablePersonIds(ctx.db, ctx.now, personIds),
    personIds.length ? ctx.db.select({ id: people.id, c: people.staffChase }).from(people).where(inArray(people.id, personIds)) : [],
    ctx.db
      .select()
      .from(routineRuns)
      .where(
        and(
          inArray(
            routineRuns.routineId,
            rows.map((r) => r.r.id),
          ),
          eq(routineRuns.runDate, todayInTimeZone(ctx.now, ctx.timeZone)),
        ),
      ),
  ]);
  const personOverride = new Map(overrides.map((o) => [o.id, parsePersonOverride(o.c)]));
  const todayBy = new Map(todays.map((t) => [t.routineId, t]));
  return rows.map((row) => {
    const r = row.r;
    const s = r.assigneePersonId ? effectiveStaffSettings(defaults, personOverride.get(r.assigneePersonId) ?? {}) : defaults;
    const override = parseRoutineOverride(r.chase);
    const schedule = scheduleOf(r);
    return {
      routine: r,
      assigneeKind: r.assigneePersonId ? "person" : "founder",
      assigneeName: assigneeName(row),
      companyName: row.companyName,
      companySlug: row.companySlug,
      schedule,
      scheduleText: describeSchedule(schedule),
      override,
      chase: effectiveRoutineChase(s, override),
      defaults: effectiveRoutineChase(s, {}),
      today: todayBy.get(r.id) ?? null,
      reachable: r.assigneePersonId ? reachable.has(r.assigneePersonId) : true,
    };
  });
}

async function loadRoutine(ctx: ServiceContext, id: string): Promise<Routine> {
  assertRoutineAccess(ctx);
  assertValidId(id, "Routine");
  const [r] = await ctx.db.select().from(routines).where(eq(routines.id, id));
  if (!r) throw new ServiceError("not_found", "Routine not found");
  return r;
}

export async function getRoutine(ctx: ServiceContext, id: string): Promise<RoutineView> {
  const r = await loadRoutine(ctx, id);
  const [view] = (await listRoutines(ctx, { status: "all" })).filter((v) => v.routine.id === r.id);
  return view!;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

async function validateRefs(ctx: ServiceContext, v: { companyId: string | null; personId: string | null; userId: string | null }) {
  if (v.companyId) {
    const [c] = await ctx.db.select({ id: companies.id }).from(companies).where(and(eq(companies.id, v.companyId), isNull(companies.archivedAt)));
    if (!c) throw new ServiceError("validation", "Unknown company", { companyId: ["Unknown company"] });
  }
  if (v.personId) {
    const [p] = await ctx.db.select().from(people).where(eq(people.id, v.personId));
    if (!p || p.leftAt) throw new ServiceError("validation", "Pick someone who still works here", { assignee: ["Unknown person"] });
    if (p.userId) throw new ServiceError("validation", "Pick the founder from the Founders group", { assignee: ["Founders are assigned as founders"] });
  }
  if (v.userId) {
    const [u] = await ctx.db.select({ role: users.role }).from(users).where(eq(users.id, v.userId));
    if (!u || u.role !== "founder") throw new ServiceError("validation", "Unknown founder", { assignee: ["Unknown founder"] });
  }
}

export async function createRoutine(ctx: ServiceContext, input: unknown, opts: { seedKey?: string } = {}): Promise<Routine> {
  assertRoutineAccess(ctx);
  const p = routineInputSchema.parse(input);
  await validateRefs(ctx, { companyId: p.companyId, ...p.assignee });
  const [row] = await ctx.db
    .insert(routines)
    .values({ ...routineColumns(p), status: "active", createdByUserId: ctx.user.id, seedKey: opts.seedKey ?? null, createdAt: ctx.now, updatedAt: ctx.now })
    .returning();
  return row!;
}

/** Edits a routine. Today's open run keeps its checklist (items ticked stay ticked); the change applies from the next run. */
export async function updateRoutine(ctx: ServiceContext, id: string, input: unknown): Promise<Routine> {
  const current = await loadRoutine(ctx, id);
  if (current.status === "archived") throw new ServiceError("validation", "Restore the routine before editing it");
  const p = routineInputSchema.parse(input);
  await validateRefs(ctx, { companyId: p.companyId, ...p.assignee });
  const assigneeChanged = current.assigneePersonId !== p.assignee.personId || current.assigneeUserId !== p.assignee.userId;
  const [row] = await ctx.db
    .update(routines)
    .set({ ...routineColumns(p, current.items), updatedAt: ctx.now })
    .where(eq(routines.id, current.id))
    .returning();
  // Messages already queued for the old assignee make no sense any more.
  if (assigneeChanged) await cancelRoutineMessages(ctx.db, current.id, "reassigned");
  return row!;
}

/** Pause / resume / archive / restore. Pausing or archiving cancels waiting messages; today's open run is closed when the day ends. */
export async function setRoutineStatus(ctx: ServiceContext, id: string, status: RoutineStatus): Promise<Routine> {
  const current = await loadRoutine(ctx, id);
  if (!["active", "paused", "archived"].includes(status)) throw new ServiceError("validation", "Unknown status");
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
// Runs
// ---------------------------------------------------------------------------

export interface RunView {
  run: RoutineRun;
  outcome: ReturnType<typeof runOutcome>;
  /** Checklist labels not ticked. */
  missing: string[];
}

export async function listRoutineRuns(ctx: ServiceContext, id: string, limit = 60): Promise<RunView[]> {
  const r = await loadRoutine(ctx, id);
  const rows = await ctx.db
    .select()
    .from(routineRuns)
    .where(eq(routineRuns.routineId, r.id))
    .orderBy(desc(routineRuns.runDate))
    .limit(Math.min(Math.max(limit, 1), 366));
  const s = await settingsForAssignee(ctx.db, r.assigneePersonId);
  const chase = effectiveRoutineChase(s, parseRoutineOverride(r.chase));
  return rows.map((run) => {
    const done = new Set(run.itemsDone);
    return {
      run,
      outcome: runOutcome(run as { status: RunStatus; doneAt: Date | null; escalatedAt: Date | null }, routineTimes(r, chase, run.runDate).untilAt),
      missing: run.status === "done" ? [] : run.items.filter((i) => !done.has(i.key)).map((i) => i.label),
    };
  });
}

/** Today's run (created if needed, opened now): the row and whether it was created. */
export async function openRun(db: Db, r: Routine, day: IsoDate, now: Date): Promise<{ run: RoutineRun; created: boolean }> {
  const inserted = await db
    .insert(routineRuns)
    .values({ routineId: r.id, runDate: day, status: "open", items: r.confirmation === "checklist" ? r.items : [], itemsDone: [], startedAt: now })
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
  m: { slot: number | string; scheduledFor: Date; expiresAt: Date | null; reminder: boolean },
) {
  const base = {
    dedupeKey: `routine:${run.id}:${m.slot}`,
    scheduledFor: m.scheduledFor,
    expiresAt: m.expiresAt,
    priority: "normal" as const,
    payload: { runId: run.id, routineId: r.id, slot: m.slot, reminder: m.reminder },
  };
  if (r.assigneePersonId) return enqueueForPerson(db, { ...base, personId: r.assigneePersonId, kind: "staff_routine" });
  return enqueue(db, { ...base, userId: r.assigneeUserId!, kind: "routine_reminder" });
}

/**
 * "Run now": opens today's run (even on a day that is not scheduled) and asks right away. On a run
 * that is still open it asks again now; a closed run is refused.
 */
export async function runRoutineNow(ctx: ServiceContext, id: string): Promise<RoutineRun> {
  const r = await loadRoutine(ctx, id);
  if (r.status !== "active") throw new ServiceError("validation", "Resume the routine first");
  const day = todayInTimeZone(ctx.now, r.timezone);
  const { run } = await openRun(ctx.db, r, day, ctx.now);
  if (!OPEN_RUN_STATUSES.includes(run.status as RunStatus)) throw new ServiceError("conflict", "Today's run is already closed");
  await queueRunMessage(ctx.db, r, run, {
    slot: `now${ctx.now.getTime()}`,
    scheduledFor: ctx.now,
    expiresAt: zonedTimeToUtc(addDays(day, 1), "00:00", r.timezone),
    reminder: false,
  });
  return run;
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

export type TickActor = { personId: string } | { userId: string };

export interface TickResult {
  status: "ticked" | "done" | "already" | "closed";
  /** The ticked item's label (routine_tick). */
  label: string | null;
  remaining: { key: string; label: string }[];
  routine: Routine;
  run: RoutineRun;
}

/**
 * The assignee ticks one checklist item (`item`) or the whole run (`item` = null: "Готово" /
 * "✓ Всё сделано"). Only the routine's assignee (a person through the bot, or the founder it is
 * assigned to); anyone else gets not_found. All items ticked → the run is done, waiting messages are
 * cancelled and (staff) the founders get one summary line. Row-locked, so two taps at once are safe.
 */
export async function tickRoutineRun(db: Db, runId: string, actor: TickActor, item: string | null, now: Date): Promise<TickResult> {
  assertValidId(runId, "Routine run");
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ run: routineRuns, routine: routines })
      .from(routineRuns)
      .innerJoin(routines, eq(routines.id, routineRuns.routineId))
      .where(eq(routineRuns.id, runId))
      .for("update", { of: routineRuns });
    const mine =
      row && ("personId" in actor ? row.routine.assigneePersonId === actor.personId : row.routine.assigneeUserId === actor.userId);
    if (!row || !mine || row.routine.status === "archived") throw new ServiceError("not_found", "Routine not found");
    const { run, routine } = row;
    const done = new Set(run.itemsDone);
    const left = () => run.items.filter((i) => !done.has(i.key));
    if (!OPEN_RUN_STATUSES.includes(run.status as RunStatus)) {
      return { status: run.status === "done" ? ("already" as const) : ("closed" as const), label: null, remaining: left(), routine, run };
    }
    let label: string | null = null;
    if (item !== null) {
      const it = run.items.find((i) => i.key === item);
      if (!it) throw new ServiceError("not_found", "Item not found");
      label = it.label;
      if (done.has(item)) return { status: "already" as const, label, remaining: left(), routine, run };
      done.add(item);
    } else {
      for (const i of run.items) done.add(i.key);
    }
    const all = left().length === 0;
    const [updated] = await tx
      .update(routineRuns)
      .set({ itemsDone: [...done], ...(all ? { status: "done", doneAt: now, closedAt: now } : {}) })
      .where(eq(routineRuns.id, run.id))
      .returning();
    return { status: all ? ("done" as const) : ("ticked" as const), label, remaining: left(), routine, run: updated! };
  });
  if (result.status === "done") {
    await cancelRoutineMessages(db, result.routine.id, "done", result.run.id);
    if (result.routine.assigneePersonId) {
      const [p] = await db.select({ full: people.fullName, short: people.shortName }).from(people).where(eq(people.id, result.routine.assigneePersonId));
      await notifyFounders(db, {
        userIds: null,
        line: `${p?.short || p?.full || "Someone"} finished the routine "${result.routine.title}" (Telegram)`,
        dedupeKey: `routine-done:${result.run.id}`,
        now,
      });
    }
  }
  return result;
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
export async function exampleRoutineAvailable(ctx: ServiceContext): Promise<boolean> {
  assertRoutineAccess(ctx);
  const [existing] = await ctx.db.select({ id: routines.id }).from(routines).where(eq(routines.seedKey, EXAMPLE_ROUTINE_KEY));
  return !existing && !!(await exampleRoutineInput(ctx.db));
}

/** Choices for the routine form: founders, people (not app users, still here), live companies. */
export async function routineFormOptions(ctx: ServiceContext) {
  assertRoutineAccess(ctx);
  const [founders, persons, comps, defaults] = await Promise.all([
    ctx.db.select({ id: users.id, name: users.shortName }).from(users).where(eq(users.role, "founder")).orderBy(asc(users.shortName)),
    ctx.db
      .select({ id: people.id, name: people.fullName, short: people.shortName })
      .from(people)
      .where(and(isNull(people.leftAt), isNull(people.userId)))
      .orderBy(asc(people.fullName)),
    ctx.db.select({ id: companies.id, name: companies.name }).from(companies).where(isNull(companies.archivedAt)).orderBy(asc(companies.sort), asc(companies.name)),
    loadStaffDefaults(ctx.db),
  ]);
  return {
    founders,
    people: persons.map((p) => ({ id: p.id, name: p.short || p.name })),
    companies: comps,
    defaults: effectiveRoutineChase(defaults, {}),
  };
}
