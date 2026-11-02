/**
 * Builds channel-neutral messages from service-layer data. Pure (no DB, no clock).
 * Everything here is plain text; renderers escape it.
 */
import { daysBetween, formatDueDate, type IsoDate } from "@/lib/dates";
import type { TaskView, TodaySummary } from "@/server/services/tasks";
import {
  TASK_ACTION_LABELS,
  TASK_ACTIONS,
  type MessageLine,
  type NeutralMessage,
  type NotificationKind,
} from "./types";

const MAX_PER_SECTION = 8;

export function taskLine(t: Pick<TaskView, "title" | "dueDate" | "company" | "priority" | "visibility">, today: IsoDate): string {
  const bits: string[] = [];
  if (t.company) bits.push(t.company.name);
  else if (t.visibility === "private") bits.push("personal");
  if (t.dueDate) {
    const diff = daysBetween(t.dueDate, today);
    bits.push(diff > 0 ? `${diff}d overdue` : formatDueDate(t.dueDate, today));
  }
  if (t.priority === "urgent" || t.priority === "high") bits.push(t.priority);
  return bits.length ? `${t.title} — ${bits.join(" · ")}` : t.title;
}

function section(heading: string, items: TaskView[], today: IsoDate): MessageLine[] {
  if (!items.length) return [];
  const lines: MessageLine[] = [{ text: `${heading} (${items.length})`, style: "heading" }];
  for (const t of items.slice(0, MAX_PER_SECTION)) lines.push({ text: taskLine(t, today), style: "item" });
  if (items.length > MAX_PER_SECTION) lines.push({ text: `+${items.length - MAX_PER_SECTION} more in the app`, style: "muted" });
  return lines;
}

function parkedSection(parked: string[]): MessageLine[] {
  if (!parked.length) return [];
  return [
    { text: `Parked reminders (${parked.length})`, style: "heading" },
    ...parked.slice(0, MAX_PER_SECTION).map((text) => ({ text, style: "item" as const })),
    ...(parked.length > MAX_PER_SECTION ? [{ text: `+${parked.length - MAX_PER_SECTION} more`, style: "muted" as const }] : []),
  ];
}

/** Max item lines of the "Numbers waiting" section (anti-spam: a short hint, not a list). */
export const NUMBERS_WAITING_MAX_LINES = 3;

export interface WaitingNumber {
  companyName: string;
  label: string;
}

/**
 * "Numbers waiting": metrics whose data is overdue, grouped per company, at most
 * NUMBERS_WAITING_MAX_LINES item lines. Company data is shared, so both founders see it.
 */
export function numbersWaitingSection(items: readonly WaitingNumber[]): MessageLine[] {
  if (!items.length) return [];
  const byCompany = new Map<string, string[]>();
  for (const it of items) byCompany.set(it.companyName, [...(byCompany.get(it.companyName) ?? []), it.label]);
  const groups = [...byCompany.entries()];
  const max = NUMBERS_WAITING_MAX_LINES;
  const shown = groups.length > max ? groups.slice(0, max - 1) : groups;
  const lines: MessageLine[] = [{ text: `Numbers waiting (${items.length})`, style: "heading" }];
  for (const [company, labels] of shown) {
    const names = labels.slice(0, 2).join(", ");
    lines.push({ text: `${company}: ${names}${labels.length > 2 ? ` +${labels.length - 2} more` : ""}`, style: "item" });
  }
  if (groups.length > shown.length) {
    const rest = groups.slice(shown.length);
    const count = rest.reduce((n, [, l]) => n + l.length, 0);
    lines.push({ text: `+${count} more in ${rest.length} other companies — enter or upload them in the app`, style: "muted" });
  }
  return lines;
}

/** Morning summary: overdue, due today, this week, personal todos, parked items, numbers waiting. */
export function buildMorningSummary(
  s: TodaySummary,
  parked: string[],
  firstName: string,
  numbersWaiting: readonly WaitingNumber[] = [],
): NeutralMessage {
  const listed = new Set([...s.overdue, ...s.dueToday, ...s.thisWeek].map((t) => t.id));
  const personalRest = s.personal.filter((t) => !listed.has(t.id));
  const lines: MessageLine[] = [
    {
      text: `${s.overdue.length} overdue · ${s.dueToday.length} due today · ${s.thisWeek.length} this week`,
      style: "text",
    },
    ...section("Overdue", s.overdue, s.today),
    ...section("Due today", s.dueToday, s.today),
    ...section("Due this week", s.thisWeek, s.today),
    ...section("My personal todos", personalRest, s.today),
    ...parkedSection(parked),
  ];
  if (lines.length === 1) lines.push({ text: "Nothing on your plate today.", style: "muted" });
  lines.push(...numbersWaitingSection(numbersWaiting));
  return { title: `Good morning, ${firstName}`, lines };
}

/** Evening check: what is still open today. Null when there is nothing to say. */
export function buildEveningCheck(s: TodaySummary, parked: string[]): NeutralMessage | null {
  if (!s.dueToday.length && !s.overdue.length && !parked.length) return null;
  const lines: MessageLine[] = [
    ...section("Still open today", s.dueToday, s.today),
    ...(s.overdue.length ? [{ text: `${s.overdue.length} overdue task(s) still waiting for a new deadline.`, style: "text" as const }] : []),
    ...parkedSection(parked),
    { text: "Close what is done or move the deadline in the app.", style: "muted" },
  ];
  return { title: "Evening check", lines };
}

/** A single-task push with Done / Snooze / Move buttons. */
export function buildTaskMessage(kind: NotificationKind, task: TaskView, today: IsoDate): NeutralMessage {
  const overdueDays = task.dueDate ? daysBetween(task.dueDate, today) : 0;
  const title =
    kind === "overdue_chase"
      ? `Overdue ${overdueDays} day${overdueDays === 1 ? "" : "s"}`
      : kind === "task_due_today"
        ? "Due today"
        : kind === "urgent"
          ? "Urgent"
          : "Reminder";
  const lines: MessageLine[] = [{ text: task.title, style: "text" }];
  const meta: string[] = [];
  if (task.company) meta.push(task.company.name);
  if (task.project) meta.push(task.project.name);
  if (task.visibility === "private") meta.push("personal todo");
  if (meta.length) lines.push({ text: meta.join(" · "), style: "muted" });
  if (task.dueDate) lines.push({ text: `Deadline: ${formatDueDate(task.dueDate, today)} (${task.dueDate})`, style: "text" });
  if (task.priority !== "normal") lines.push({ text: `Priority: ${task.priority}`, style: "text" });
  return {
    title,
    lines,
    actions: TASK_ACTIONS.map((action) => ({ action, taskId: task.id, label: TASK_ACTION_LABELS[action] })),
  };
}

/**
 * One line for a parked item inside a summary, rendered at bundle time from the task's
 * CURRENT state (so "3d overdue" is never stale and a moved deadline shows its new date).
 */
export function parkedLine(
  task: Pick<TaskView, "title" | "dueDate" | "company" | "priority" | "visibility">,
  today: IsoDate,
): string {
  const prefix = task.dueDate && task.dueDate < today ? "Overdue" : task.dueDate === today ? "Due today" : "Reminder";
  return `${prefix}: ${taskLine(task, today)}`;
}

export function buildTasksList(s: TodaySummary): NeutralMessage {
  const lines = [
    ...section("Overdue", s.overdue, s.today),
    ...section("Due today", s.dueToday, s.today),
    ...section("Due this week", s.thisWeek, s.today),
    ...section("My personal todos", s.personal, s.today),
  ];
  return { title: "Your open tasks", lines: lines.length ? lines : [{ text: "No open tasks. Nice.", style: "muted" }] };
}

export function buildHelp(): NeutralMessage {
  return {
    title: "Founder Cockpit bot",
    lines: [
      { text: "/today — your summary for today", style: "text" },
      { text: "/tasks — your open tasks", style: "text" },
      { text: "/help — this message", style: "text" },
      { text: "Buttons under reminders: Done, Snooze 1 day, move the deadline.", style: "muted" },
    ],
  };
}

export function buildNotLinked(): NeutralMessage {
  return {
    title: "This chat is not linked",
    lines: [
      { text: "Hello! This bot only talks to the Founder Cockpit founders.", style: "text" },
      { text: "If that is you: open Settings in the app, generate a link code and send /start CODE here.", style: "muted" },
    ],
  };
}
