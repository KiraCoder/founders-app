import type { Tone } from "@/components/ui";
import type { TaskPriorityValue, TaskStatusValue } from "@/lib/schemas";

/** Statuses in menu order (Linear's). */
export const STATUS_OPTIONS: readonly { value: TaskStatusValue; label: string }[] = [
  { value: "backlog", label: "Backlog" },
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "In Progress" },
  { value: "in_review", label: "In Review" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Canceled" },
];

/** Priorities in menu order (Linear's). */
export const PRIORITY_OPTIONS: readonly { value: TaskPriorityValue; label: string }[] = [
  { value: "none", label: "No priority" },
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

export const ESTIMATE_OPTIONS = [1, 2, 3, 5, 8, 13] as const;

export const PRIORITY_TONE: Record<string, Tone> = { urgent: "risk", high: "warn", medium: "neutral", low: "neutral", none: "neutral" };
export const STATUS_TONE: Record<string, Tone> = {
  backlog: "neutral",
  todo: "neutral",
  in_progress: "warn",
  in_review: "info",
  done: "ok",
  cancelled: "neutral",
};

export function statusLabel(v: string) {
  return STATUS_OPTIONS.find((o) => o.value === v)?.label ?? (v === "waiting" ? "In Review" : v);
}
export function priorityLabel(v: string) {
  return PRIORITY_OPTIONS.find((o) => o.value === v)?.label ?? (v === "normal" ? "Medium" : v);
}

/** "▲ 5 · 5 h". */
export function estimateLabel(n: number | null): string {
  return n ? `${n} point${n === 1 ? "" : "s"} (${n} h)` : "No estimate";
}

/** Status and priority labels + tones of one task. */
export function labelsFor(t: { status: string; priority: string }) {
  return {
    status: statusLabel(t.status),
    statusTone: STATUS_TONE[t.status] ?? "neutral",
    priority: priorityLabel(t.priority),
    priorityTone: PRIORITY_TONE[t.priority] ?? "neutral",
  };
}
