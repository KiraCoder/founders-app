import type { Tone } from "@/components/ui";

export const STATUS_OPTIONS = [
  { value: "todo", label: "To do" },
  { value: "in_progress", label: "In progress" },
  { value: "waiting", label: "Waiting" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
] as const;

export const PRIORITY_OPTIONS = [
  { value: "urgent", label: "Urgent" },
  { value: "high", label: "High" },
  { value: "normal", label: "Normal" },
  { value: "low", label: "Low" },
] as const;

export const PRIORITY_TONE: Record<string, Tone> = { urgent: "risk", high: "warn", normal: "neutral", low: "neutral" };
export const STATUS_TONE: Record<string, Tone> = {
  todo: "neutral",
  in_progress: "info",
  waiting: "warn",
  done: "ok",
  cancelled: "neutral",
};

export function statusLabel(v: string) {
  return STATUS_OPTIONS.find((o) => o.value === v)?.label ?? v;
}
export function priorityLabel(v: string) {
  return PRIORITY_OPTIONS.find((o) => o.value === v)?.label ?? v;
}
