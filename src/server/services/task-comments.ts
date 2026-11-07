import "server-only";
import { and, asc, desc, eq, isNotNull, or, sql } from "drizzle-orm";
import { commentTextSchema } from "@/lib/staff-schemas";
import {
  notificationsOutbox,
  people,
  taskComments,
  taskDeadlineRequests,
  taskEvents,
  users,
  type TaskComment,
  type TaskDeadlineRequest,
} from "@/server/db/schema";
import { ruDate } from "@/server/notifications/messages-ru";
import { enqueueForPerson } from "@/server/notifications/outbox";
import { assertStaffBotAccess, assertValidId } from "./access";
import type { ServiceContext } from "./context";
import { ServiceError } from "./errors";
import { changeTaskDeadline, getTask } from "./tasks";

/**
 * Task comments (founders in the app, persons through the bot), a person's deadline requests and
 * the staff delivery trail on the task page. Everything is read through `getTask`, so it follows
 * the task's visibility rule (a personal todo's comments are its owner's only).
 */

export interface CommentView extends TaskComment {
  authorName: string;
  /** The signed-in founder wrote it (may edit / delete). */
  mine: boolean;
}

export async function listTaskComments(ctx: ServiceContext, taskId: string): Promise<CommentView[]> {
  await getTask(ctx, taskId);
  const rows = await ctx.db
    .select({ c: taskComments, userName: users.shortName, personName: people.fullName, personShort: people.shortName })
    .from(taskComments)
    .leftJoin(users, eq(users.id, taskComments.authorUserId))
    .leftJoin(people, eq(people.id, taskComments.authorPersonId))
    .where(eq(taskComments.taskId, taskId))
    .orderBy(asc(taskComments.createdAt), asc(taskComments.id));
  return rows.map((r) => ({
    ...r.c,
    authorName: r.userName ?? r.personShort ?? r.personName ?? "?",
    mine: r.c.authorUserId === ctx.user.id,
  }));
}

export async function addTaskComment(ctx: ServiceContext, taskId: string, text: unknown): Promise<TaskComment> {
  const clean = commentTextSchema.parse(text);
  await getTask(ctx, taskId);
  const [row] = await ctx.db
    .insert(taskComments)
    .values({ taskId, authorUserId: ctx.user.id, text: clean, source: "app" })
    .returning();
  return row!;
}

async function loadOwnComment(ctx: ServiceContext, commentId: string): Promise<TaskComment> {
  assertValidId(commentId, "Comment");
  const [row] = await ctx.db.select().from(taskComments).where(eq(taskComments.id, commentId));
  if (!row) throw new ServiceError("not_found", "Comment not found");
  await getTask(ctx, row.taskId); // visibility of the task
  if (row.authorUserId !== ctx.user.id) throw new ServiceError("forbidden", "You can only change your own comments");
  return row;
}

export async function updateTaskComment(ctx: ServiceContext, commentId: string, text: unknown): Promise<TaskComment> {
  const clean = commentTextSchema.parse(text);
  const current = await loadOwnComment(ctx, commentId);
  const [row] = await ctx.db
    .update(taskComments)
    .set({ text: clean, editedAt: ctx.now })
    .where(eq(taskComments.id, current.id))
    .returning();
  return row!;
}

export async function deleteTaskComment(ctx: ServiceContext, commentId: string): Promise<void> {
  const current = await loadOwnComment(ctx, commentId);
  await ctx.db.delete(taskComments).where(eq(taskComments.id, current.id));
}

// ---------------------------------------------------------------------------
// Deadline requests ("Перенести срок")
// ---------------------------------------------------------------------------

export interface DeadlineRequestView extends TaskDeadlineRequest {
  personName: string;
}

export async function listDeadlineRequests(ctx: ServiceContext, taskId: string): Promise<DeadlineRequestView[]> {
  await getTask(ctx, taskId);
  const rows = await ctx.db
    .select({ r: taskDeadlineRequests, name: people.fullName, short: people.shortName })
    .from(taskDeadlineRequests)
    .innerJoin(people, eq(people.id, taskDeadlineRequests.personId))
    .where(eq(taskDeadlineRequests.taskId, taskId))
    .orderBy(desc(taskDeadlineRequests.createdAt));
  return rows.map((r) => ({ ...r.r, personName: r.short || r.name }));
}

/**
 * A founder approves (the deadline moves through the tasks service, logged in task_events) or
 * declines. Only a pending request; the person gets one short line back.
 */
export async function decideDeadlineRequest(
  ctx: ServiceContext,
  requestId: string,
  approve: boolean,
): Promise<{ status: "approved" | "declined"; proposedDueDate: string; taskTitle: string }> {
  assertStaffBotAccess(ctx);
  assertValidId(requestId, "Request");
  const [req] = await ctx.db.select().from(taskDeadlineRequests).where(eq(taskDeadlineRequests.id, requestId));
  if (!req) throw new ServiceError("not_found", "Request not found");
  const task = await getTask(ctx, req.taskId);
  if (req.status !== "pending") throw new ServiceError("conflict", `This request was already ${req.status}`);
  const status = approve ? "approved" : "declined";
  // The decision and the deadline move succeed or fail together (never "approved" with the old deadline).
  await ctx.db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(taskDeadlineRequests)
      .set({ status, decidedByUserId: ctx.user.id, decidedAt: ctx.now })
      .where(and(eq(taskDeadlineRequests.id, req.id), eq(taskDeadlineRequests.status, "pending")))
      .returning({ id: taskDeadlineRequests.id });
    if (!claimed) throw new ServiceError("conflict", "This request was already decided");
    if (approve) await changeTaskDeadline({ ...ctx, db: tx as unknown as ServiceContext["db"] }, task.id, req.proposedDueDate);
  });
  await enqueueForPerson(ctx.db, {
    personId: req.personId,
    kind: "staff_info",
    taskId: task.id,
    scheduledFor: ctx.now,
    dedupeKey: `info:deadline:${req.id}`,
    expiresAt: new Date(ctx.now.getTime() + 3 * 86_400_000),
    payload: {
      text: approve
        ? `Срок по задаче «${task.title}» перенесён на ${ruDate(req.proposedDueDate)}.`
        : `Перенос срока по задаче «${task.title}» не согласован. Срок прежний${task.dueDate ? `: ${ruDate(task.dueDate)}` : ""}.`,
    },
  });
  return { status, proposedDueDate: req.proposedDueDate, taskTitle: task.title };
}

// ---------------------------------------------------------------------------
// Delivery trail (what the bot sent to the assigned person, and what they did)
// ---------------------------------------------------------------------------

export interface TrailEntry {
  at: Date;
  what: string;
  who: string;
}

const KIND_TEXT: Record<string, string> = {
  staff_new_task: "New task sent",
  staff_chase: "Reminder sent",
  staff_morning_list: "Listed in the morning list",
  staff_info: "Info sent",
};

export async function getTaskStaffTrail(ctx: ServiceContext, taskId: string): Promise<TrailEntry[]> {
  await getTask(ctx, taskId);
  const [sent, events] = await Promise.all([
    ctx.db
      .select({ o: notificationsOutbox, name: people.fullName, short: people.shortName })
      .from(notificationsOutbox)
      .innerJoin(people, eq(people.id, notificationsOutbox.personId))
      .where(
        and(
          isNotNull(notificationsOutbox.personId),
          eq(notificationsOutbox.status, "sent"),
          // A grouped chase lists several tasks (payload.listed).
          or(
            eq(notificationsOutbox.taskId, taskId),
            sql`(${notificationsOutbox.payload} -> 'listed') @> ${JSON.stringify([{ id: taskId }])}::jsonb`,
          ),
        ),
      ),
    ctx.db
      .select({ e: taskEvents, name: people.fullName, short: people.shortName })
      .from(taskEvents)
      .innerJoin(people, eq(people.id, taskEvents.actorPersonId))
      .where(and(eq(taskEvents.taskId, taskId), isNotNull(taskEvents.actorPersonId))),
  ]);
  const out: TrailEntry[] = [];
  for (const s of sent) {
    out.push({ at: s.o.sentAt ?? s.o.createdAt, what: KIND_TEXT[s.o.kind] ?? s.o.kind, who: s.short || s.name });
  }
  for (const r of events) {
    const v = (r.e.newValue ?? {}) as { reply?: string; proposedDueDate?: string };
    const what =
      r.e.kind === "status_changed"
        ? `Marked ${String(r.e.newValue)}`
        : v.reply === "accepted"
          ? "Accepted"
          : v.reply === "help"
            ? "Asked for help"
            : v.reply === "comment"
              ? "Replied"
              : v.reply === "deadline_request"
                ? `Asked to move the deadline to ${v.proposedDueDate}`
                : "Answered";
    out.push({ at: r.e.createdAt, what, who: r.short || r.name });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}
