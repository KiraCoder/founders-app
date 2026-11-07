/**
 * Scheduler. `planForUser` is pure: given now, preferences and the founder's task summary
 * it returns what should be queued. `planTick` gathers that state from the DB (through the
 * service layer, as each founder) and enqueues it. Dedupe keys make re-running harmless:
 * a tick every 5 minutes queues each item exactly once.
 */
import { and, eq, gt, inArray, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import {
  addDays,
  daysBetween,
  hmToMinutes,
  localMinutesOfDay,
  todayInTimeZone,
  zonedTimeToUtc,
  type IsoDate,
} from "@/lib/dates";
import {
  effectiveStaffSettings,
  parsePersonOverride,
  parseTaskOverride,
  taskChaseSettings,
  type StaffSettings,
  type StaffTaskOverride,
} from "@/lib/staff-schemas";
import type { Db } from "@/server/db/connect";
import {
  companies,
  notificationsOutbox,
  people,
  reminderSnoozes,
  taskEvents,
  tasks,
  telegramLinks,
  type NotificationPriority,
  type TaskPriority,
} from "@/server/db/schema";
import { loadStaffDefaults } from "@/server/services/staff";
import { CLOSED_STATUSES } from "@/server/services/tasks-rules";
import { notifyFounders } from "./staff-notify";
import { makeContext } from "@/server/services/context";
import { planHoldingAsks } from "@/server/services/holding-asks";
import { getTodaySummary } from "@/server/services/tasks";
import { listFounders } from "./founders";
import { planRoutinesTick, type RoutinePlanReport } from "./routine-planner";
import { taskTouchKey } from "./types";
import { enqueue, enqueueForPerson, type EnqueueInput, type PersonEnqueueInput } from "./outbox";
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

  // Chase style "summary_only": no chase pushes; the morning summary lists overdue tasks.
  // ("grouped" queues the same per-task rows; the dispatcher sends them as one push.)
  for (const t of prefs.overdueChaseStyle === "summary_only" ? [] : input.overdue) {
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

// ---------------------------------------------------------------------------
// Staff (people on Telegram). Persistent on purpose ("keep asking until done"), but every timing
// is a setting: global defaults → per person → per task (src/lib/staff-schemas.ts).
// ---------------------------------------------------------------------------

/** A new-task message is sent only for tasks assigned within this many days (no backlog flood). */
export const STAFF_NEW_TASK_MAX_AGE_DAYS = 3;

export interface StaffPlanTask {
  id: string;
  title: string;
  dueDate: IsoDate | null;
  ownerUserId: string;
  /** When it was assigned to this person (the latest assignment, else created). */
  assignedAt: Date;
  override: StaffTaskOverride;
}

export interface PersonPlanInput {
  personId: string;
  personName: string;
  now: Date;
  timeZone: string;
  settings: StaffSettings;
  /** When "bot may message" was switched on: only tasks assigned since then get a new-task message. */
  enabledAt: Date | null;
  tasks: StaffPlanTask[];
  /** Per task: chases sent for its current deadline since the person last answered on it. */
  unanswered: ReadonlyMap<string, number>;
  /** Per task: when the person last answered on it (any button or reply), if ever. */
  answeredAt?: ReadonlyMap<string, Date>;
}

export interface StaffEscalation {
  taskId: string;
  ownerUserId: string;
  title: string;
  dueDate: IsoDate;
  reason: "count" | "time";
  chases: number;
  /** The person's last answer on the task (part of the dedupe key: going quiet again escalates again). */
  answeredAt: Date | null;
}

export interface PersonPlan {
  messages: PersonEnqueueInput[];
  escalations: StaffEscalation[];
}

/** One task inside a grouped staff chase (payload.tasks of a `staff_chase` row). */
export interface StaffChaseEntry {
  id: string;
  dueDate: IsoDate;
  /** Start of this task's own chase slot (its cadence may differ from the person's). */
  slotStart: string;
}

const hmOf = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/**
 * Staff plan for one person (pure):
 * - **New task**: once (`new:<task>`), right away, for tasks assigned after the bot was switched on
 *   and within STAFF_NEW_TASK_MAX_AGE_DAYS.
 * - **Chase**: on the due day and every day after, inside working hours, per slot of
 *   `chaseEveryMinutes` counted from `workStart`. ONE grouped message per person per slot
 *   (`chase:<day>:<HH:MM slot start>`) lists every task due a chase in that slot, with buttons per
 *   task — never one message per task (a person with 8 overdue tasks gets 1 message, not 8, so the
 *   daily cap lasts all day). Tasks with their own cadence join the group of their slot start.
 *   It expires at the slot's end so missed slots never pile up. No chase in the slot in which the
 *   person was switched on (no burst on switch-on). A task stops being chased after
 *   `escalateAfterChases` chases without an answer (the founder is told; any answer resumes it).
 * - **Escalation** to the task's founder: after N unanswered chases (again after each new
 *   answer + N more unanswered chases), or (heads-up only, chasing goes on) when still open at
 *   `escalateAt` on the due day or later (once per deadline).
 * - **Morning list** of their open tasks when switched on (`list:<day>`).
 * Quiet hours, the daily cap and "one chase per task per slot" are the dispatcher's.
 */
export function planForPerson(input: PersonPlanInput): PersonPlan {
  const { personId, now, timeZone: tz, settings: s } = input;
  const today = todayInTimeZone(now, tz);
  const minutes = localMinutesOfDay(now, tz);
  const endOfDay = zonedTimeToUtc(addDays(today, 1), "00:00", tz);
  const workStart = hmToMinutes(s.workStart);
  const workEnd = hmToMinutes(s.workEnd);
  const messages: PersonEnqueueInput[] = [];
  const escalations: StaffEscalation[] = [];
  /** slot start (minutes) → tasks due a chase in it, and the latest slot end among them. */
  const groups = new Map<number, { entries: StaffChaseEntry[]; end: number }>();

  for (const t of input.tasks) {
    if (
      input.enabledAt &&
      t.assignedAt.getTime() >= input.enabledAt.getTime() &&
      now.getTime() - t.assignedAt.getTime() <= STAFF_NEW_TASK_MAX_AGE_DAYS * 86_400_000
    ) {
      messages.push({
        personId,
        kind: "staff_new_task",
        taskId: t.id,
        dedupeKey: `new:${t.id}`,
        scheduledFor: new Date(Math.min(t.assignedAt.getTime(), now.getTime())),
        expiresAt: new Date(t.assignedAt.getTime() + 7 * 86_400_000),
        priority: "normal",
      });
    }
    if (!t.dueDate || t.dueDate > today) continue;
    const c = taskChaseSettings(s, t.override);
    const sent = input.unanswered.get(t.id) ?? 0;
    const answeredAt = input.answeredAt?.get(t.id) ?? null;
    const byCount = c.escalateAfterChases > 0 && sent >= c.escalateAfterChases;
    const base = { taskId: t.id, ownerUserId: t.ownerUserId, title: t.title, dueDate: t.dueDate, chases: sent, answeredAt };
    if (byCount) escalations.push({ ...base, reason: "count" });
    if (c.escalateAt && minutes >= hmToMinutes(c.escalateAt)) escalations.push({ ...base, reason: "time" });
    if (!c.chaseEnabled || byCount || minutes < workStart || minutes >= workEnd) continue;
    const slot = Math.floor((minutes - workStart) / c.chaseEveryMinutes);
    const slotStart = workStart + slot * c.chaseEveryMinutes;
    const slotEnd = Math.min(slotStart + c.chaseEveryMinutes, workEnd);
    const slotStartAt = zonedTimeToUtc(today, hmOf(slotStart), tz);
    // Switched on during this slot: the first chase waits for the next slot.
    if (input.enabledAt && input.enabledAt.getTime() >= slotStartAt.getTime()) continue;
    const g = groups.get(slotStart) ?? { entries: [], end: slotEnd };
    g.entries.push({ id: t.id, dueDate: t.dueDate, slotStart: slotStartAt.toISOString() });
    g.end = Math.max(g.end, slotEnd);
    groups.set(slotStart, g);
  }

  for (const [slotStart, g] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    messages.push({
      personId,
      kind: "staff_chase",
      taskId: null,
      dedupeKey: `chase:${today}:${hmOf(slotStart)}`,
      scheduledFor: zonedTimeToUtc(today, hmOf(slotStart), tz),
      expiresAt: g.end >= 24 * 60 ? endOfDay : zonedTimeToUtc(today, hmOf(g.end), tz),
      priority: "normal",
      payload: { day: today, slotStart: zonedTimeToUtc(today, hmOf(slotStart), tz).toISOString(), tasks: g.entries },
    });
  }

  if (s.morningList && input.tasks.length) {
    const at = zonedTimeToUtc(today, s.morningListTime, tz);
    const until = hmToMinutes(s.morningListTime) < workEnd ? zonedTimeToUtc(today, s.workEnd, tz) : endOfDay;
    messages.push({
      personId,
      kind: "staff_morning_list",
      dedupeKey: `list:${today}`,
      scheduledFor: at,
      expiresAt: until.getTime() > at.getTime() ? until : endOfDay,
      priority: "normal",
    });
  }
  return { messages, escalations };
}

/** The tasks a sent staff chase listed (grouped rows: payload.listed; rows from before the grouping: taskId). */
export function listedInChase(row: { taskId: string | null; payload: unknown }): { id: string; dueDate: string | null }[] {
  const p = (row.payload ?? {}) as { listed?: { id: string; dueDate: string | null }[]; dueDate?: string };
  if (Array.isArray(p.listed)) return p.listed;
  return row.taskId ? [{ id: row.taskId, dueDate: p.dueDate ?? null }] : [];
}

/** Escalation dedupe key. "count" includes the last answer: after an answer, N more silent chases escalate again. */
export function escalationKey(e: StaffEscalation): string {
  if (e.reason === "time") return `esc:${e.taskId}:${e.dueDate}:time`;
  return `esc:${e.taskId}:${e.dueDate}:count:${e.answeredAt ? e.answeredAt.toISOString() : "never"}`;
}

/** Line (and push) to the task's founder when a person does not react. */
function escalationNote(e: StaffEscalation, personName: string) {
  const line =
    e.reason === "count"
      ? `${personName} hasn't confirmed "${e.title}" (${e.chases} reminders without an answer; due ${e.dueDate})`
      : `${personName} still hasn't closed "${e.title}" (due ${e.dueDate})`;
  return { line, message: { title: "Team: no answer", lines: [{ text: line }, { text: "Open the task to comment or reassign.", style: "muted" as const }] } };
}

/** Plans staff messages for every person the bot may message right now. */
export async function planStaffTick(db: Db, now: Date, timeZone: string): Promise<{ planned: number; created: number; escalated: number }> {
  const out = { planned: 0, created: 0, escalated: 0 };
  const defaults = await loadStaffDefaults(db);
  const persons = await db
    .select({ person: people, linkCreatedAt: telegramLinks.createdAt })
    .from(people)
    .innerJoin(telegramLinks, eq(telegramLinks.personId, people.id))
    .where(
      and(
        eq(people.botEnabled, true),
        isNull(people.leftAt),
        isNull(people.userId),
        isNull(telegramLinks.stoppedAt),
        or(isNull(people.botPausedUntil), lte(people.botPausedUntil, now)),
      ),
    );
  for (const { person } of persons) {
    const settings = effectiveStaffSettings(defaults, parsePersonOverride(person.staffChase));
    const open = await db
      .select({ id: tasks.id, title: tasks.title, dueDate: tasks.dueDate, ownerUserId: tasks.ownerUserId, createdAt: tasks.createdAt, staffChase: tasks.staffChase })
      .from(tasks)
      .where(
        and(
          eq(tasks.assigneePersonId, person.id),
          eq(tasks.visibility, "shared"),
          notInArray(tasks.status, [...CLOSED_STATUSES]),
          inArray(tasks.companyId, db.select({ id: companies.id }).from(companies).where(isNull(companies.archivedAt))),
        ),
      );
    if (!open.length) continue;
    const ids = open.map((t) => t.id);
    const [assigned, replies, chases] = await Promise.all([
      db
        .select({ taskId: taskEvents.taskId, at: sql<Date>`max(${taskEvents.createdAt})`.mapWith((v) => new Date(v as string)) })
        .from(taskEvents)
        .where(
          and(
            inArray(taskEvents.taskId, ids),
            eq(taskEvents.kind, "assignee_changed"),
            eq(taskEvents.field, "assigneePersonId"),
            sql`${taskEvents.newValue} = to_jsonb(${person.id}::text)`,
          ),
        )
        .groupBy(taskEvents.taskId),
      db
        .select({ taskId: taskEvents.taskId, at: sql<Date>`max(${taskEvents.createdAt})`.mapWith((v) => new Date(v as string)) })
        .from(taskEvents)
        .where(and(inArray(taskEvents.taskId, ids), eq(taskEvents.actorPersonId, person.id)))
        .groupBy(taskEvents.taskId),
      db
        .select({ taskId: notificationsOutbox.taskId, sentAt: notificationsOutbox.sentAt, payload: notificationsOutbox.payload })
        .from(notificationsOutbox)
        .where(
          and(
            eq(notificationsOutbox.personId, person.id),
            eq(notificationsOutbox.kind, "staff_chase"),
            eq(notificationsOutbox.status, "sent"),
            isNotNull(notificationsOutbox.sentAt),
          ),
        ),
    ]);
    const assignedAt = new Map(assigned.map((a) => [a.taskId!, a.at]));
    const lastReply = new Map(replies.map((r) => [r.taskId!, r.at]));
    const dueOf = new Map(open.map((t) => [t.id, t.dueDate]));
    const unanswered = new Map<string, number>();
    for (const c of chases) {
      for (const entry of listedInChase(c)) {
        if (!dueOf.has(entry.id) || entry.dueDate !== dueOf.get(entry.id)) continue;
        const reply = lastReply.get(entry.id);
        if (reply && c.sentAt!.getTime() <= reply.getTime()) continue;
        unanswered.set(entry.id, (unanswered.get(entry.id) ?? 0) + 1);
      }
    }
    const name = person.shortName || person.fullName;
    const plan = planForPerson({
      personId: person.id,
      personName: name,
      now,
      timeZone,
      settings,
      enabledAt: person.botEnabledAt,
      tasks: open.map((t) => ({
        id: t.id,
        title: t.title,
        dueDate: t.dueDate,
        ownerUserId: t.ownerUserId,
        assignedAt: assignedAt.get(t.id) ?? t.createdAt,
        override: parseTaskOverride(t.staffChase),
      })),
      unanswered,
      answeredAt: lastReply,
    });
    for (const m of plan.messages) {
      out.planned++;
      if ((await enqueueForPerson(db, m)).created) out.created++;
      else if (m.kind === "staff_chase") {
        // Same slot, planned again: a task that became due later in the slot joins the waiting message.
        await db
          .update(notificationsOutbox)
          .set({ payload: m.payload ?? {}, expiresAt: m.expiresAt ?? null })
          .where(
            and(
              eq(notificationsOutbox.personId, person.id),
              eq(notificationsOutbox.dedupeKey, m.dedupeKey),
              eq(notificationsOutbox.status, "pending"),
            ),
          );
      }
    }
    for (const e of plan.escalations) {
      const note = escalationNote(e, name);
      out.escalated += await notifyFounders(db, {
        userIds: [e.ownerUserId],
        line: note.line,
        taskId: e.taskId,
        dedupeKey: escalationKey(e),
        now,
        push: { priority: "high", message: note.message },
      });
    }
  }
  return out;
}

export interface PlanReport {
  planned: number;
  created: number;
  /** Staff on Telegram: messages queued for people and escalations to founders. */
  staff?: { planned: number; created: number; escalated: number };
  /** Routines: runs opened, messages queued, escalations, runs closed. */
  routines?: RoutinePlanReport;
  /** "Ask Elmurat" items created (one per founder per round). */
  holdingCreated?: number;
}

export interface PlanOptions {
  timeZone?: string;
  /** Only these founders (the dev tick plans for the signed-in founder only). */
  userIds?: readonly string[];
  /** Plan staff (people) messages too. Default true. */
  staff?: boolean;
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
  // Staff on Telegram (people the bot may message). A failure here must not stop the founders'.
  if (opts.staff !== false) {
    try {
      report.staff = await planStaffTick(db, now, timeZone);
    } catch (err) {
      console.error("[planner] staff planning failed", err);
    }
  }
  // Routines (staff and founders). A failure here must not stop the reminders.
  try {
    report.routines = await planRoutinesTick(db, now, { persons: opts.staff !== false, userIds: opts.userIds });
  } catch (err) {
    console.error("[planner] routines failed", err);
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
