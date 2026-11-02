import "server-only";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@/server/db/connect";
import { notificationsOutbox, users, type NotificationPriority } from "@/server/db/schema";
import type { NotificationKind } from "./types";

export interface EnqueueInput {
  userId: string;
  kind: NotificationKind;
  scheduledFor: Date;
  /** Unique per user: the same chase/summary is never queued twice. */
  dedupeKey: string;
  expiresAt?: Date | null;
  priority?: NotificationPriority;
  taskId?: string | null;
  payload?: Record<string, unknown>;
}

export interface EnqueueResult {
  id: string | null;
  created: boolean;
}

async function assertFounder(db: Db, userId: string): Promise<void> {
  const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  if (!user || user.role !== "founder") {
    throw new Error("Notifications can only be sent to founders");
  }
}

/**
 * Adds a notification to the outbox. Everything that will ever be sent goes through here.
 * Refuses non-founder recipients (defence in depth: only the two founders get messages).
 */
export async function enqueue(db: Db, input: EnqueueInput): Promise<EnqueueResult> {
  await assertFounder(db, input.userId);
  const rows = await db
    .insert(notificationsOutbox)
    .values({
      userId: input.userId,
      kind: input.kind,
      scheduledFor: input.scheduledFor,
      dedupeKey: input.dedupeKey,
      expiresAt: input.expiresAt ?? null,
      priority: input.priority ?? "normal",
      taskId: input.taskId ?? null,
      payload: input.payload ?? {},
    })
    .onConflictDoNothing({ target: [notificationsOutbox.userId, notificationsOutbox.dedupeKey] })
    .returning({ id: notificationsOutbox.id });
  return { id: rows[0]?.id ?? null, created: rows.length > 0 };
}

/**
 * Queues the "Snooze 1 day" reminder under the task's per-day key (one push per task per
 * day). A cancelled or still-waiting item with that key (e.g. an earlier snooze the same
 * day) is revived with the new time; one that was already sent or is being sent wins.
 */
export async function scheduleTaskReminder(
  db: Db,
  input: { userId: string; taskId: string; scheduledFor: Date; dedupeKey: string },
): Promise<EnqueueResult> {
  await assertFounder(db, input.userId);
  const rows = await db
    .insert(notificationsOutbox)
    .values({
      userId: input.userId,
      kind: "task_reminder",
      taskId: input.taskId,
      scheduledFor: input.scheduledFor,
      dedupeKey: input.dedupeKey,
      priority: "normal",
      payload: {},
    })
    .onConflictDoUpdate({
      target: [notificationsOutbox.userId, notificationsOutbox.dedupeKey],
      set: {
        kind: "task_reminder",
        taskId: input.taskId,
        status: "pending",
        scheduledFor: input.scheduledFor,
        expiresAt: null,
        attempts: 0,
        lastError: null,
        nextAttemptAt: null,
        claimedAt: null,
        parkedAt: null,
        bundledIntoId: null,
      },
      setWhere: sql`${notificationsOutbox.status} in ('pending', 'cancelled', 'parked', 'not_linked')`,
    })
    .returning({ id: notificationsOutbox.id });
  return { id: rows[0]?.id ?? null, created: rows.length > 0 };
}

/**
 * Cancels everything still waiting for one user + task (after done / snooze / deadline
 * move): pending, held as not linked, and parked items not yet listed in a summary.
 */
export async function cancelPendingForTask(db: Db, userId: string, taskId: string, reason: string): Promise<number> {
  const rows = await db
    .update(notificationsOutbox)
    .set({ status: "cancelled", lastError: reason, nextAttemptAt: null })
    .where(
      and(
        eq(notificationsOutbox.userId, userId),
        eq(notificationsOutbox.taskId, taskId),
        or(
          inArray(notificationsOutbox.status, ["pending", "not_linked"]),
          and(eq(notificationsOutbox.status, "parked"), isNull(notificationsOutbox.bundledIntoId)),
        ),
      ),
    )
    .returning({ id: notificationsOutbox.id });
  return rows.length;
}
