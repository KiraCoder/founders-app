import "server-only";
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { addDays, todayInTimeZone, type IsoDate } from "@/lib/dates";
import { commentTextSchema } from "@/lib/staff-schemas";
import {
  companies,
  notificationsOutbox,
  people,
  taskComments,
  taskDeadlineRequests,
  taskEvents,
  tasks,
  type Task,
} from "@/server/db/schema";
import { ruDate, type StaffTaskLite } from "@/server/notifications/messages-ru";
import { notifyFounders } from "@/server/notifications/staff-notify";
import type { NeutralMessage } from "@/server/notifications/types";
import { assertValidId, staffTasksWhere, type PersonContext } from "./access";
import { ServiceError } from "./errors";
import { CLOSED_STATUSES } from "./tasks-rules";

/**
 * What a linked person (staff) can do through the Telegram bot, as a PersonContext. Every
 * function goes through `staffTasksWhere`: only shared tasks assigned to this person, of a live
 * company. A person can close their task, accept it, ask for help, comment and REQUEST a new
 * deadline; they can never change a deadline, see other tasks, or reach anything else.
 * Every action is logged in task_events (actor_person_id) and the task's founder is told.
 */

export function personContext(
  db: PersonContext["db"],
  person: { id: string; fullName: string; shortName: string | null },
  now: Date,
  timeZone = process.env.APP_TIMEZONE || "Asia/Bishkek",
): PersonContext {
  return { db, person, now, timeZone };
}

const personName = (p: PersonContext) => p.person.shortName || p.person.fullName;
const todayOf = (p: PersonContext) => todayInTimeZone(p.now, p.timeZone);

interface OwnTask {
  task: Task;
  companyName: string | null;
}

/** A task assigned to this person, or not_found (also for tasks of other people and private todos). */
export async function getPersonTask(pctx: PersonContext, taskId: string): Promise<OwnTask> {
  assertValidId(taskId, "Task");
  const [row] = await pctx.db
    .select({ task: tasks, companyName: companies.name })
    .from(tasks)
    .leftJoin(companies, eq(companies.id, tasks.companyId))
    .where(and(eq(tasks.id, taskId), staffTasksWhere(pctx)));
  if (!row) throw new ServiceError("not_found", "Task not found");
  return row;
}

export function toLite(t: Task, companyName: string | null): StaffTaskLite {
  return { id: t.id, title: t.title, dueDate: t.dueDate, priority: t.priority, companyName };
}

/** Open tasks assigned to this person, earliest deadline first (the numbering of /tasks and /done N). */
export async function listPersonOpenTasks(pctx: PersonContext): Promise<StaffTaskLite[]> {
  const rows = await pctx.db
    .select({ task: tasks, companyName: companies.name })
    .from(tasks)
    .leftJoin(companies, eq(companies.id, tasks.companyId))
    .where(and(staffTasksWhere(pctx), notInArray(tasks.status, [...CLOSED_STATUSES])))
    .orderBy(sql`${tasks.dueDate} asc nulls last`, asc(tasks.createdAt), asc(tasks.id));
  return rows.map((r) => toLite(r.task, r.companyName));
}

async function logReply(pctx: PersonContext, t: Task, value: Record<string, unknown>, tx: PersonContext["db"] = pctx.db) {
  await tx.insert(taskEvents).values({
    taskId: t.id,
    companyId: t.companyId,
    actorUserId: null,
    actorPersonId: pctx.person.id,
    visibility: t.visibility,
    ownerUserId: t.ownerUserId,
    kind: "staff_reply",
    field: "telegram",
    newValue: value,
    // The context clock (= the real time in production): the planner compares answers with chases.
    createdAt: pctx.now,
  });
}

/** Person rows still waiting for this task (a chase after Готово makes no sense). */
async function cancelPersonPending(pctx: PersonContext, taskId: string, reason: string) {
  await pctx.db
    .update(notificationsOutbox)
    .set({ status: "cancelled", lastError: reason, nextAttemptAt: null })
    .where(
      and(
        eq(notificationsOutbox.personId, pctx.person.id),
        eq(notificationsOutbox.taskId, taskId),
        inArray(notificationsOutbox.status, ["pending", "not_linked"]),
      ),
    );
}

/** "Готово": closes the task (logged as a status change by this person). */
export async function personMarkDone(pctx: PersonContext, taskId: string): Promise<{ alreadyClosed: boolean; title: string }> {
  const { task } = await getPersonTask(pctx, taskId);
  if (task.status === "done" || task.status === "cancelled") return { alreadyClosed: true, title: task.title };
  await pctx.db.transaction(async (tx) => {
    await tx
      .update(tasks)
      .set({ status: "done", completedAt: pctx.now, updatedAt: pctx.now })
      .where(and(eq(tasks.id, task.id), eq(tasks.assigneePersonId, pctx.person.id)));
    await tx.insert(taskEvents).values({
      taskId: task.id,
      companyId: task.companyId,
      actorUserId: null,
      actorPersonId: pctx.person.id,
      visibility: task.visibility,
      ownerUserId: task.ownerUserId,
      kind: "status_changed",
      field: "status",
      oldValue: task.status,
      newValue: "done",
      createdAt: pctx.now,
    });
  });
  await cancelPersonPending(pctx, task.id, "task_closed");
  const line = `${personName(pctx)} marked done (Telegram): ${task.title}`;
  await notifyFounders(pctx.db, {
    userIds: [task.ownerUserId],
    line,
    taskId: task.id,
    dedupeKey: `staff:done:${task.id}:${pctx.now.toISOString()}`,
    now: pctx.now,
    // Urgent tasks get a push; everything else is one line in the next summary.
    ...(task.priority === "urgent"
      ? { push: { priority: "urgent" as const, message: { title: "Done by the team", lines: [{ text: line }] } } }
      : {}),
  });
  return { alreadyClosed: false, title: task.title };
}

/** "Принято": logged on the task (the founder sees it in the delivery trail). */
export async function personAccept(pctx: PersonContext, taskId: string): Promise<void> {
  const { task } = await getPersonTask(pctx, taskId);
  await logReply(pctx, task, { reply: "accepted" });
}

async function addComment(pctx: PersonContext, task: Task, text: string, kind: "comment" | "help") {
  const clean = commentTextSchema.parse(text);
  const [row] = await pctx.db
    .insert(taskComments)
    .values({ taskId: task.id, authorPersonId: pctx.person.id, text: clean, source: "telegram", kind })
    .returning({ id: taskComments.id });
  await logReply(pctx, task, { reply: kind, commentId: row!.id });
  return { id: row!.id, text: clean };
}

const quote = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** "Нужна помощь": a help comment on the task + a push to the task's founder. */
export async function personHelp(pctx: PersonContext, taskId: string): Promise<void> {
  const { task } = await getPersonTask(pctx, taskId);
  const c = await addComment(pctx, task, "Нужна помощь", "help");
  const line = `${personName(pctx)} needs help (Telegram): ${task.title}`;
  await notifyFounders(pctx.db, {
    userIds: [task.ownerUserId],
    line,
    taskId: task.id,
    dedupeKey: `staff:help:${c.id}`,
    now: pctx.now,
    push: { priority: "high", message: { title: "Help needed", lines: [{ text: line }, { text: "Open the task in the app to answer.", style: "muted" }] } },
  });
}

/** A free-text reply on a task: a comment + one line for the task's founder (a push if the task is urgent). */
export async function personComment(pctx: PersonContext, taskId: string, text: string): Promise<void> {
  const { task } = await getPersonTask(pctx, taskId);
  const c = await addComment(pctx, task, text, "comment");
  const line = `${personName(pctx)} on "${quote(task.title, 80)}": ${quote(c.text)}`;
  await notifyFounders(pctx.db, {
    userIds: [task.ownerUserId],
    line,
    taskId: task.id,
    dedupeKey: `staff:comment:${c.id}`,
    now: pctx.now,
    ...(task.priority === "urgent"
      ? { push: { priority: "urgent" as const, message: { title: "Message from the team", lines: [{ text: line }] } } }
      : {}),
  });
}

/**
 * "Перенести срок" (+N days from the current deadline, or from today when it is already past):
 * a pending request (it replaces an earlier pending one). The founder approves with one tap;
 * the person can never move the deadline themselves.
 */
export async function personRequestDeadline(pctx: PersonContext, taskId: string, days: number): Promise<IsoDate> {
  if (![1, 3, 7].includes(days)) throw new ServiceError("validation", "Unknown option");
  const { task, companyName } = await getPersonTask(pctx, taskId);
  if (task.status === "done" || task.status === "cancelled") throw new ServiceError("validation", "Task is closed");
  const today = todayOf(pctx);
  const base = task.dueDate && task.dueDate >= today ? task.dueDate : today;
  const proposed = addDays(base, days);
  const requestId = await pctx.db.transaction(async (tx) => {
    await tx
      .update(taskDeadlineRequests)
      .set({ status: "cancelled", decidedAt: pctx.now })
      .where(and(eq(taskDeadlineRequests.taskId, task.id), eq(taskDeadlineRequests.status, "pending")));
    const [row] = await tx
      .insert(taskDeadlineRequests)
      .values({ taskId: task.id, personId: pctx.person.id, currentDueDate: task.dueDate, proposedDueDate: proposed })
      .returning({ id: taskDeadlineRequests.id });
    await logReply(pctx, task, { reply: "deadline_request", proposedDueDate: proposed, requestId: row!.id }, tx as never);
    return row!.id;
  });
  const line = `${personName(pctx)} asks to move "${quote(task.title, 80)}" to ${proposed}${task.dueDate ? ` (now ${task.dueDate})` : ""}`;
  const message: NeutralMessage = {
    title: "Deadline change requested",
    lines: [
      { text: line, style: "text" },
      ...(companyName ? [{ text: companyName, style: "muted" as const }] : []),
    ],
    actions: [
      { action: "deadline_approve", requestId, label: `Approve ${ruDate(proposed)}` },
      { action: "deadline_decline", requestId, label: "Decline" },
    ],
  };
  await notifyFounders(pctx.db, {
    userIds: [task.ownerUserId],
    line: `${line} — approve on the task page`,
    taskId: task.id,
    dedupeKey: `staff:deadline:${requestId}`,
    now: pctx.now,
    push: { priority: "high", message, requestId },
  });
  return proposed;
}

/** A photo / voice / file arrived: nothing is stored, founders get one line. */
export async function personSentFile(pctx: PersonContext, what: string, updateId: number): Promise<void> {
  await notifyFounders(pctx.db, {
    userIds: null,
    line: `${personName(pctx)} sent a ${what} on Telegram (not stored — ask them to write it, or see it in their chat)`,
    dedupeKey: `staff:file:${pctx.person.id}:${updateId}`,
    now: pctx.now,
  });
}

/** A free-text message that belongs to no task (the person has no open task). */
export async function personMessageWithoutTask(pctx: PersonContext, text: string, updateId: number): Promise<void> {
  const clean = commentTextSchema.parse(text);
  await notifyFounders(pctx.db, {
    userIds: null,
    line: `${personName(pctx)} wrote on Telegram: ${quote(clean)}`,
    dedupeKey: `staff:text:${pctx.person.id}:${updateId}`,
    now: pctx.now,
  });
}

/** /stop and /start again: founders get one line. */
export async function personBotSwitched(pctx: PersonContext, stopped: boolean): Promise<void> {
  await notifyFounders(pctx.db, {
    userIds: null,
    line: stopped
      ? `${personName(pctx)} stopped the bot (/stop): no more messages to them until they send /start`
      : `${personName(pctx)} turned the bot back on (/start)`,
    dedupeKey: `staff:${stopped ? "stop" : "resume"}:${pctx.person.id}:${pctx.now.toISOString()}`,
    now: pctx.now,
  });
}

/** The person (for a PersonContext), or null when unknown or left. */
export async function loadActivePerson(db: PersonContext["db"], personId: string) {
  const [p] = await db
    .select({ id: people.id, fullName: people.fullName, shortName: people.shortName })
    .from(people)
    .where(and(eq(people.id, personId), isNull(people.leftAt)));
  return p ?? null;
}
