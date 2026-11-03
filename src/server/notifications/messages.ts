/**
 * Builds channel-neutral messages from service-layer data. Pure (no DB, no clock).
 * Everything here is plain text; renderers escape it.
 */
import { daysBetween, formatDueDate, isoWeekday, type IsoDate } from "@/lib/dates";
import type { TaskView, TodaySummary } from "@/server/services/tasks";
import { renderedLineLength, renderTelegramTitleLength, TELEGRAM_MAX_TEXT } from "./render-telegram";
import {
  TASK_ACTION_LABELS,
  TASK_ACTIONS,
  type MessageAction,
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
const MORE_IN_APP = (n: number) => `+${n} more — open the app`;

/**
 * Room for the morning summary's text, a little under Telegram's 4096 characters. Action items
 * (Holding, AI requests), parked items and "Numbers waiting" are always kept; the task
 * sections share what is left and end with "+N more — open the app" when it runs out.
 */
export const SUMMARY_TEXT_BUDGET = TELEGRAM_MAX_TEXT - 64;

/** A parked item for a summary: its line, the outbox rows it stands for, and its task. */
export interface ParkedItem {
  text: string;
  /** parkedRef(outboxId) of every parked row this line covers. */
  refs?: string[];
  taskId?: string | null;
}

type TaskLike = Pick<TaskView, "id" | "title" | "dueDate" | "company" | "priority" | "visibility">;

function cost(lines: readonly MessageLine[]): number {
  return lines.reduce((n, l) => n + renderedLineLength(l), 0);
}

/**
 * A task section. With a `budget` (characters), items are added while they fit and the rest
 * becomes "+N more — open the app"; `taskLines` records the line of each task shown.
 */
function section(
  heading: string,
  items: readonly TaskLike[],
  today: IsoDate,
  opts: { budget?: { left: number }; taskLines?: Map<string, MessageLine> } = {},
): MessageLine[] {
  if (!items.length) return [];
  const head: MessageLine = { text: `${heading} (${items.length})`, style: "heading" };
  const lines: MessageLine[] = [head];
  const budget = opts.budget;
  const moreCost = renderedLineLength({ text: MORE_IN_APP(items.length), style: "muted" });
  let left = budget ? budget.left - renderedLineLength(head) : Infinity;
  let shown = 0;
  for (const t of items.slice(0, MAX_PER_SECTION)) {
    const line: MessageLine = { text: taskLine(t, today), style: "item" };
    const len = renderedLineLength(line);
    const isLast = shown === items.length - 1;
    if (len + (isLast ? 0 : moreCost) > left) break;
    left -= len;
    lines.push(line);
    opts.taskLines?.set(t.id, line);
    shown++;
  }
  if (shown < items.length) {
    const more: MessageLine = { text: MORE_IN_APP(items.length - shown), style: "muted" };
    lines.push(more);
    left -= renderedLineLength(more);
  }
  if (budget) budget.left = left;
  return lines;
}

function toParked(p: string | ParkedItem): ParkedItem {
  return typeof p === "string" ? { text: p } : p;
}

/**
 * "Parked reminders", minus tasks already listed in a section of the same message: their
 * parked rows are attached to that task's line instead (bundled only if that line is shown).
 */
function parkedSection(parked: readonly ParkedItem[], taskLines?: Map<string, MessageLine>): MessageLine[] {
  const rest: ParkedItem[] = [];
  for (const p of parked) {
    const line = p.taskId ? taskLines?.get(p.taskId) : undefined;
    if (line) line.refs = [...(line.refs ?? []), ...(p.refs ?? [])];
    else rest.push(p);
  }
  if (!rest.length) return [];
  return [
    { text: `Parked reminders (${rest.length})`, style: "heading" },
    ...rest.slice(0, MAX_PER_SECTION).map((p) => ({ text: p.text, style: "item" as const, ...(p.refs?.length ? { refs: p.refs } : {}) })),
    ...(rest.length > MAX_PER_SECTION ? [{ text: `+${rest.length - MAX_PER_SECTION} more`, style: "muted" as const }] : []),
  ];
}

/** Max item lines for late numbers in the "Numbers waiting" section (anti-spam: a short hint, not a list). */
export const NUMBERS_WAITING_MAX_LINES = 3;

export interface WaitingNumber {
  companyName: string;
  label: string;
  /** Had at least one value (it is late). Default true. */
  hasData?: boolean;
  /** Expected from a data source that is not set up yet: its short reason ("Edil's APIs"). */
  awaitingSource?: string | null;
}

/**
 * "Numbers waiting" in the morning summary (company data is shared, so both founders see it):
 * - numbers that had data and are late: every day, grouped per company, at most
 *   NUMBERS_WAITING_MAX_LINES item lines;
 * - on Mondays only (Asia/Bishkek): ONE line for numbers that never had a value, and ONE
 *   line for numbers that wait for a data source that is not set up yet
 *   ("18 numbers wait for data sources (Edil's APIs, WB token)"). Nagging about those
 *   every day would only teach the founders to ignore the section.
 */
export function numbersWaitingSection(items: readonly WaitingNumber[], today?: IsoDate): MessageLine[] {
  const monday = today ? isoWeekday(today) === 1 : true;
  const late = items.filter((i) => !i.awaitingSource && i.hasData !== false);
  const never = monday ? items.filter((i) => !i.awaitingSource && i.hasData === false) : [];
  const awaiting = monday ? items.filter((i) => i.awaitingSource) : [];
  if (!late.length && !never.length && !awaiting.length) return [];

  const lines: MessageLine[] = [{ text: `Numbers waiting (${late.length + never.length + awaiting.length})`, style: "heading" }];
  if (late.length) {
    const byCompany = new Map<string, string[]>();
    for (const it of late) byCompany.set(it.companyName, [...(byCompany.get(it.companyName) ?? []), it.label]);
    const groups = [...byCompany.entries()];
    const max = NUMBERS_WAITING_MAX_LINES;
    const shown = groups.length > max ? groups.slice(0, max - 1) : groups;
    for (const [company, labels] of shown) {
      const names = labels.slice(0, 2).join(", ");
      lines.push({ text: `${company}: ${names}${labels.length > 2 ? ` +${labels.length - 2} more` : ""}`, style: "item" });
    }
    if (groups.length > shown.length) {
      const rest = groups.slice(shown.length);
      const count = rest.reduce((n, [, l]) => n + l.length, 0);
      lines.push({ text: `+${count} more in ${rest.length} other companies — enter or upload them in the app`, style: "muted" });
    }
  }
  if (never.length) {
    const names = never.slice(0, 2).map((i) => `${i.label} (${i.companyName})`).join(", ");
    lines.push({
      text: `Never entered yet: ${names}${never.length > 2 ? ` +${never.length - 2} more` : ""}`,
      style: "muted",
    });
  }
  if (awaiting.length) {
    const reasons = [...new Set(awaiting.map((i) => i.awaitingSource!))].join(", ");
    lines.push({
      text: `${awaiting.length} number${awaiting.length === 1 ? "" : "s"} wait${awaiting.length === 1 ? "s" : ""} for data sources (${reasons})`,
      style: "muted",
    });
  }
  return lines;
}

/**
 * Morning summary. Order: counts, then the ACTION items (Holding ask, AI role requests) so
 * they can never be cut off, then the task sections (sharing a character budget), parked
 * items (minus tasks already listed above) and "Numbers waiting".
 */
export function buildMorningSummary(
  s: TodaySummary,
  parked: readonly (string | ParkedItem)[],
  firstName: string,
  numbersWaiting: readonly WaitingNumber[] = [],
  holding: { lines: MessageLine[]; actions: MessageAction[] } | null = null,
  aiLines: readonly MessageLine[] = [],
): NeutralMessage {
  const listed = new Set([...s.overdue, ...s.dueToday, ...s.thisWeek].map((t) => t.id));
  const personalRest = s.personal.filter((t) => !listed.has(t.id));
  const parkedItems = parked.map(toParked);
  const title = `Good morning, ${firstName}`;
  const header: MessageLine = {
    text: `${s.overdue.length} overdue · ${s.dueToday.length} due today · ${s.thisWeek.length} this week`,
    style: "text",
  };
  const actionLines: MessageLine[] = [...(holding?.lines ?? []), ...aiLines];
  const numbers = numbersWaitingSection(numbersWaiting, s.today);
  const hasTasks = s.overdue.length + s.dueToday.length + s.thisWeek.length + personalRest.length > 0;
  const nothing: MessageLine[] = !hasTasks && !parkedItems.length ? [{ text: "Nothing on your plate today.", style: "muted" }] : [];
  // Everything except the task sections is kept whole; parked is counted before de-duplication
  // (it can only get shorter).
  const fixed =
    renderTelegramTitleLength(title) + cost([header, ...actionLines, ...nothing, ...numbers]) + cost(parkedSection(parkedItems));
  const budget = { left: SUMMARY_TEXT_BUDGET - fixed };
  const taskLines = new Map<string, MessageLine>();
  const opts = { budget, taskLines };
  const tasks = [
    ...section("Overdue", s.overdue, s.today, opts),
    ...section("Due today", s.dueToday, s.today, opts),
    ...section("Due this week", s.thisWeek, s.today, opts),
    ...section("My personal todos", personalRest, s.today, opts),
  ];
  const lines: MessageLine[] = [header, ...nothing, ...actionLines, ...tasks, ...parkedSection(parkedItems, taskLines), ...numbers];
  return {
    title,
    lines,
    ...(holding?.actions.length ? { actions: holding.actions } : {}),
  };
}

/**
 * Evening check: what is still open today. Sent only when something due today is still open
 * or parked items are waiting that no summary listed yet; overdue tasks alone (already in
 * the morning summary) are no reason to message again. Null when there is nothing to say.
 */
export function buildEveningCheck(s: TodaySummary, parked: readonly (string | ParkedItem)[]): NeutralMessage | null {
  const parkedItems = parked.map(toParked);
  if (!s.dueToday.length && !s.overdue.length && !parkedItems.length) return null;
  const taskLines = new Map<string, MessageLine>();
  const lines: MessageLine[] = [
    ...section("Still open today", s.dueToday, s.today, { taskLines }),
    ...(s.overdue.length ? [{ text: `${s.overdue.length} overdue task(s) still waiting for a new deadline.`, style: "text" as const }] : []),
    ...parkedSection(parkedItems, taskLines),
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
  const title = "Your open tasks";
  const opts = { budget: { left: SUMMARY_TEXT_BUDGET - renderTelegramTitleLength(title) } };
  const lines = [
    ...section("Overdue", s.overdue, s.today, opts),
    ...section("Due today", s.dueToday, s.today, opts),
    ...section("Due this week", s.thisWeek, s.today, opts),
    ...section("My personal todos", s.personal, s.today, opts),
  ];
  return { title, lines: lines.length ? lines : [{ text: "No open tasks. Nice.", style: "muted" }] };
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
