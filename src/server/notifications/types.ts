/**
 * Channel-neutral notification types. A message is built once (title, lines, actions)
 * and each channel renders it its own way (Telegram HTML now, iOS push later).
 * No "server-only" and no side effects: shared by the renderer, tests and the dev inbox UI.
 */

export const CHANNEL_NAMES = ["telegram", "dev", "push"] as const;
export type ChannelName = (typeof CHANNEL_NAMES)[number];

/** Notification kinds. Summary kinds have their own daily slots; the rest share the budget. */
export const NOTIFICATION_KINDS = [
  "morning_summary",
  "evening_check",
  "task_due_today",
  "overdue_chase",
  "task_reminder",
  "urgent",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const SUMMARY_KINDS: readonly NotificationKind[] = ["morning_summary", "evening_check"];
export const TASK_KINDS: readonly NotificationKind[] = ["task_due_today", "overdue_chase", "task_reminder", "urgent"];

export function isSummaryKind(kind: string): boolean {
  return (SUMMARY_KINDS as readonly string[]).includes(kind);
}

export const KIND_LABELS: Record<NotificationKind, string> = {
  morning_summary: "Morning summary",
  evening_check: "Evening check",
  task_due_today: "Due today",
  overdue_chase: "Overdue chase",
  task_reminder: "Reminder",
  urgent: "Urgent",
};

/** Actions a founder can take straight from a task notification. */
export const TASK_ACTIONS = ["done", "snooze_1d", "move_1d", "move_3d"] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

export const TASK_ACTION_LABELS: Record<TaskAction, string> = {
  done: "Done",
  snooze_1d: "Snooze 1 day",
  move_1d: "Deadline +1 day",
  move_3d: "Deadline +3 days",
};

export type LineStyle = "heading" | "item" | "text" | "muted";

export interface MessageLine {
  text: string;
  style?: LineStyle;
}

/** Actions on holding items: "I asked Elmurat" marks the item's months as requested. */
export const HOLDING_ACTIONS = ["holding_asked"] as const;
export type HoldingAction = (typeof HOLDING_ACTIONS)[number];

/** A button: on a task (taskId) or on a holding ask item (askId). */
export type MessageAction =
  | { label: string; action: TaskAction; taskId: string; askId?: undefined }
  | { label: string; action: HoldingAction; askId: string; taskId?: undefined };

/** What every channel receives. Plain text only: renderers do the escaping. */
export interface NeutralMessage {
  title: string;
  lines: MessageLine[];
  actions?: MessageAction[];
}

export interface Recipient {
  userId: string;
  /** Telegram private chat id when linked. */
  telegramChatId?: string | null;
}

export interface SendResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
  /** True when retrying makes no sense (e.g. chat blocked the bot). */
  permanent?: boolean;
}

/** Callback data per action, minted by the dispatcher (server-side tokens). */
export type ActionCallbacks = Partial<Record<string, string>>;

export interface NotificationChannel {
  readonly name: ChannelName;
  send(recipient: Recipient, message: NeutralMessage, callbacks?: ActionCallbacks): Promise<SendResult>;
}

/** Key used in ActionCallbacks for one button. */
export function actionKey(a: { action: string; taskId?: string; askId?: string }): string {
  return `${a.action}:${a.taskId ?? a.askId}`;
}

/**
 * One push per task per founder per local day (YYYY-MM-DD in APP_TIMEZONE), whatever its
 * kind (due-today nudge, overdue chase, snooze reminder). Every task push uses this as its
 * dedupe key, so the unique (user_id, dedupe_key) index refuses a second one that day.
 */
export function taskTouchKey(taskId: string, localDay: string): string {
  return `touch:${taskId}:${localDay}`;
}
