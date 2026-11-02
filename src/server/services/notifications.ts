import "server-only";
import { desc, eq } from "drizzle-orm";
import { addDays, formatDueDate, todayInTimeZone } from "@/lib/dates";
import { notificationPrefsSchema, type NotificationPrefsInput } from "@/lib/schemas";
import {
  notificationPreferences,
  notificationsOutbox,
  reminderSnoozes,
  telegramLinks,
  type OutboxItem,
  type TelegramLink,
} from "@/server/db/schema";
import { createLinkCode, getLinkForUser } from "@/server/notifications/linking";
import { cancelPendingForTask, scheduleTaskReminder } from "@/server/notifications/outbox";
import { loadPreferences, type Preferences } from "@/server/notifications/preferences";
import { TASK_ACTIONS, taskTouchKey, type TaskAction } from "@/server/notifications/types";
import { today, type ServiceContext } from "./context";
import { ServiceError } from "./errors";
import { changeTaskDeadline, changeTaskStatus, getTask } from "./tasks";

/**
 * Notification settings and actions for the signed-in founder. Every function acts on
 * ctx.user only: a founder can read or change only their own preferences, link and inbox.
 */

export async function getMyPreferences(ctx: ServiceContext): Promise<Preferences> {
  return loadPreferences(ctx.db, ctx.user.id);
}

export async function updateMyPreferences(ctx: ServiceContext, input: NotificationPrefsInput): Promise<Preferences> {
  const data = notificationPrefsSchema.parse(input);
  await ctx.db
    .insert(notificationPreferences)
    .values({ userId: ctx.user.id, ...data, updatedAt: ctx.now })
    .onConflictDoUpdate({ target: notificationPreferences.userId, set: { ...data, updatedAt: ctx.now } });
  return getMyPreferences(ctx);
}

export async function getMyTelegramLink(ctx: ServiceContext): Promise<TelegramLink | null> {
  return getLinkForUser(ctx.db, ctx.user.id);
}

/** One-time code (shown once, stored hashed, valid 15 minutes). */
export async function createMyTelegramLinkCode(ctx: ServiceContext) {
  return createLinkCode(ctx.db, ctx.user.id, ctx.now);
}

/** Unlinking stops Telegram delivery at once (the dispatcher re-reads the link before each send). */
export async function unlinkMyTelegram(ctx: ServiceContext): Promise<void> {
  await ctx.db.delete(telegramLinks).where(eq(telegramLinks.userId, ctx.user.id));
}

/** The founder's own outbox (dev inbox). Never another founder's. */
export async function listMyNotifications(ctx: ServiceContext, limit = 60): Promise<OutboxItem[]> {
  return ctx.db
    .select()
    .from(notificationsOutbox)
    .where(eq(notificationsOutbox.userId, ctx.user.id))
    .orderBy(desc(notificationsOutbox.createdAt))
    .limit(limit);
}

/** "Snooze 1 day": only the reminders move; the task and its deadline stay as they are. */
export async function snoozeTaskReminder(ctx: ServiceContext, taskId: string): Promise<Date> {
  await getTask(ctx, taskId); // access check as this founder
  const until = new Date(ctx.now.getTime() + 86_400_000);
  await ctx.db
    .insert(reminderSnoozes)
    .values({ userId: ctx.user.id, taskId, snoozedUntil: until })
    .onConflictDoUpdate({ target: [reminderSnoozes.userId, reminderSnoozes.taskId], set: { snoozedUntil: until } });
  await cancelPendingForTask(ctx.db, ctx.user.id, taskId, "snoozed");
  // The reminder takes that day's only push slot for this task: no chase or due-today
  // nudge for it on the day the reminder fires.
  await scheduleTaskReminder(ctx.db, {
    userId: ctx.user.id,
    taskId,
    scheduledFor: until,
    dedupeKey: taskTouchKey(taskId, todayInTimeZone(until, ctx.timeZone)),
  });
  return until;
}

/**
 * Applies a button action as the founder in ctx. Goes through the tasks service, so
 * visibility rules and task_events logging apply exactly as in the app.
 */
export async function applyTaskAction(ctx: ServiceContext, action: TaskAction, taskId: string): Promise<string> {
  if (!(TASK_ACTIONS as readonly string[]).includes(action)) throw new ServiceError("validation", "Unknown action");
  const task = await getTask(ctx, taskId);
  const todayIso = today(ctx);
  switch (action) {
    case "done":
      if (task.status !== "done") await changeTaskStatus(ctx, taskId, "done");
      await cancelPendingForTask(ctx.db, ctx.user.id, taskId, "task_closed");
      return "Marked as done ✓";
    case "snooze_1d":
      await snoozeTaskReminder(ctx, taskId);
      return "Snoozed: next reminder in 24 hours";
    case "move_1d":
    case "move_3d": {
      // Overdue tasks move from today, otherwise from the current deadline.
      const base = task.dueDate && task.dueDate >= todayIso ? task.dueDate : todayIso;
      const next = addDays(base, action === "move_1d" ? 1 : 3);
      await changeTaskDeadline(ctx, taskId, next);
      await cancelPendingForTask(ctx.db, ctx.user.id, taskId, "deadline_moved");
      return `Deadline moved to ${formatDueDate(next, todayIso)} (${next})`;
    }
  }
}

