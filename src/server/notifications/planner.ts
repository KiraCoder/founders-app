/**
 * Scheduler. `planForUser` is pure: given now, preferences and the founder's task summary
 * it returns what should be queued. `planTick` gathers that state from the DB (through the
 * service layer, as each founder) and enqueues it. Dedupe keys make re-running harmless:
 * a tick every 5 minutes queues each item exactly once.
 */
import { and, eq, gt } from "drizzle-orm";
import { addDays, daysBetween, todayInTimeZone, zonedTimeToUtc, type IsoDate } from "@/lib/dates";
import type { Db } from "@/server/db/connect";
import { reminderSnoozes, type NotificationPriority, type TaskPriority } from "@/server/db/schema";
import { makeContext } from "@/server/services/context";
import { planHoldingAsks } from "@/server/services/holding-asks";
import { getTodaySummary } from "@/server/services/tasks";
import { listFounders } from "./founders";
import { taskTouchKey } from "./types";
import { enqueue, type EnqueueInput } from "./outbox";
import { loadPreferences, type Preferences } from "./preferences";

/** Local time of the overdue chase and the due-today nudge. */
export const CHASE_TIME = "10:00";
export const DUE_TODAY_TIME = "12:00";
/** A morning summary that could not go out within this window is dropped (stale). */
export const MORNING_SUMMARY_VALID_HOURS = 6;

export interface PlanTask {
  id: string;
  title: string;
  dueDate: IsoDate | null;
  priority: TaskPriority;
  company: { name: string } | null;
  visibility: "private" | "shared";
}

export interface PlanInput {
  userId: string;
  now: Date;
  timeZone: string;
  prefs: Preferences;
  overdue: PlanTask[];
  dueToday: PlanTask[];
  /** Tasks with an active "Snooze 1 day". */
  snoozedTaskIds: ReadonlySet<string>;
}

/** Overdue chase cadence: day 1, 3, 7, then every 7 days (14, 21, …). */
export function isChaseDay(daysOverdue: number): boolean {
  if (daysOverdue < 1) return false;
  if (daysOverdue === 1 || daysOverdue === 3 || daysOverdue === 7) return true;
  return daysOverdue > 7 && daysOverdue % 7 === 0;
}

function priorityFor(task: PlanTask): NotificationPriority {
  return task.priority === "urgent" ? "urgent" : task.priority === "high" ? "high" : "normal";
}

export function planForUser(input: PlanInput): EnqueueInput[] {
  const { userId, now, timeZone: tz, prefs } = input;
  const today = todayInTimeZone(now, tz);
  const endOfDay = zonedTimeToUtc(addDays(today, 1), "00:00", tz);
  const out: EnqueueInput[] = [];

  const morningAt = zonedTimeToUtc(today, prefs.morningSummaryTime, tz);
  out.push({
    userId,
    kind: "morning_summary",
    dedupeKey: `morning:${today}`,
    scheduledFor: morningAt,
    expiresAt: new Date(Math.min(endOfDay.getTime(), morningAt.getTime() + MORNING_SUMMARY_VALID_HOURS * 3_600_000)),
    priority: "normal",
  });

  if (prefs.eveningCheckEnabled) {
    out.push({
      userId,
      kind: "evening_check",
      dedupeKey: `evening:${today}`,
      scheduledFor: zonedTimeToUtc(today, prefs.eveningCheckTime, tz),
      expiresAt: endOfDay,
      priority: "normal",
    });
  }

  for (const t of input.dueToday) {
    if (input.snoozedTaskIds.has(t.id)) continue;
    out.push({
      userId,
      kind: "task_due_today",
      taskId: t.id,
      dedupeKey: taskTouchKey(t.id, today),
      scheduledFor: zonedTimeToUtc(today, DUE_TODAY_TIME, tz),
      expiresAt: endOfDay,
      priority: priorityFor(t),
    });
  }

  for (const t of input.overdue) {
    if (!t.dueDate || input.snoozedTaskIds.has(t.id)) continue;
    const days = daysBetween(t.dueDate, today);
    if (!isChaseDay(days)) continue;
    out.push({
      userId,
      kind: "overdue_chase",
      taskId: t.id,
      // Shared with the due-today nudge and the snooze reminder: one push per task per day.
      dedupeKey: taskTouchKey(t.id, today),
      scheduledFor: zonedTimeToUtc(today, CHASE_TIME, tz),
      expiresAt: endOfDay,
      priority: priorityFor(t),
      payload: { daysOverdue: days },
    });
  }
  return out;
}

export interface PlanReport {
  planned: number;
  created: number;
  /** "Ask Elmurat" items created (one per founder per round). */
  holdingCreated?: number;
}

export interface PlanOptions {
  timeZone?: string;
  /** Only these founders (the dev tick plans for the signed-in founder only). */
  userIds?: readonly string[];
}

/** Plans and enqueues for every founder (or the given ones). */
export async function planTick(db: Db, now: Date, opts: PlanOptions = {}): Promise<PlanReport> {
  const timeZone = opts.timeZone ?? (process.env.APP_TIMEZONE || "Asia/Bishkek");
  const report: PlanReport = { planned: 0, created: 0 };
  for (const user of await listFounders(db)) {
    if (opts.userIds && !opts.userIds.includes(user.id)) continue;
    const ctx = { ...makeContext(db, user, now), timeZone };
    const [prefs, summary, snoozes] = await Promise.all([
      loadPreferences(db, user.id),
      getTodaySummary(ctx),
      db
        .select({ taskId: reminderSnoozes.taskId })
        .from(reminderSnoozes)
        .where(and(eq(reminderSnoozes.userId, user.id), gt(reminderSnoozes.snoozedUntil, now))),
    ]);
    const items = planForUser({
      userId: user.id,
      now,
      timeZone,
      prefs,
      overdue: summary.overdue,
      dueToday: summary.dueToday,
      snoozedTaskIds: new Set(snoozes.map((s) => s.taskId)),
    });
    for (const item of items) {
      report.planned++;
      if ((await enqueue(db, item)).created) report.created++;
    }
  }
  // Holding: the monthly "ask Elmurat" item and the weekly reminder (shown inside the
  // morning summary, never as a separate push). A failure here must not stop the reminders.
  try {
    report.holdingCreated = (await planHoldingAsks(db, now, timeZone, { userIds: opts.userIds })).created;
  } catch (err) {
    console.error("[planner] holding asks failed", err);
  }
  return report;
}
