/**
 * Russian messages for staff on Telegram (people, not founders). Pure: no DB, no clock.
 * Founder-facing text stays English (messages.ts). Plain text only; renderers escape it.
 */
import { daysBetween, type IsoDate } from "@/lib/dates";
import { renderedLineLength, renderTelegramTitleLength } from "./render-telegram";
import { SUMMARY_TEXT_BUDGET } from "./messages";
import type { MessageAction, MessageLine, NeutralMessage, StaffAction } from "./types";

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
