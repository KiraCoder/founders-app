import "server-only";
import { and, count, eq, gt, gte, inArray, ne, sql } from "drizzle-orm";
import { addDays, hmToMinutes, localMinutesOfDay, todayInTimeZone, zonedTimeToUtc } from "@/lib/dates";
import { askTimesOf, isScheduledOn, isWithinDates, minutesToHm, OPEN_RUN_STATUSES, routineSlots, scheduleOf, type RunStatus } from "@/lib/routines";
import type { StaffSettings } from "@/lib/staff-schemas";
import type { Db } from "@/server/db/connect";
import {
  notificationsOutbox,
  people,
  routineRuns,
  routines,
  telegramLinks,
  users,
  type OutboxItem,
  type Routine,
  type RoutineRun,
} from "@/server/db/schema";
import {
  cancelRoutineMessages,
  openRun,
  parseRoutineOverride,
  queueRunMessage,
  reachablePersonIds,
  routineHasEnded,
  routineChase,
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
  /** Routines past their end date, marked "ended" in this pass. */
  ended?: number;
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
 * 1b. **End** routines past their "Ends on" date (status "ended", waiting messages cancelled).
 * 2. **Open** today's run of every active routine scheduled today (within its start / end dates),
 *    from the first ask time until the later of "chase until" and the last ask — for a person only
 *    while the bot may message them (a day they are not reachable at all has no run).
 * 3. **Ask / remind** (a person: only while reachable): one message per slot (`routineSlots`: an ask
 *    at each ask time, then the reminders of the routine's mode — once / every N until / N times —
 *    at most `maxPerDay`), only for the current slot (missed slots never pile up); built at send time
 *    so a later ask or a reminder shows what is still open.
 * 4. **Escalate** once per run to the founders (push, founders' rules): at `escalateAt`, or after
 *    `escalateAfterChases` reminders — to `escalateTo` when set, else both founders. A founder's
 *    routine escalates to the other founder(s) by default. An open
 *    run still escalates when its person became unreachable after the ask (/stop, paused, bot
 *    switched off): the founders are told why nobody is reminding them.
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
    const someDone = run.itemsDone.length > 0 || Object.values(run.itemStates ?? {}).some((s) => s.state === "done" || s.state === "partly");
    const status = someDone ? "partly" : "missed";
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

  // 1b. End.
  const all = (await db.select().from(routines).where(eq(routines.status, "active"))).filter((r) => inScope(r, opts));
  const active: Routine[] = [];
  for (const r of all) {
    if (!routineHasEnded(r, now)) {
      active.push(r);
      continue;
    }
    const ended = await db
      .update(routines)
      .set({ status: "ended", updatedAt: now })
      .where(and(eq(routines.id, r.id), eq(routines.status, "active")))
      .returning({ id: routines.id });
    if (ended.length) {
      report.ended = (report.ended ?? 0) + 1;
      await cancelRoutineMessages(db, r.id, "ended");
    }
  }

  // 2–4.
  if (!active.length) return report;
  const defaults = await loadStaffDefaults(db);
  const reachable = await reachablePersonIds(db, now);
  const settingsCache = new Map<string, StaffSettings>();
  for (const r of active) {
    // Unreachable person: no new run and no messages to them, but an open run still escalates.
    const unreachable = !!r.assigneePersonId && !reachable.has(r.assigneePersonId);
    const key = r.assigneePersonId ?? "founder";
    let s = settingsCache.get(key);
    if (!s) {
      s = await settingsForAssignee(db, r.assigneePersonId, defaults);
      settingsCache.set(key, s);
    }
    const chase = routineChase(r, s, parseRoutineOverride(r.chase));
    const tz = r.timezone;
    const day = todayInTimeZone(now, tz);
    const minutes = localMinutesOfDay(now, tz);
    const { askAt, openUntilAt } = routineTimes(r, chase, day);
    let [run] = await db.select().from(routineRuns).where(and(eq(routineRuns.routineId, r.id), eq(routineRuns.runDate, day)));
    if (!run && !unreachable && isScheduledOn(scheduleOf(r), day) && isWithinDates(r, day) && now >= askAt && now < openUntilAt) {
      const opened = await openRun(db, r, day, now);
      run = opened.run;
      if (opened.created) report.opened++;
    }
    if (!run || !OPEN_RUN_STATUSES.includes(run.status as RunStatus)) continue;

    const slots = routineSlots(askTimesOf(r), chase);
    const current = [...slots].reverse().find((sl) => sl.start <= minutes);
    if (current && current.end > minutes && !unreachable) {
      const res = await queueRunMessage(db, r, run, {
        slot: current.slot,
        scheduledFor: zonedTimeToUtc(day, minutesToHm(current.start), tz),
        expiresAt: current.end >= 24 * 60 ? zonedTimeToUtc(addDays(day, 1), "00:00", tz) : zonedTimeToUtc(day, minutesToHm(current.end), tz),
        reminder: current.reminder,
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
          report.escalated += await escalate(db, r, esc, now, unreachable);
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

/** Why the bot cannot message this person now (founder-facing, English). */
async function unreachableReason(db: Db, personId: string, now: Date): Promise<string> {
  const [p] = await db.select({ botEnabled: people.botEnabled, leftAt: people.leftAt }).from(people).where(eq(people.id, personId));
  const [link] = await db.select({ stoppedAt: telegramLinks.stoppedAt }).from(telegramLinks).where(eq(telegramLinks.personId, personId));
  const [paused] = await db.select({ id: people.id }).from(people).where(and(eq(people.id, personId), gt(people.botPausedUntil, now)));
  if (p?.leftAt) return "no longer works here";
  if (link?.stoppedAt) return "stopped the bot (/stop), so no more reminders";
  if (!link) return "not linked to the bot any more, so no more reminders";
  if (p && !p.botEnabled) return "the bot is switched off for them, so no more reminders";
  if (paused) return "paused the bot, so no more reminders";
  return "not reachable on Telegram, so no more reminders";
}

async function escalate(db: Db, r: Routine, run: RoutineRun, now: Date, unreachable = false): Promise<number> {
  const name = await assigneeLabel(db, r);
  const missing = remainingItems(run).map((i) => i.label);
  const chase = routineChase(r, await settingsForAssignee(db, r.assigneePersonId), parseRoutineOverride(r.chase));
  const why = unreachable && r.assigneePersonId ? ` — ${await unreachableReason(db, r.assigneePersonId, now)}` : "";
  const line = `${name} hasn't finished "${r.title}" today${missing.length ? ` — missing: ${missing.join(", ")}` : ""}${run.chaseCount ? ` (${run.chaseCount} reminder${run.chaseCount === 1 ? "" : "s"})` : ""}${why}`;
  // The founders picked on the routine; else: a founder's own routine goes to the other founder(s), a person's to both.
  const founderIds = (await listFounders(db)).map((f) => f.id);
  const picked = chase.escalateTo.filter((id) => founderIds.includes(id));
  const userIds = picked.length ? picked : r.assigneeUserId ? founderIds.filter((id) => id !== r.assigneeUserId) : null;
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
  opts: { checkSlot?: boolean } = {},
): Promise<{ routine: Routine; run: RoutineRun; reminder: boolean; updated: boolean } | { skip: string }> {
  const p = (item.payload ?? {}) as { runId?: string; reminder?: boolean; updated?: boolean };
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
  // A parked line in a summary (checkSlot: false) only needs the run to be open.
  if (opts.checkSlot === false) return { routine: row.routine, run: row.run, reminder: !!p.reminder, updated: !!p.updated };
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
  return { routine: row.routine, run: row.run, reminder: !!p.reminder, updated: !!p.updated };
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
