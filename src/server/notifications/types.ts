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
  /** An AI role's report is ready (one per run per founder; uses the normal daily budget). */
  "ai_report_ready",
  /**
   * Staff on Telegram (0028). To a founder: a person's answer, an escalation or a deadline request
   * (a line in the next summary, or a push when urgent / it needs a tap).
   */
  "staff_update",
  /** To a person (staff): a task was assigned to them, a chase, their morning list, an info line. */
  "staff_new_task",
  "staff_chase",
  "staff_morning_list",
  "staff_info",
  /** To a person: their task changed after it was sent (new checklist items, deadline, title) — one updated card (0032). */
  "staff_task_update",
  /** Routines (0029): the ask / a reminder about today's run, to the person (staff) … */
  "staff_routine",
  /** … or to the founder the routine is assigned to (normal founder rules: budget, quiet hours). */
  "routine_reminder",
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
  ai_report_ready: "AI report ready",
  staff_update: "Team update",
  staff_new_task: "Staff · new task",
  staff_chase: "Staff · reminder",
  staff_morning_list: "Staff · morning list",
  staff_info: "Staff · info",
  staff_task_update: "Staff · task updated",
  staff_routine: "Staff · routine",
  routine_reminder: "Routine",
};

/** Kinds that go to a person (people row) instead of a founder. */
export const PERSON_KINDS = ["staff_new_task", "staff_chase", "staff_morning_list", "staff_info", "staff_routine", "staff_task_update"] as const;
export type PersonKind = (typeof PERSON_KINDS)[number];

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
  /**
   * What this line stands for (parked outbox items, holding ask items, AI data requests),
   * so the dispatcher marks them shown/bundled only when the line made it into the text.
   * Built with parkedRef / holdingRef / aiRequestRef.
   */
  refs?: string[];
}

export const parkedRef = (outboxId: string) => `p:${outboxId}`;
export const holdingRef = (askItemId: string) => `h:${askItemId}`;
export const aiRequestRef = (requestId: string) => `ai:${requestId}`;
/** A task listed in a grouped overdue push (its buttons go when its line is cut). */
export const taskRef = (taskId: string) => `t:${taskId}`;

/** Actions on holding items: "I asked Elmurat" marks the item's months as requested. */
export const HOLDING_ACTIONS = ["holding_asked"] as const;
export type HoldingAction = (typeof HOLDING_ACTIONS)[number];

/**
 * Buttons a person (staff) gets under task messages. Russian labels in messages-ru.ts.
 * staff_move opens the choice of +1 / +3 / +7 days; staff_comment_pick attaches a free-text
 * message (kept server-side in the token's payload) to the task the person picked.
 */
export const STAFF_ACTIONS = [
  "staff_accept",
  "staff_done",
  "staff_help",
  "staff_move",
  "staff_move_1d",
  "staff_move_3d",
  "staff_move_7d",
  "staff_comment_pick",
  /** «💬 Комментарий»: the person's next text becomes a comment on the task (0032). */
  "staff_comment",
  /** Tick one checklist item (`item` = its id, 0032). */
  "staff_check",
] as const;
export type StaffAction = (typeof STAFF_ACTIONS)[number];

/**
 * Routine buttons: tick one checklist item (`item` = its key) or the whole run («✅ Готово» /
 * «✅ Всё готово»); «💬 Комментарий» / «🟡 Частично» / «❌ Не могу» (routine_comment / _partly /
 * _cant: on a checklist they first offer a pick of the item, routine_pick with payload.kind; the
 * next text message is the comment); routine_back closes the pick.
 */
export const ROUTINE_ACTIONS = ["routine_tick", "routine_done", "routine_comment", "routine_partly", "routine_cant", "routine_pick", "routine_back"] as const;
export type RoutineAction = (typeof ROUTINE_ACTIONS)[number];

/** A founder's one tap on a person's "Перенести срок" request. */
export const DEADLINE_ACTIONS = ["deadline_approve", "deadline_decline"] as const;
export type DeadlineAction = (typeof DEADLINE_ACTIONS)[number];

/** A button: on a task (taskId), on a holding ask item (askId) or on a deadline request (requestId). */
export type MessageAction =
  | {
      label: string;
      action: TaskAction | StaffAction;
      taskId: string;
      askId?: undefined;
      requestId?: undefined;
      runId?: undefined;
      row?: number;
      /** Checklist item id (staff_check); part of the button's key. */
      item?: string;
      /** Server-side data stored with the button's token (never sent to Telegram). */
      payload?: Record<string, unknown>;
    }
  | { label: string; action: HoldingAction; askId: string; taskId?: undefined; requestId?: undefined; runId?: undefined; row?: number; payload?: undefined }
  | {
      label: string;
      action: DeadlineAction;
      requestId: string;
      taskId?: undefined;
      askId?: undefined;
      runId?: undefined;
      row?: number;
      payload?: undefined;
    }
  | {
      label: string;
      action: RoutineAction;
      runId: string;
      /** Checklist item key (routine_tick, routine_pick; "_all" = the whole run). */
      item?: string;
      taskId?: undefined;
      askId?: undefined;
      requestId?: undefined;
      row?: number;
      /** routine_pick: { kind: "comment" | "partly" | "cant" }. */
      payload?: Record<string, unknown>;
    };
// `row`: buttons with the same row number share one keyboard row (the grouped overdue push puts
// each task's buttons on its own row). Without it, buttons go two per row.

/** What every channel receives. Plain text only: renderers do the escaping. */
export interface NeutralMessage {
  title: string;
  lines: MessageLine[];
  actions?: MessageAction[];
}

export interface Recipient {
  /** The recipient's id: users.id for a founder, people.id for a person (then `personId` is set too). */
  userId: string;
  personId?: string | null;
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
export function actionKey(a: { action: string; taskId?: string; askId?: string; requestId?: string; runId?: string; item?: string }): string {
  const base = `${a.action}:${a.taskId ?? a.askId ?? a.requestId ?? a.runId}`;
  return a.item ? `${base}:${a.item}` : base;
}

/**
 * One push per task per founder per local day (YYYY-MM-DD in APP_TIMEZONE), whatever its
 * kind (due-today nudge, overdue chase, snooze reminder). Every task push uses this as its
 * dedupe key, so the unique (user_id, dedupe_key) index refuses a second one that day.
 */
export function taskTouchKey(taskId: string, localDay: string): string {
  return `touch:${taskId}:${localDay}`;
}
