import "server-only";
import { and, eq, inArray } from "drizzle-orm";
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

/**
 * Adds a notification to the outbox. Everything that will ever be sent goes through here.
 * Refuses non-founder recipients (defence in depth: only the two founders get messages).
 */
export async function enqueue(db: Db, input: EnqueueInput): Promise<EnqueueResult> {
  const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, input.userId));
  if (!user || user.role !== "founder") {
    throw new Error("Notifications can only be sent to founders");
  }
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

/** Cancels pending task notifications for one user + task (after done / snooze). */
export async function cancelPendingForTask(db: Db, userId: string, taskId: string, reason: string): Promise<number> {
  const rows = await db
    .update(notificationsOutbox)
    .set({ status: "cancelled", lastError: reason })
    .where(
      and(
        eq(notificationsOutbox.userId, userId),
        eq(notificationsOutbox.taskId, taskId),
        inArray(notificationsOutbox.status, ["pending"]),
      ),
    )
    .returning({ id: notificationsOutbox.id });
  return rows.length;
}
