/**
 * Pure business rules for tasks. No database, no clock, no "server-only" so they can be
 * unit-tested and reused by the UI for labels.
 *
 * Overdue rule (founders' requirement):
 *   status is not done/cancelled AND due_date < today (in Asia/Bishkek).
 *   It stays overdue until someone moves the deadline or closes the task. Nothing
 *   auto-clears it.
 */
import { addDays, daysBetween, type IsoDate } from "@/lib/dates";
import type { TaskStatus } from "@/server/db/schema";

export const CLOSED_STATUSES: readonly TaskStatus[] = ["done", "cancelled"];
export const OPEN_STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "waiting"];

export interface DueInfo {
  status: TaskStatus;
  dueDate: IsoDate | null;
}

export function isClosed(status: TaskStatus): boolean {
  return CLOSED_STATUSES.includes(status);
}

export function isOverdue(task: DueInfo, today: IsoDate): boolean {
  return !isClosed(task.status) && task.dueDate !== null && task.dueDate < today;
}

export function daysOverdue(task: DueInfo, today: IsoDate): number {
  return isOverdue(task, today) && task.dueDate ? daysBetween(task.dueDate, today) : 0;
}

export type DueBucket = "closed" | "overdue" | "today" | "this_week" | "later" | "no_date";

/** "this_week" = due tomorrow through the next 7 days. */
export function dueBucket(task: DueInfo, today: IsoDate): DueBucket {
  if (isClosed(task.status)) return "closed";
  if (!task.dueDate) return "no_date";
  if (task.dueDate < today) return "overdue";
  if (task.dueDate === today) return "today";
  if (task.dueDate <= addDays(today, 7)) return "this_week";
  return "later";
}

/** Range used by the Today page for "Due this week" (tomorrow … today+7). */
export function thisWeekRange(today: IsoDate): { from: IsoDate; to: IsoDate } {
  return { from: addDays(today, 1), to: addDays(today, 7) };
}


/**
 * completed_at follows status: set when a task moves into "done", cleared when it is
 * reopened, kept when it stays done.
 */
export function nextCompletedAt(
  prev: { status: TaskStatus; completedAt: Date | null },
  nextStatus: TaskStatus,
  now: Date,
): Date | null {
  if (nextStatus === "done") return prev.status === "done" ? prev.completedAt : now;
  return null;
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  waiting: "Waiting",
  done: "Done",
  cancelled: "Cancelled",
};

export const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
