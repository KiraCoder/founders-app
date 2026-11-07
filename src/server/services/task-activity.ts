import "server-only";
import { and, asc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import { effectiveStaffSettings, parsePersonOverride, parseTaskOverride, type StaffTaskOverride } from "@/lib/staff-schemas";
import { chaseFormFromFields, chaseFormValue, ChaseFormError, overrideFromForm, type ChaseFormValue, type PersonChaseSettings } from "@/lib/task-chase";
import { notificationsOutbox, people, taskChecklistItems, taskComments, taskEvents, tasks, telegramLinks, users } from "@/server/db/schema";
import { enqueueForPerson } from "@/server/notifications/outbox";
import { listedInChase } from "@/server/notifications/planner";
import { assertStaffBotAccess, canManageStaffBot } from "./access";
import type { ServiceContext } from "./context";
import { ServiceError } from "./errors";
import { readStaffDefaults } from "./staff";
import { getTask } from "./tasks";
import { CLOSED_STATUSES } from "./tasks-rules";

/**
 * The task list as a control center and the task page's timeline (0032): what was last sent to
 * the person and what they answered, comment counts, checklist progress, the chase choice, and
 * the founders' one-tap actions (Chase now, Pause / Resume chasing, the chase settings).
 * Everything starts from tasks the caller can already see (`getTask` / a TaskView list).
 */

export interface TaskActivity {
  comments: number;
  checklist: { done: number; total: number } | null;
  /** Last message to the assigned person about this task. */
  lastSent: { at: string; what: string; status: "sent" | "failed" | "waiting" } | null;
  /** The person's last answer (button or text). */
  lastReply: { at: string; what: string } | null;
  reminders: number;
  /** The person already got a message about it (a change then sends an updated card). */
  sentToPerson: boolean;
  /** The task's chase control as the form shows it. */
  chase: ChaseFormValue;
}

const KIND_TEXT: Record<string, string> = {
  staff_new_task: "New task sent",
  staff_chase: "Reminder sent",
  staff_morning_list: "Listed in the morning list",
  staff_info: "Info sent",
  staff_task_update: "Updated task sent",
};

export function replyText(v: unknown, kind: string): string {
  const r = (v ?? {}) as { reply?: string; proposedDueDate?: string; item?: string };
  if (kind === "status_changed") return `Marked ${String(v)}`;
  switch (r.reply) {
    case "accepted":
      return "Accepted";
    case "help":
      return "Asked for help";
    case "comment":
      return "Replied";
    case "checked":
      return `Ticked “${r.item ?? "item"}”`;
    case "deadline_request":
      return `Asked to move the deadline to ${r.proposedDueDate}`;
    default:
      return "Answered";
  }
}

const OUTER_TASK_ID = sql.raw(`"tasks"."id"`);

/** Activity per task for a list (three queries, whatever the number of tasks). */
export async function taskActivityFor(
  ctx: ServiceContext,
  list: readonly { id: string; assignee: { kind: "user" | "person"; id: string } | null }[],
): Promise<Record<string, TaskActivity>> {
  const ids = list.map((t) => t.id);
  if (!ids.length) return {};
  const personIds = [...new Set(list.flatMap((t) => (t.assignee?.kind === "person" ? [t.assignee.id] : [])))];
  const since = new Date(ctx.now.getTime() - 60 * 86_400_000);
  const o = notificationsOutbox;
  const [counts, sent, replies] = await Promise.all([
    // Comment count, checklist progress and the chase choice in one row per task. (A one-table
    // select prints its columns unqualified, so the outer task id is spelled out.)
    ctx.db
      .select({
        id: tasks.id,
        c: tasks.staffChase,
        comments: sql<number>`(select count(*) from ${taskComments} where ${taskComments.taskId} = ${OUTER_TASK_ID})`.mapWith(Number),
        total: sql<number>`(select count(*) from ${taskChecklistItems} where ${taskChecklistItems.taskId} = ${OUTER_TASK_ID})`.mapWith(Number),
        done: sql<number>`(select count(${taskChecklistItems.doneAt}) from ${taskChecklistItems} where ${taskChecklistItems.taskId} = ${OUTER_TASK_ID})`.mapWith(Number),
      })
      .from(tasks)
      .where(inArray(tasks.id, ids)),
    personIds.length
      ? ctx.db
          .select({ taskId: o.taskId, kind: o.kind, status: o.status, sentAt: o.sentAt, createdAt: o.createdAt, payload: o.payload })
          .from(o)
          .where(
            and(
              inArray(o.personId, personIds),
              inArray(o.status, ["sent", "failed", "pending", "sending"]),
              gte(o.createdAt, since),
              or(inArray(o.taskId, ids), eq(o.kind, "staff_chase")),
            ),
          )
          .orderBy(asc(o.createdAt))
      : Promise.resolve([]),
    ctx.db
      .select({ taskId: taskEvents.taskId, kind: taskEvents.kind, v: taskEvents.newValue, at: taskEvents.createdAt })
      .from(taskEvents)
      .where(and(inArray(taskEvents.taskId, ids), isNotNull(taskEvents.actorPersonId)))
      .orderBy(asc(taskEvents.createdAt)),
  ]);
  const out: Record<string, TaskActivity> = {};
  const byId = new Map(counts.map((r) => [r.id, r]));
  for (const t of list) {
    const r = byId.get(t.id);
    out[t.id] = {
      comments: r?.comments ?? 0,
      checklist: r && r.total > 0 ? { done: r.done, total: r.total } : null,
      lastSent: null,
      lastReply: null,
      reminders: 0,
      sentToPerson: false,
      chase: chaseFormValue(r ? parseTaskOverride(r.c) : {}),
    };
  }
  const idSet = new Set(ids);
  for (const s of sent) {
    // A grouped chase is about every task it listed (payload.listed once sent; payload.tasks while waiting).
    const about =
      s.taskId && idSet.has(s.taskId)
        ? [s.taskId]
        : s.kind === "staff_chase"
          ? [
              ...listedInChase(s).map((e) => e.id),
              ...((s.payload as { tasks?: { id: string }[] } | null)?.tasks ?? []).map((e) => e.id),
            ].filter((id, i, all) => idSet.has(id) && all.indexOf(id) === i)
          : [];
    for (const id of about) {
      const a = out[id]!;
      const status = s.status === "sent" ? "sent" : s.status === "failed" ? "failed" : "waiting";
      if (status === "sent") a.sentToPerson = true;
      if (status === "sent" && s.kind === "staff_chase") a.reminders++;
      // Waiting rows only count while nothing was sent after them.
      if (status !== "waiting" || !a.lastSent) {
        a.lastSent = { at: (s.sentAt ?? s.createdAt).toISOString(), what: KIND_TEXT[s.kind] ?? s.kind, status };
      }
    }
  }
  for (const r of replies) {
    if (r.taskId && out[r.taskId]) out[r.taskId]!.lastReply = { at: r.at.toISOString(), what: replyText(r.v, r.kind) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Timeline (task page)
// ---------------------------------------------------------------------------

export interface TimelineEntry {
  at: Date;
  icon: string;
  what: string;
  who: string;
  tone?: "ok" | "warn" | "risk" | "info";
}

const STATUS_WORD: Record<string, string> = { todo: "To do", in_progress: "In progress", waiting: "Waiting", done: "Done", cancelled: "Cancelled" };

/**
 * Everything that happened to the task, oldest first: created, status / deadline / assignee
 * changes (who, when), checklist changes, each message to the person (numbered reminders,
 * delivered or failed) and each of their answers (button pressed, ticked item, reply).
 */
export async function getTaskTimeline(ctx: ServiceContext, taskId: string): Promise<TimelineEntry[]> {
  const task = await getTask(ctx, taskId);
  const o = notificationsOutbox;
  const [events, sent] = await Promise.all([
    ctx.db
      .select({ e: taskEvents, userName: users.shortName, personName: people.fullName, personShort: people.shortName })
      .from(taskEvents)
      .leftJoin(users, eq(users.id, taskEvents.actorUserId))
      .leftJoin(people, eq(people.id, taskEvents.actorPersonId))
      .where(eq(taskEvents.taskId, task.id))
      .orderBy(asc(taskEvents.createdAt)),
    ctx.db
      .select({ o, name: people.fullName, short: people.shortName })
      .from(o)
      .innerJoin(people, eq(people.id, o.personId))
      .where(
        and(
          isNotNull(o.personId),
          inArray(o.status, ["sent", "failed"]),
          or(eq(o.taskId, task.id), sql`(${o.payload} -> 'listed') @> ${JSON.stringify([{ id: task.id }])}::jsonb`),
        ),
      )
      .orderBy(asc(o.createdAt)),
  ]);
  const out: TimelineEntry[] = [];
  let reminder = 0;
  for (const s of sent) {
    const who = s.short || s.name;
    const at = s.o.sentAt ?? s.o.createdAt;
    if (s.o.status === "failed") {
      out.push({ at, icon: "⚠️", what: `${KIND_TEXT[s.o.kind] ?? s.o.kind} — not delivered (${s.o.lastError ?? "error"})`, who, tone: "risk" });
      continue;
    }
    const n = s.o.kind === "staff_chase" ? ++reminder : 0;
    const manual = (s.o.payload as { manual?: boolean } | null)?.manual === true;
    out.push({
      at,
      icon: s.o.kind === "staff_chase" ? "🔔" : s.o.kind === "staff_task_update" ? "✏️" : "📨",
      what: s.o.kind === "staff_chase" ? `Reminder #${n} sent${manual ? " (Chase now)" : ""} · delivered` : `${KIND_TEXT[s.o.kind] ?? s.o.kind} · delivered`,
      who,
    });
  }
  for (const r of events) {
    const e = r.e;
    const who = r.userName ?? r.personShort ?? r.personName ?? "?";
    const viaTelegram = !!e.actorPersonId;
    if (viaTelegram) {
      out.push({ at: e.createdAt, icon: e.kind === "status_changed" ? "✅" : "👆", what: `${replyText(e.newValue, e.kind)} (Telegram)`, who, tone: "info" });
      continue;
    }
    switch (e.kind) {
      case "created":
        out.push({ at: e.createdAt, icon: "🆕", what: "Created", who });
        break;
      case "status_changed":
        out.push({
          at: e.createdAt,
          icon: e.newValue === "done" ? "✅" : e.newValue === "cancelled" ? "🗄" : "↻",
          what: `Status: ${STATUS_WORD[String(e.oldValue)] ?? e.oldValue} → ${STATUS_WORD[String(e.newValue)] ?? e.newValue}`,
          who,
          tone: e.newValue === "done" ? "ok" : undefined,
        });
        break;
      case "deadline_changed":
        out.push({ at: e.createdAt, icon: "📅", what: `Deadline: ${e.oldValue ?? "none"} → ${e.newValue ?? "none"}`, who });
        break;
      case "assignee_changed":
        if (e.newValue) out.push({ at: e.createdAt, icon: "👤", what: "Assignee changed", who });
        break;
      case "updated": {
        if (e.field === "checklist") {
          const v = (e.newValue ?? {}) as { action?: string; item?: string };
          out.push({ at: e.createdAt, icon: "☑️", what: `Checklist: ${v.action ?? "changed"} “${v.item ?? ""}”`, who });
        } else if (e.field === "title") out.push({ at: e.createdAt, icon: "✎", what: "Title changed", who });
        break;
      }
    }
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

// ---------------------------------------------------------------------------
// Founders' one-tap actions
// ---------------------------------------------------------------------------

/** Why nothing reaches the person right now (null = they can be messaged). */
export async function personUnreachableReason(ctx: ServiceContext, personId: string): Promise<string | null> {
  const [p] = await ctx.db
    .select({ botEnabled: people.botEnabled, pausedUntil: people.botPausedUntil, leftAt: people.leftAt, stoppedAt: telegramLinks.stoppedAt, linkId: telegramLinks.id })
    .from(people)
    .leftJoin(telegramLinks, eq(telegramLinks.personId, people.id))
    .where(eq(people.id, personId));
  if (!p || p.leftAt) return "they left";
  if (!p.linkId) return "they have not linked Telegram yet (invite them from their page)";
  if (p.stoppedAt) return "they stopped the bot (/stop)";
  if (!p.botEnabled) return "“Bot may message” is off (Settings → Team on Telegram)";
  if (p.pausedUntil && p.pausedUntil.getTime() > ctx.now.getTime()) return "messages to them are paused";
  return null;
}

async function personTask(ctx: ServiceContext, taskId: string) {
  assertStaffBotAccess(ctx);
  const task = await getTask(ctx, taskId);
  if (task.assignee?.kind !== "person" || task.visibility !== "shared") {
    throw new ServiceError("validation", "Only tasks assigned to a person on Telegram are chased");
  }
  return { task, person: task.assignee };
}

/**
 * "Chase now": one reminder to the person right away (the caller then runs the dispatcher), even
 * while chasing is off or paused for the task. Quiet hours and the person's daily cap still apply.
 */
export async function chaseTaskNow(ctx: ServiceContext, taskId: string): Promise<{ personName: string }> {
  const { task, person } = await personTask(ctx, taskId);
  if ((CLOSED_STATUSES as readonly string[]).includes(task.status)) throw new ServiceError("validation", "The task is closed");
  const why = await personUnreachableReason(ctx, person.id);
  if (why) throw new ServiceError("validation", `Can't reach ${person.name}: ${why}`);
  await enqueueForPerson(ctx.db, {
    personId: person.id,
    kind: "staff_chase",
    taskId: null,
    dedupeKey: `now:${task.id}:${ctx.now.getTime()}`,
    scheduledFor: ctx.now,
    expiresAt: new Date(ctx.now.getTime() + 2 * 3_600_000),
    priority: "normal",
    payload: { manual: true, tasks: [{ id: task.id, dueDate: task.dueDate, slotStart: ctx.now.toISOString() }] },
  });
  return { personName: person.name };
}

async function writeOverride(ctx: ServiceContext, taskId: string, next: StaffTaskOverride | null) {
  await ctx.db
    .update(tasks)
    .set({ staffChase: next && Object.keys(next).length ? (next as Record<string, unknown>) : null })
    .where(eq(tasks.id, taskId));
}

async function readOverride(ctx: ServiceContext, taskId: string): Promise<StaffTaskOverride> {
  const [row] = await ctx.db.select({ c: tasks.staffChase }).from(tasks).where(eq(tasks.id, taskId));
  return parseTaskOverride(row?.c);
}

/** "Pause chasing" / "Resume chasing" (the chosen mode is kept). */
export async function setTaskChasePaused(ctx: ServiceContext, taskId: string, paused: boolean): Promise<void> {
  const { task } = await personTask(ctx, taskId);
  const current = await readOverride(ctx, task.id);
  const next = { ...current };
  if (paused) next.chasePaused = true;
  else delete next.chasePaused;
  await writeOverride(ctx, task.id, next);
}

/**
 * Saves the task's chase control (form fields: chase, everyN, everyUnit, escalation,
 * escalateDays, founderNudge, shareNotes). Person chase fields need founders (the team bot);
 * the founder-nudge choice is any task's. Field errors come back as a validation error.
 */
export async function setTaskChase(ctx: ServiceContext, taskId: string, fields: Record<string, string | undefined>): Promise<StaffTaskOverride | null> {
  const task = await getTask(ctx, taskId);
  const current = await readOverride(ctx, task.id);
  const value = chaseFormFromFields(fields, chaseFormValue(current));
  if (task.assignee?.kind === "person") assertStaffBotAccess(ctx);
  let next: StaffTaskOverride | null;
  try {
    next = overrideFromForm(value);
  } catch (err) {
    if (err instanceof ChaseFormError) throw new ServiceError("validation", err.message, { [err.field]: [err.message] });
    throw err;
  }
  await writeOverride(ctx, task.id, next);
  return next;
}

/** The person's own chase settings (global defaults ← their overrides) for the live summary. */
export async function personChaseSettings(
  ctx: ServiceContext,
  personIds: string[],
  opts: { reachability?: boolean } = {},
): Promise<Record<string, PersonChaseSettings & { unreachable: string | null }>> {
  if (!canManageStaffBot(ctx) || !personIds.length) return {};
  const defaults = await readStaffDefaults(ctx);
  const rows = await ctx.db.select({ id: people.id, c: people.staffChase }).from(people).where(inArray(people.id, personIds));
  const out: Record<string, PersonChaseSettings & { unreachable: string | null }> = {};
  for (const r of rows) {
    const s = effectiveStaffSettings(defaults, parsePersonOverride(r.c));
    out[r.id] = {
      workStart: s.workStart,
      workEnd: s.workEnd,
      chaseEveryMinutes: s.chaseEveryMinutes,
      escalateAfterChases: s.escalateAfterChases,
      escalateAt: s.escalateAt,
      unreachable: opts.reachability === false ? null : await personUnreachableReason(ctx, r.id),
    };
  }
  return out;
}
