/**
 * Russian messages for staff on Telegram (people, not founders). Pure: no DB, no clock.
 * Founder-facing text stays English (messages.ts). Plain text only; renderers escape it.
 */
import { daysBetween, type IsoDate } from "@/lib/dates";
import { renderedLineLength, renderTelegramTitleLength } from "./render-telegram";
import { SUMMARY_TEXT_BUDGET } from "./messages";
import { taskRef, type MessageAction, type MessageLine, type NeutralMessage, type StaffAction } from "./types";

/** What a staff message shows about a task: nothing private (no notes, no owner, no other people). */
export interface StaffTaskLite {
  id: string;
  title: string;
  dueDate: IsoDate | null;
  priority: "urgent" | "high" | "normal" | "low";
  companyName: string | null;
}

export const STAFF_ACTION_LABELS: Record<StaffAction, string> = {
  staff_accept: "Принято",
  staff_done: "Готово",
  staff_help: "Нужна помощь",
  staff_move: "Перенести срок",
  staff_move_1d: "+1 день",
  staff_move_3d: "+3 дня",
  staff_move_7d: "+7 дней",
  staff_comment_pick: "Выбрать",
};

export const MOVE_DAYS: Record<"staff_move_1d" | "staff_move_3d" | "staff_move_7d", number> = {
  staff_move_1d: 1,
  staff_move_3d: 3,
  staff_move_7d: 7,
};

/** "2026-11-12" → "12.11". */
export function ruDate(iso: IsoDate): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
}

/** "Срок: сегодня" / "Срок: 12.11" / "Просрочено на 3 дн. (срок был 09.11)". */
export function ruDue(due: IsoDate | null, today: IsoDate): string {
  if (!due) return "Срок: не указан";
  const late = daysBetween(due, today);
  if (late > 0) return `Просрочено на ${late} дн. (срок был ${ruDate(due)})`;
  if (late === 0) return "Срок: сегодня";
  if (late === -1) return `Срок: завтра, ${ruDate(due)}`;
  return `Срок: ${ruDate(due)}`;
}

function metaLine(t: StaffTaskLite, today: IsoDate): string {
  const bits = [ruDue(t.dueDate, today)];
  if (t.companyName) bits.push(`Компания: ${t.companyName}`);
  if (t.priority === "urgent") bits.push("Срочно");
  else if (t.priority === "high") bits.push("Важно");
  return bits.join(" · ");
}

/** Принято / Готово / Нужна помощь / Перенести срок under a task message. */
export function staffTaskButtons(taskId: string, withAccept = true): MessageAction[] {
  const actions: StaffAction[] = withAccept
    ? ["staff_accept", "staff_done", "staff_help", "staff_move"]
    : ["staff_done", "staff_help", "staff_move"];
  return actions.map((action) => ({ action, taskId, label: STAFF_ACTION_LABELS[action] }));
}

export function buildStaffNewTask(t: StaffTaskLite, today: IsoDate): NeutralMessage {
  return {
    title: `Новая задача: ${t.title}`,
    lines: [
      { text: metaLine(t, today), style: "text" },
      { text: "Нажмите «Принято», когда увидели, и «Готово», когда сделали. Можно ответить текстом на это сообщение.", style: "muted" },
    ],
    actions: staffTaskButtons(t.id),
  };
}

export function buildStaffChase(t: StaffTaskLite, today: IsoDate): NeutralMessage {
  const late = t.dueDate ? daysBetween(t.dueDate, today) : 0;
  return {
    title: late > 0 ? `Задача просрочена: ${t.title}` : `Напоминание: ${t.title}`,
    lines: [
      { text: metaLine(t, today), style: "text" },
      { text: "Если уже сделано — нажмите «Готово». Нужна помощь или другой срок — кнопки ниже.", style: "muted" },
    ],
    actions: staffTaskButtons(t.id, false),
  };
}

/** At most this many tasks (with buttons) in one grouped staff chase; the rest: «…и ещё N — /tasks». */
export const MAX_STAFF_GROUPED_TASKS = 8;

/**
 * Grouped chase (one message per person per slot): one task → the single-task reminder; several →
 * a numbered list with a keyboard row per task («1 · Готово», «1 · Помощь», «1 · Срок»). Lines are
 * listed only while they fit Telegram's limit (the footer and «…и ещё N» always stay); a task not
 * listed has no buttons and does not count as chased. `listed` = the ids in the message.
 */
export function buildStaffGroupedChase(tasks: readonly StaffTaskLite[], today: IsoDate): { message: NeutralMessage; listed: string[] } {
  if (tasks.length === 1) return { message: buildStaffChase(tasks[0]!, today), listed: [tasks[0]!.id] };
  const n = tasks.length;
  const late = tasks.some((t) => t.dueDate && daysBetween(t.dueDate, today) > 0);
  const title = late ? `Напоминание: ${n} задач(и) ждут ответа, есть просроченные` : `Напоминание: ${n} задач(и) на сегодня`;
  const footer: MessageLine = { text: "Нажмите «Готово» у выполненной задачи. Нужна помощь или другой срок — кнопки ниже.", style: "muted" };
  const more = (k: number): MessageLine => ({ text: `…и ещё ${k} — /tasks`, style: "muted" });
  let left = SUMMARY_TEXT_BUDGET - renderTelegramTitleLength(title) - renderedLineLength(footer);
  const lines: MessageLine[] = [];
  const shown: StaffTaskLite[] = [];
  for (const t of tasks.slice(0, MAX_STAFF_GROUPED_TASKS)) {
    const line: MessageLine = { text: `${shown.length + 1}. ${t.title} — ${metaLine(t, today)}`, style: "text", refs: [taskRef(t.id)] };
    const len = renderedLineLength(line);
    const isLast = shown.length === n - 1;
    if (len + (isLast ? 0 : renderedLineLength(more(n))) > left) break;
    left -= len;
    lines.push(line);
    shown.push(t);
  }
  if (n > shown.length) lines.push(more(n - shown.length));
  lines.push(footer);
  const actions: MessageAction[] = shown.flatMap((t, i) => [
    { action: "staff_done" as const, taskId: t.id, label: `${i + 1} · Готово`, row: i },
    { action: "staff_help" as const, taskId: t.id, label: `${i + 1} · Помощь`, row: i },
    { action: "staff_move" as const, taskId: t.id, label: `${i + 1} · Срок`, row: i },
  ]);
  return { message: { title, lines, actions }, listed: shown.map((t) => t.id) };
}

/** Numbered list of open tasks with one "N · Готово" button per task (the /tasks reply and the morning list). */
export function buildStaffTaskList(
  tasks: readonly StaffTaskLite[],
  today: IsoDate,
  title = "Ваши открытые задачи",
): NeutralMessage {
  if (!tasks.length) return { title, lines: [{ text: "Открытых задач нет. Спасибо!", style: "muted" }] };
  const footer: MessageLine = { text: "Готово по номеру: /done 1. Ответ текстом — комментарий к задаче.", style: "muted" };
  let left = SUMMARY_TEXT_BUDGET - renderTelegramTitleLength(title) - renderedLineLength(footer) - 40;
  const lines: MessageLine[] = [];
  const actions: MessageAction[] = [];
  let shown = 0;
  for (const [i, t] of tasks.slice(0, 15).entries()) {
    const line: MessageLine = { text: `${i + 1}. ${t.title} — ${metaLine(t, today)}`, style: "text" };
    const len = renderedLineLength(line);
    if (len > left) break;
    left -= len;
    lines.push(line);
    if (i < 8) actions.push({ action: "staff_done", taskId: t.id, label: `${i + 1} · Готово`, row: Math.floor(i / 2) });
    shown++;
  }
  if (shown < tasks.length) lines.push({ text: `…и ещё ${tasks.length - shown}`, style: "muted" });
  lines.push(footer);
  return { title, lines, actions };
}

export function buildStaffMorningList(name: string, tasks: readonly StaffTaskLite[], today: IsoDate): NeutralMessage {
  return buildStaffTaskList(tasks, today, `Доброе утро, ${name}! Ваши задачи`);
}

export function buildWhichTask(tasks: readonly StaffTaskLite[], text: string): NeutralMessage {
  const short = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s);
  return {
    title: "К какой задаче?",
    lines: [{ text: "Выберите задачу — я добавлю ваше сообщение к ней и передам основателям.", style: "text" }],
    actions: tasks.slice(0, 8).map((t, i) => ({
      action: "staff_comment_pick" as const,
      taskId: t.id,
      label: `${i + 1}. ${short(t.title)}`,
      row: i,
      payload: { text },
    })),
  };
}

export function buildMoveOptions(t: StaffTaskLite, today: IsoDate): NeutralMessage {
  return {
    title: `Перенести срок: ${t.title}`,
    lines: [
      { text: ruDue(t.dueDate, today), style: "text" },
      { text: "Выберите новый срок. Основатель подтвердит перенос.", style: "muted" },
    ],
    actions: (["staff_move_1d", "staff_move_3d", "staff_move_7d"] as const).map((action) => ({
      action,
      taskId: t.id,
      label: STAFF_ACTION_LABELS[action],
      row: 0,
    })),
  };
}

export function buildStaffWelcome(name: string): NeutralMessage {
  return {
    title: `Здравствуйте, ${name}!`,
    lines: [
      { text: "Бот подключён. Сюда будут приходить ваши задачи и напоминания по ним.", style: "text" },
      { text: "Сообщения начнут приходить, когда основатель включит рассылку. /help — что я умею, /stop — отключить.", style: "muted" },
    ],
  };
}

export function buildStaffHelp(): NeutralMessage {
  return {
    title: "Что умеет бот",
    lines: [
      { text: "/tasks — ваши открытые задачи", style: "text" },
      { text: "/routines — рутины на сегодня (что ещё не отмечено)", style: "text" },
      { text: "/done 2 — отметить задачу №2 из списка выполненной", style: "text" },
      { text: "/stop — больше не присылать сообщения", style: "text" },
      { text: "Кнопки под задачами: Принято, Готово, Нужна помощь, Перенести срок.", style: "muted" },
      { text: "Ответ текстом на сообщение о задаче — комментарий для основателей.", style: "muted" },
    ],
  };
}

export function buildStaffInfo(text: string): NeutralMessage {
  return { title: "Сообщение от основателей", lines: [{ text, style: "text" }] };
}

/** Short bot replies to a person. */
export const RU = {
  textOnly: "Пока принимаю только текст. Напишите, пожалуйста, словами — я передам основателям.",
  stopped: "Готово: сообщения больше не будут приходить. Чтобы снова включить — отправьте /start.",
  resumed: "Сообщения снова включены.",
  stoppedHint: "Вы отключили сообщения бота. Отправьте /start, чтобы включить их снова.",
  codeInvalid: "Код неверный, устарел или уже использован. Попросите основателя прислать новую ссылку.",
  privateOnly: "Отправьте код боту в личном чате.",
  chatTaken: "Этот чат уже подключён к основателю. Откройте ссылку с телефона сотрудника.",
  notYourTask: "Эта задача вам недоступна.",
  buttonExpired: "Кнопка устарела или уже нажата.",
  accepted: "Принято ✓ Основатели увидят.",
  done: "Отмечено как выполненное ✓ Спасибо!",
  alreadyDone: "Эта задача уже закрыта.",
  help: "Передал основателям, что нужна помощь. Напишите текстом, что именно нужно.",
  commentSaved: "Передал основателям ✓",
  noTasksComment: "Открытых задач нет — сообщение передано основателям.",
  moveRequested: (date: string) => `Запрос на перенос срока до ${date} отправлен. Основатель подтвердит.`,
  doneNotFound: "Нет задачи с таким номером. Отправьте /tasks, чтобы увидеть список.",
  noDeadlineMove: "Перенести можно только открытую задачу.",
} as const;

// ---------------------------------------------------------------------------
// Routines (0029)
// ---------------------------------------------------------------------------

/** What a routine message needs (no DB): the routine and today's run state. */
export interface RoutineMessageInput {
  runId: string;
  title: string;
  description: string;
  confirmation: "button" | "checklist" | "number";
  items: readonly { key: string; label: string }[];
  itemsDone: readonly string[];
}

/** Labels of checklist items not ticked yet. */
export function remainingItems(r: Pick<RoutineMessageInput, "items" | "itemsDone">) {
  const done = new Set(r.itemsDone);
  return r.items.filter((i) => !done.has(i.key));
}

/**
 * The ask (`reminder` = false) or a reminder about today's run. A checklist shows ONLY the items not
 * ticked yet, one «✓ item» button each (two per row), plus «✓ Всё сделано» when more than one is left.
 * A button routine has one «Готово».
 */
export function buildRoutineMessageRu(r: RoutineMessageInput, reminder: boolean): NeutralMessage {
  const lines: MessageLine[] = [];
  if (r.description) lines.push({ text: r.description, style: "text" });
  if (r.confirmation === "checklist") {
    const left = remainingItems(r);
    lines.push({
      text: reminder && r.itemsDone.length ? `Осталось отметить (${left.length} из ${r.items.length}):` : "Отметьте, что сделано:",
      style: "muted",
    });
    for (const i of left) lines.push({ text: i.label, style: "item" });
    const actions: MessageAction[] = left.map((i, n) => ({
      action: "routine_tick" as const,
      runId: r.runId,
      item: i.key,
      label: `✓ ${i.label}`,
      row: Math.floor(n / 2),
    }));
    if (left.length > 1) actions.push({ action: "routine_done", runId: r.runId, label: "✓ Всё сделано", row: 100 });
    return { title: `${reminder ? "Напоминание" : "Рутина"}: ${r.title}`, lines, actions };
  }
  lines.push({ text: "Нажмите «Готово», когда сделаете.", style: "muted" });
  return {
    title: `${reminder ? "Напоминание" : "Рутина"}: ${r.title}`,
    lines,
    actions: [{ action: "routine_done", runId: r.runId, label: "Готово" }],
  };
}

export const RU_ROUTINE = {
  none: "Сегодня открытых рутин нет. Спасибо!",
  ticked: (label: string, left: number) => (left ? `✓ ${label}. Осталось: ${left}` : `✓ ${label}`),
  done: "Рутина выполнена ✓ Спасибо!",
  already: "Уже отмечено.",
  closed: "Эта рутина на сегодня уже закрыта.",
  notYours: "Эта рутина вам недоступна.",
} as const;
