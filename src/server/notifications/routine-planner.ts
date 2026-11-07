import "server-only";
import { and, count, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { addDays, hmToMinutes, localMinutesOfDay, todayInTimeZone, zonedTimeToUtc } from "@/lib/dates";
import { effectiveRoutineChase, isScheduledOn, minutesToHm, OPEN_RUN_STATUSES, routineSlots, scheduleOf, type RunStatus } from "@/lib/routines";
import type { StaffSettings } from "@/lib/staff-schemas";
import type { Db } from "@/server/db/connect";
import { notificationsOutbox, people, routineRuns, routines, users, type OutboxItem, type Routine, type RoutineRun } from "@/server/db/schema";
import {
  cancelRoutineMessages,
  openRun,
  parseRoutineOverride,
  queueRunMessage,
  reachablePersonIds,
  routineTimes,
  settingsForAssignee,
} from "@/server/services/routines";
import { loadStaffDefaults } from "@/server/services/staff";
import { listFounders } from "./founders";
import { remainingItems } from "./messages-ru";
import { notifyFounders } from "./staff-notify";

export interface RoutinePlanReport {
  opened: number;
  queued: number;
  escalated: number;
  closed: number;
}

export interface RoutinePlanOptions {
  /** Staff (person) routines. Default true. */
  persons?: boolean;
  /** Founder routines. Default true. */
  founders?: boolean;
  /** Only the founder routines of these founders (the founders' dev tick). */
  userIds?: readonly string[];
}

function inScope(r: Routine, opts: RoutinePlanOptions): boolean {
  if (r.assigneePersonId) return opts.persons !== false;
  if (opts.founders === false) return false;
  return !opts.userIds || opts.userIds.includes(r.assigneeUserId!);
}

/**
 * One planner pass over routines (idempotent; a tick every 5–15 minutes):
 * 1. **Close** runs of earlier days that were not finished: `partly` (some items ticked) or
 *    `missed`; waiting messages are cancelled. The next scheduled run still happens.
 * 2. **Open** today's run of every active routine scheduled today, from the ask time until the
 *    "chase until" time — for a person only while the bot may message them.
 * 3. **Ask / remind**: one message per slot (slot 0 = the ask at the routine's time, then every
 *    `chaseEveryMinutes` until `chaseUntil`, at most `maxPerDay`), only for the current slot (missed
 *    slots never pile up); built at send time so a checklist re-asks ONLY the unticked items.
 * 4. **Escalate** once per run to the founders (push, founders' rules): at `escalateAt`, or after
 *    `escalateAfterChases` reminders. A founder's routine escalates to the other founder(s).
 */
export async function planRoutinesTick(db: Db, now: Date, opts: RoutinePlanOptions = {}): Promise<RoutinePlanReport> {
  const report: RoutinePlanReport = { opened: 0, queued: 0, escalated: 0, closed: 0 };

  // 1. Close.
  const stale = await db
    .select({ run: routineRuns, routine: routines })
    .from(routineRuns)
    .innerJoin(routines, eq(routines.id, routineRuns.routineId))
    .where(inArray(routineRuns.status, [...OPEN_RUN_STATUSES]));
  for (const { run, routine } of stale) {
    if (!inScope(routine, opts)) continue;
    if (run.runDate >= todayInTimeZone(now, routine.timezone)) continue;
    const status = run.itemsDone.length > 0 ? "partly" : "missed";
    const closed = await db
      .update(routineRuns)
      .set({ status, closedAt: now })
      .where(and(eq(routineRuns.id, run.id), inArray(routineRuns.status, [...OPEN_RUN_STATUSES])))
      .returning({ id: routineRuns.id });
    if (closed.length) {
      report.closed++;
      await cancelRoutineMessages(db, routine.id, status, run.id);
    }
  }

  // 2–4.
  const active = (await db.select().from(routines).where(eq(routines.status, "active"))).filter((r) => inScope(r, opts));
  if (!active.length) return report;
  const defaults = await loadStaffDefaults(db);
  const reachable = await reachablePersonIds(db, now);
  const settingsCache = new Map<string, StaffSettings>();
  for (const r of active) {
    if (r.assigneePersonId && !reachable.has(r.assigneePersonId)) continue;
    const key = r.assigneePersonId ?? "founder";
    let s = settingsCache.get(key);
    if (!s) {
      s = await settingsForAssignee(db, r.assigneePersonId, defaults);
      settingsCache.set(key, s);
    }
    const chase = effectiveRoutineChase(s, parseRoutineOverride(r.chase));
    const tz = r.timezone;
    const day = todayInTimeZone(now, tz);
    const minutes = localMinutesOfDay(now, tz);
    const { askAt, untilAt } = routineTimes(r, chase, day);
    let [run] = await db.select().from(routineRuns).where(and(eq(routineRuns.routineId, r.id), eq(routineRuns.runDate, day)));
    if (!run && isScheduledOn(scheduleOf(r), day) && now >= askAt && now < untilAt) {
      const opened = await openRun(db, r, day, now);
      run = opened.run;
      if (opened.created) report.opened++;
    }
    if (!run || !OPEN_RUN_STATUSES.includes(run.status as RunStatus)) continue;

    const slots = routineSlots(r.time, chase);
    const current = [...slots].reverse().find((sl) => sl.start <= minutes);
    if (current) {
      const res = await queueRunMessage(db, r, run, {
        slot: current.slot,
        scheduledFor: zonedTimeToUtc(day, minutesToHm(current.start), tz),
        expiresAt: current.end >= 24 * 60 ? zonedTimeToUtc(addDays(day, 1), "00:00", tz) : zonedTimeToUtc(day, minutesToHm(current.end), tz),
        reminder: current.slot > 0,
      });
      if (res.created) report.queued++;
    }

    if (run.status === "open") {
      const byTime = !!chase.escalateAt && minutes >= hmToMinutes(chase.escalateAt) && run.startedAt < zonedTimeToUtc(day, chase.escalateAt, tz);
      const byCount = chase.escalateAfterChases > 0 && run.chaseCount >= chase.escalateAfterChases;
      if (byTime || byCount) {
        const [esc] = await db
          .update(routineRuns)
          .set({ status: "escalated", escalatedAt: now })
          .where(and(eq(routineRuns.id, run.id), eq(routineRuns.status, "open")))
          .returning();
        if (esc) {
          report.escalated += await escalate(db, r, esc, now);
        }
      }
    }
  }
  return report;
}

async function assigneeLabel(db: Db, r: Routine): Promise<string> {
  if (r.assigneePersonId) {
    const [p] = await db.select({ full: people.fullName, short: people.shortName }).from(people).where(eq(people.id, r.assigneePersonId));
    return p?.short || p?.full || "Someone";
  }
  const [u] = await db.select({ short: users.shortName }).from(users).where(eq(users.id, r.assigneeUserId!));
  return u?.short ?? "A founder";
}

async function escalate(db: Db, r: Routine, run: RoutineRun, now: Date): Promise<number> {
  const name = await assigneeLabel(db, r);
  const missing = remainingItems(run).map((i) => i.label);
  const line = `${name} hasn't finished "${r.title}" today${missing.length ? ` — missing: ${missing.join(", ")}` : ""}${run.chaseCount ? ` (${run.chaseCount} reminder${run.chaseCount === 1 ? "" : "s"})` : ""}`;
  // A founder's own routine goes to the other founder(s); a person's to both founders.
  const userIds = r.assigneeUserId ? (await listFounders(db)).map((f) => f.id).filter((id) => id !== r.assigneeUserId) : null;
  if (userIds && !userIds.length) return 0;
  return notifyFounders(db, {
    userIds,
    line,
    dedupeKey: `routine-esc:${run.id}`,
    now,
    push: { priority: "high", message: { title: "Routine not done", lines: [{ text: line }, { text: "Open Routines in the app for the history.", style: "muted" }] } },
  });
}

/**
 * At send time: the routine and run a routine message is about, or why it no longer makes sense
 * (run closed / done, routine paused or archived, reassigned, already asked in this slot).
 */
export async function loadRoutineForMessage(
  db: Db,
  item: OutboxItem,
  assignee: { personId: string } | { userId: string },
): Promise<{ routine: Routine; run: RoutineRun; reminder: boolean } | { skip: string }> {
  const p = (item.payload ?? {}) as { runId?: string; reminder?: boolean };
  if (!p.runId) return { skip: "no_run" };
  const [row] = await db
    .select({ run: routineRuns, routine: routines })
    .from(routineRuns)
    .innerJoin(routines, eq(routines.id, routineRuns.routineId))
    .where(eq(routineRuns.id, p.runId));
  if (!row) return { skip: "routine_gone" };
  const mine = "personId" in assignee ? row.routine.assigneePersonId === assignee.personId : row.routine.assigneeUserId === assignee.userId;
  if (!mine) return { skip: "reassigned" };
  if (row.routine.status !== "active") return { skip: `routine_${row.routine.status}` };
  if (!OPEN_RUN_STATUSES.includes(row.run.status as RunStatus)) return { skip: row.run.status === "done" ? "routine_done" : "run_closed" };
  // One message per run per slot: a "Run now" ask in this slot already covers the scheduled one.
  const since = item.scheduledFor;
  const [dup] = await db
    .select({ n: count() })
    .from(notificationsOutbox)
    .where(
      and(
        ne(notificationsOutbox.id, item.id),
        sql`(${notificationsOutbox.payload} ->> 'runId') = ${p.runId}`,
        eq(notificationsOutbox.status, "sent"),
        gte(notificationsOutbox.sentAt, since),
      ),
    );
  if ((dup?.n ?? 0) > 0) return { skip: "already_asked_this_slot" };
  return { routine: row.routine, run: row.run, reminder: !!p.reminder };
}

/** After a routine message went out: a reminder counts towards "escalate after N reminders". */
export async function markRoutineMessageSent(db: Db, item: OutboxItem, now: Date): Promise<void> {
  const p = (item.payload ?? {}) as { runId?: string; reminder?: boolean };
  if (!p.runId) return;
  await db
    .update(routineRuns)
    .set({ lastChasedAt: now, ...(p.reminder ? { chaseCount: sql`${routineRuns.chaseCount} + 1` } : {}) })
    .where(eq(routineRuns.id, p.runId));
}
