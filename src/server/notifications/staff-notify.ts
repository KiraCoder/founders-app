import "server-only";
import type { Db } from "@/server/db/connect";
import { notificationsOutbox, type NotificationPriority } from "@/server/db/schema";
import { listFounders } from "./founders";
import type { NeutralMessage } from "./types";

/**
 * Tells founders about something a person did on Telegram (or did not do: an escalation).
 * - Without `push`: ONE line in the founder's next summary (a parked `staff_update` row; no
 *   budget used, no extra message). That is the default: founders asked for fewer pushes.
 * - With `push`: a `staff_update` push through the normal dispatcher rules (quiet hours, fold
 *   into the morning summary, the daily budget — over budget it is parked and becomes the same
 *   line). Used for urgent tasks, escalations, help and deadline requests (which carry the
 *   one-tap Approve / Decline buttons).
 */
export interface FounderNote {
  /** Recipients: the task's owner founder, or all founders when null. */
  userIds: string[] | null;
  /** English, one line (the summary line). */
  line: string;
  /** Unique per founder; makes a retried event harmless. */
  dedupeKey: string;
  taskId?: string | null;
  now: Date;
  push?: { priority: NotificationPriority; message: NeutralMessage; requestId?: string };
}

export async function notifyFounders(db: Db, note: FounderNote): Promise<number> {
  const userIds = note.userIds ?? (await listFounders(db)).map((f) => f.id);
  let created = 0;
  for (const userId of userIds) {
    const rows = await db
      .insert(notificationsOutbox)
      .values({
        userId,
        kind: "staff_update",
        taskId: note.taskId ?? null,
        scheduledFor: note.now,
        dedupeKey: note.dedupeKey,
        priority: note.push?.priority ?? "normal",
        // Without a push it is parked right away: the next summary lists it.
        status: note.push ? "pending" : "parked",
        parkedAt: note.push ? null : note.now,
        lastError: note.push ? null : "staff_line",
        payload: {
          summaryLine: note.line,
          ...(note.push ? { message: note.push.message, requestId: note.push.requestId ?? null } : {}),
        },
      })
      .onConflictDoNothing({ target: [notificationsOutbox.userId, notificationsOutbox.dedupeKey] })
      .returning({ id: notificationsOutbox.id });
    created += rows.length;
  }
  return created;
}
