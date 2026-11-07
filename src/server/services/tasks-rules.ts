/**
 * Pure business rules for tasks. No database, no clock, no "server-only" so they can be
 * unit-tested and reused by the UI for labels.
 *
 * Statuses (0034, Linear's set): Backlog → Todo → In Progress → In Review → Done, or Canceled.
 * - Open = not Done / Canceled. Active = Todo + In Progress + In Review (the list's default view).
 * - Chased (founder pushes and the staff bot) = Todo + In Progress only: Backlog is not planned
 *   yet, In Review waits for a founder.
 *
 * Overdue rule (founders' requirement):
 *   status is open (not done/cancelled) AND due_date < today (in Asia/Bishkek).
 *   It stays overdue until someone moves the deadline or closes the task. Nothing
 *   auto-clears it.
 */
import { addDays, daysBetween, type IsoDate } from "@/lib/dates";
import type { TaskPriority, TaskStatus } from "@/server/db/schema";

export const CLOSED_STATUSES: readonly TaskStatus[] = ["done", "cancelled"];
export const OPEN_STATUSES: readonly TaskStatus[] = ["backlog", "todo", "in_progress", "in_review"];
/** The "Active" view: planned work that is not finished. */
export const ACTIVE_STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "in_review"];
/** Statuses the reminders chase (founders' pushes and the staff bot). */
export const CHASED_STATUSES: readonly TaskStatus[] = ["todo", "in_progress"];
/** Display order of the status groups (Linear's). */
export const STATUS_ORDER: readonly TaskStatus[] = ["in_review", "in_progress", "todo", "backlog", "done", "cancelled"];

export interface DueInfo {
  status: TaskStatus;
  dueDate: IsoDate | null;
}

export function isClosed(status: TaskStatus): boolean {
  return CLOSED_STATUSES.includes(status);
}

export function isChased(status: TaskStatus): boolean {
  return CHASED_STATUSES.includes(status);
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

/**
 * started_at follows In Progress: set when the task enters it, kept while it stays there or moves
 * on (In Review / Done keep when work started), cleared when it goes back to Backlog / Todo.
 */
export function nextStartedAt(prev: { status: TaskStatus; startedAt: Date | null }, nextStatus: TaskStatus, now: Date): Date | null {
  if (nextStatus === "in_progress") return prev.status === "in_progress" && prev.startedAt ? prev.startedAt : now;
  if (nextStatus === "backlog" || nextStatus === "todo") return null;
  return prev.startedAt;
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  cancelled: "Canceled",
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  none: "No priority",
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Sort rank (Linear's: Urgent first, No priority last). */
export const PRIORITY_ORDER: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

/** Old status / priority names (task history, API callers) → the new ones. */
export const LEGACY_STATUS: Record<string, TaskStatus> = { waiting: "in_review", canceled: "cancelled" };
export const LEGACY_PRIORITY: Record<string, TaskPriority> = { normal: "medium" };

/** Estimate points (Fibonacci); 1 point = 1 working hour. */
export const ESTIMATE_POINTS = [1, 2, 3, 5, 8, 13] as const;

export function isEstimate(n: unknown): n is (typeof ESTIMATE_POINTS)[number] {
  return typeof n === "number" && (ESTIMATE_POINTS as readonly number[]).includes(n);
}

/** Sum of estimate points (tasks without an estimate count 0). */
export function sumPoints(list: readonly { estimate: number | null }[]): number {
  return list.reduce((n, t) => n + (t.estimate ?? 0), 0);
}

/** What a person's status change through the bot reads like in the trail ("Sent for review"). */
export function personStatusText(status: unknown): string {
  if (status === "done") return "Marked done";
  if (status === "in_review") return "Sent for review";
  if (status === "in_progress") return "Started (In Progress)";
  const s = String(status);
  return `Marked ${STATUS_LABELS[s as TaskStatus] ?? s}`;
}
