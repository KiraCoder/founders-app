import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/server/db/connect";
import { notificationsOutbox, people, tasks } from "@/server/db/schema";
import { enqueueForPerson } from "@/server/notifications/outbox";
import { CLOSED_STATUSES } from "./tasks-rules";

/**
 * "Elmurat will get an updated message" (0032): when a founder changes a task that was already
 * sent to its person (new / changed checklist items, title, deadline, shared notes), ONE
 * `staff_task_update` card is queued. It is built at send time from the task's current state, so
 * several changes in a row (adding items one by one) become one message: while an update is still
 * waiting, nothing more is queued. Nothing is queued before the new-task message went out (that
 * message is itself built at send time and already shows the changes).
 */
export const STAFF_UPDATE_DELAY_MS = 60_000;

export async function queueStaffTaskUpdate(db: Db, taskId: string, now: Date): Promise<{ queued: boolean; personName: string | null }> {
  const [t] = await db
    .select({ id: tasks.id, personId: tasks.assigneePersonId, visibility: tasks.visibility, status: tasks.status, name: people.shortName, full: people.fullName })
    .from(tasks)
    .leftJoin(people, eq(people.id, tasks.assigneePersonId))
    .where(eq(tasks.id, taskId));
  if (!t?.personId || t.visibility !== "shared" || (CLOSED_STATUSES as readonly string[]).includes(t.status)) {
    return { queued: false, personName: null };
  }
  const personName = t.name || t.full;
  if (!(await wasSentToPerson(db, t.id, t.personId))) return { queued: false, personName };
  const o = notificationsOutbox;
  const [waiting] = await db
    .select({ id: o.id })
    .from(o)
    .where(and(eq(o.personId, t.personId), eq(o.taskId, t.id), eq(o.kind, "staff_task_update"), inArray(o.status, ["pending", "sending"])))
    .limit(1);
  if (waiting) return { queued: true, personName };
  await enqueueForPerson(db, {
    personId: t.personId,
    kind: "staff_task_update",
    taskId: t.id,
    dedupeKey: `upd:${t.id}:${now.getTime()}`,
    scheduledFor: new Date(now.getTime() + STAFF_UPDATE_DELAY_MS),
    expiresAt: new Date(now.getTime() + 3 * 86_400_000),
    priority: "normal",
  });
  return { queued: true, personName };
}

/** The task's person already got a message about it (its new-task card, a reminder or an update). */
export async function wasSentToPerson(db: Db, taskId: string, personId: string): Promise<boolean> {
  const o = notificationsOutbox;
  const [row] = await db
    .select({ id: o.id })
    .from(o)
    .where(and(eq(o.personId, personId), eq(o.taskId, taskId), eq(o.status, "sent")))
    .limit(1);
  return !!row;
}
