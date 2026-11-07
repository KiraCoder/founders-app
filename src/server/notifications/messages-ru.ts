/**
 * Russian messages for staff on Telegram (people, not founders). Pure: no DB, no clock.
 * Founder-facing text stays English (messages.ts). Plain text only; renderers escape it.
 */
import { daysBetween, type IsoDate } from "@/lib/dates";
import { itemStateOf, openItems, RUN_ITEM_KEY, runProgress, type ChecklistItem, type ItemState, type ItemStates } from "@/lib/routines";
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
  staff_accept: "👍 Принято",
  staff_done: "✅ Готово",
  staff_help: "🆘 Нужна помощь",
  staff_move: "📅 Перенести срок",
  staff_move_1d: "+1 день",
  staff_move_3d: "+3 дня",
  staff_move_7d: "+7 дней",
  staff_comment_pick: "Выбрать",
  staff_comment: "💬 Комментарий",
  staff_check: "⬜",
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

/** «✅ Готово / 👍 Принято / 💬 Комментарий / 🆘 Нужна помощь / 📅 Перенести срок» under a task message. */
export function staffTaskButtons(taskId: string, withAccept = true, payload?: Record<string, unknown>): MessageAction[] {
  const rows: [StaffAction, number][] = [
    ["staff_done", 0],
    ...(withAccept ? ([["staff_accept", 0]] as [StaffAction, number][]) : []),
    ["staff_comment", 1],
    ["staff_help", 1],
    ["staff_move", 2],
  ];
  return rows.map(([action, row]) => ({ action, taskId, label: STAFF_ACTION_LABELS[action], row, ...(payload ? { payload } : {}) }));
}

/**
 * Everything a task card shows the person (0032). Still nothing private: the notes only when a
 * founder ticked "Send notes", never the owner or other people.
 */
export interface StaffTaskCard extends StaffTaskLite {
  details?: string | null;
  checklist: readonly { id: string; title: string; details: string | null; done: boolean }[];
  status: "open" | "done" | "cancelled";
  /** "12.11 10:05" when the person pressed «Принято». */
  acceptedAt?: string | null;
  helpRequested?: boolean;
  deadlineRequested?: IsoDate | null;
}

/** Which message a card is: it decides the header (kept when the card is re-drawn after a button). */
export type StaffCardKind = "new" | "chase" | "update";
export const STAFF_CARD_KINDS: readonly StaffCardKind[] = ["new", "chase", "update"];

/** At most this many «⬜ item» buttons under a card (the rest is ticked in the app or by «Готово»). */
export const MAX_CARD_CHECK_BUTTONS = 8;

const shortLabel = (s: string, n = 30) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * One task as a well-laid-out message: emoji header with the title, company, deadline, details,
 * the checklist (✅ / ⬜ with progress), what the person already answered, and the buttons.
 * `note` (italic, last) is the result of the button just pressed when the card is re-drawn.
 */
export function buildStaffTaskCard(c: StaffTaskCard, today: IsoDate, kind: StaffCardKind, note?: string): NeutralMessage {
  const late = c.dueDate ? daysBetween(c.dueDate, today) : 0;
  const header =
    c.status === "done"
      ? "✅ Выполнено"
      : c.status === "cancelled"
        ? "🚫 Задача отменена"
        : kind === "new"
          ? "🆕 Новая задача"
          : kind === "update"
            ? "✏️ Задача обновлена"
            : late > 0
              ? "⏰ Задача просрочена"
              : "🔔 Напоминание";
  const lines: MessageLine[] = [];
  if (c.companyName) lines.push({ text: `🏢 ${c.companyName}`, style: "text" });
  const prio = c.priority === "urgent" ? " · ‼️ Срочно" : c.priority === "high" ? " · ❗ Важно" : "";
  lines.push({ text: `📅 ${ruDue(c.dueDate, today)}${prio}`, style: "text" });
  if (c.details?.trim()) lines.push({ text: `📝 ${c.details.trim()}`, style: "text" });
  if (c.checklist.length) {
    const done = c.checklist.filter((i) => i.done).length;
    const bar = "▰".repeat(Math.round((done / c.checklist.length) * 5)) + "▱".repeat(5 - Math.round((done / c.checklist.length) * 5));
    lines.push({ text: `Чек-лист · ${done} из ${c.checklist.length} ${bar}`, style: "heading" });
    for (const i of c.checklist) {
      lines.push({ text: `${i.done ? "✅" : "⬜"} ${i.title}`, style: "text" });
      if (i.details?.trim()) lines.push({ text: `      ${i.details.trim()}`, style: "muted" });
    }
  }
  const state: string[] = [];
  if (c.acceptedAt) state.push(`👍 Принято ${c.acceptedAt}`);
  if (c.helpRequested) state.push("🆘 Помощь запрошена");
  if (c.deadlineRequested) state.push(`📅 Запрошен перенос на ${ruDate(c.deadlineRequested)}`);
  if (state.length) lines.push({ text: state.join(" · "), style: "heading" });
  if (note) lines.push({ text: note, style: "muted" });
  else if (c.status === "open") {
    lines.push({
      text:
        kind === "chase"
          ? "Если уже сделано — нажмите «✅ Готово». Нужна помощь или другой срок — кнопки ниже."
          : "Нажмите «👍 Принято», когда увидели, и «✅ Готово», когда сделали. Ответ текстом на это сообщение — комментарий.",
      style: "muted",
    });
  }
  if (c.status !== "open") return { title: `${header}: ${c.title}`, lines, actions: [] };
  const payload = { card: kind };
  const actions: MessageAction[] = staffTaskButtons(c.id, kind !== "chase" && !c.acceptedAt, payload);
  c.checklist
    .map((i, n) => ({ i, n }))
    .filter(({ i }) => !i.done)
    .slice(0, MAX_CARD_CHECK_BUTTONS)
    .forEach(({ i, n }) =>
      actions.push({
        action: "staff_check",
        taskId: c.id,
        item: i.id,
        label: `⬜ ${n + 1}. ${shortLabel(i.title)}`,
        row: 10 + n,
        payload: { ...payload, item: i.id },
      }),
    );
  return { title: `${header}: ${c.title}`, lines, actions };
}

const liteCard = (t: StaffTaskLite): StaffTaskCard => ({ ...t, checklist: [], status: "open" });

export function buildStaffNewTask(t: StaffTaskLite | StaffTaskCard, today: IsoDate): NeutralMessage {
  return buildStaffTaskCard("checklist" in t ? t : liteCard(t), today, "new");
}

export function buildStaffChase(t: StaffTaskLite | StaffTaskCard, today: IsoDate): NeutralMessage {
  return buildStaffTaskCard("checklist" in t ? t : liteCard(t), today, "chase");
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
      { text: "Кнопки под задачами: ✅ Готово, 👍 Принято, 💬 Комментарий, 🆘 Нужна помощь, 📅 Перенести срок, ⬜ пункты чек-листа.", style: "muted" },
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
  commentPrompt: "Напишите комментарий одним сообщением — я добавлю его к задаче и передам основателям.",
  checked: (label: string, left: number) => (left ? `✅ ${label}. Осталось пунктов: ${left}` : `✅ ${label}. Все пункты отмечены!`),
  alreadyChecked: "Этот пункт уже отмечен.",
} as const;

// ---------------------------------------------------------------------------
// Routines (0029, redesigned in 0031): one message per ask / reminder, EDITED in place on each tick
// ---------------------------------------------------------------------------

/** What a routine message needs (no DB): the routine and today's run state. */
export interface RoutineMessageInput {
  runId: string;
  title: string;
  description: string;
  confirmation: "button" | "checklist" | "number";
  items: readonly ChecklistItem[];
  itemsDone: readonly string[];
  itemStates?: ItemStates | null;
  /** The run's status ("done" → the final «Готово, спасибо!» state; partly / missed → closed). */
  status?: string;
  companyName?: string | null;
  /** "Remind until" (HH:MM): «⏰ до 19:00». */
  until?: string | null;
}

/** Why the message is sent: the ask, a reminder, or "the founder changed the checklist". */
export type RoutineMessageMode = "ask" | "reminder" | "updated";

/** Checklist items not resolved yet (not done / partly / can't). */
export function remainingItems(r: Pick<RoutineMessageInput, "items" | "itemsDone" | "itemStates">) {
  return openItems({ items: r.items, itemsDone: r.itemsDone, itemStates: r.itemStates ?? {} });
}

export const ROUTINE_STATE_EMOJI: Record<ItemState | "open", string> = { done: "✅", partly: "🟡", cant: "❌", open: "⬜" };

export const ROUTINE_BUTTONS = {
  allDone: "✅ Всё готово",
  done: "✅ Готово",
  comment: "💬 Комментарий",
  partly: "🟡 Частично",
  cant: "❌ Не могу",
  back: "← Назад",
  wholeRun: "Ко всей рутине",
  allLeft: "Все оставшиеся",
} as const;

const shortRoutineLabel = (s: string, n = 28) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const quoted = (c: string | null | undefined) => (c ? ` — «${c.length > 120 ? `${c.slice(0, 119)}…` : c}»` : "");

function routineHeader(r: RoutineMessageInput, mode: RoutineMessageMode): string {
  if (r.status === "done") return `✅ ${r.title}`;
  if (r.status === "partly" || r.status === "missed") return `🔒 ${r.title}`;
  if (mode === "reminder") return `⏰ Напоминание: ${r.title}`;
  if (mode === "updated") return `🔄 Рутина обновлена: ${r.title}`;
  return `📋 Рутина: ${r.title}`;
}

/** The body lines (meta, description, progress, the checklist with states), shared by every variant. */
function routineBody(r: RoutineMessageInput, mode: RoutineMessageMode): MessageLine[] {
  const run = { items: r.items, itemsDone: r.itemsDone, itemStates: r.itemStates ?? {}, status: r.status };
  const lines: MessageLine[] = [];
  const closed = r.status === "done" || r.status === "partly" || r.status === "missed";
  const meta = [r.companyName ? `🏢 ${r.companyName}` : null, !closed && r.until ? `⏰ сегодня до ${r.until}` : null].filter(Boolean);
  if (meta.length) lines.push({ text: meta.join(" · "), style: "text" });
  if (r.description) lines.push({ text: r.description, style: "text" });
  if (mode === "updated" && !closed) lines.push({ text: "Основатель изменил список — вот актуальный.", style: "muted" });
  const { done, total } = runProgress(run);
  if (r.confirmation === "checklist" && r.items.length) {
    lines.push({ text: `Прогресс: ${done}/${total}`, style: "heading" });
    for (const i of r.items) {
      const st = itemStateOf(run, i.key);
      const rec = r.itemStates?.[i.key];
      lines.push({ text: `${ROUTINE_STATE_EMOJI[st]} ${i.label}${st === "open" ? "" : quoted(rec?.comment)}`, style: "text" });
      if (i.details && st === "open") lines.push({ text: `    ${i.details}`, style: "muted" });
    }
  } else {
    const st = itemStateOf(run, RUN_ITEM_KEY);
    const rec = r.itemStates?.[RUN_ITEM_KEY];
    if (r.status === "done" || st !== "open") {
      lines.push({ text: `${ROUTINE_STATE_EMOJI[r.status === "done" ? "done" : st]} ${st === "partly" ? "Частично" : st === "cant" ? "Не получилось" : "Сделано"}${quoted(rec?.comment)}`, style: "text" });
    }
  }
  if (r.status === "done") {
    lines.push({ text: `Готово, спасибо! ${done}/${total} ✅`, style: "heading" });
  } else if (closed) {
    lines.push({ text: `На сегодня закрыто: ${done}/${total}. Основатели видят комментарии.`, style: "muted" });
  } else if (r.confirmation === "checklist" && r.items.length) {
    const left = remainingItems(r).length;
    if (mode === "reminder") lines.push({ text: `Осталось: ${left} из ${total}.`, style: "muted" });
    lines.push({ text: "Нажмите на пункт, когда сделаете. «Частично» и «Не могу» — с комментарием.", style: "muted" });
  } else {
    lines.push({ text: "Нажмите «✅ Готово», когда сделаете. «Частично» и «Не могу» — с комментарием.", style: "muted" });
  }
  return lines;
}

/**
 * The ask, a reminder or the "updated" message about today's run (and the same text when the bot
 * edits it after a tick): header with emoji + title, company and "until", «Прогресс: 3/5», the whole
 * checklist with ✅ done / 🟡 partly / ❌ can't / ⬜ open (details in italics under open items).
 * Buttons: «✓ item» per open item, «✅ Всё готово» (two or more open) or «✅ Готово», then
 * «💬 Комментарий» «🟡 Частично» «❌ Не могу». A done run shows «Готово, спасибо! 5/5 ✅», no buttons.
 * `mode` may be a boolean (true = reminder) for older callers.
 */
export function buildRoutineMessageRu(r: RoutineMessageInput, mode: RoutineMessageMode | boolean = "ask"): NeutralMessage {
  const m: RoutineMessageMode = mode === true ? "reminder" : mode === false ? "ask" : mode;
  const title = routineHeader(r, m);
  const lines = routineBody(r, m);
  const closed = r.status === "done" || r.status === "partly" || r.status === "missed";
  if (closed) return { title, lines, actions: [] };
  const actions: MessageAction[] = [];
  if (r.confirmation === "checklist" && r.items.length) {
    const left = remainingItems(r);
    left.forEach((i, n) => actions.push({ action: "routine_tick", runId: r.runId, item: i.key, label: `✓ ${shortRoutineLabel(i.label)}`, row: Math.floor(n / 2) }));
    if (left.length > 1) actions.push({ action: "routine_done", runId: r.runId, label: ROUTINE_BUTTONS.allDone, row: 100 });
  } else {
    actions.push({ action: "routine_done", runId: r.runId, label: ROUTINE_BUTTONS.done, row: 100 });
  }
  actions.push(
    { action: "routine_comment", runId: r.runId, label: ROUTINE_BUTTONS.comment, row: 101 },
    { action: "routine_partly", runId: r.runId, label: ROUTINE_BUTTONS.partly, row: 101 },
    { action: "routine_cant", runId: r.runId, label: ROUTINE_BUTTONS.cant, row: 101 },
  );
  return { title, lines, actions };
}

export type RoutineCommentKind = "comment" | "partly" | "cant";

/**
 * «Какой пункт?»: the same message with a pick of the item a comment / «Частично» / «Не могу» is
 * about (open items for partly / can't; every item for a comment), the whole run, and «← Назад».
 */
export function buildRoutinePickRu(r: RoutineMessageInput, kind: RoutineCommentKind): NeutralMessage {
  const base = buildRoutineMessageRu(r, "ask");
  const choices = kind === "comment" ? r.items : remainingItems(r);
  const ask = kind === "comment" ? "К какому пункту комментарий?" : kind === "partly" ? "Какой пункт сделан частично?" : "Какой пункт не получается?";
  const actions: MessageAction[] = choices.map((i, n) => ({
    action: "routine_pick" as const,
    runId: r.runId,
    item: i.key,
    label: `→ ${shortRoutineLabel(i.label)}`,
    row: Math.floor(n / 2),
    payload: { kind },
  }));
  actions.push(
    { action: "routine_pick", runId: r.runId, item: "_all", label: kind === "comment" ? ROUTINE_BUTTONS.wholeRun : ROUTINE_BUTTONS.allLeft, row: 100, payload: { kind } },
    { action: "routine_back", runId: r.runId, label: ROUTINE_BUTTONS.back, row: 100 },
  );
  return { title: base.title, lines: [...base.lines, { text: ask, style: "heading" }], actions };
}

/** The prompt sent after «Комментарий» / «Частично» / «Не могу» (or a tick of a "needs a comment" item). */
export function routineCommentPrompt(kind: RoutineCommentKind | "done", itemLabel: string | null): NeutralMessage {
  const about = itemLabel ? ` — пункт «${itemLabel}»` : "";
  if (kind === "partly") return { title: "🟡 Частично", lines: [{ text: `Что сделано, а что нет${about}? Напишите одним сообщением.`, style: "text" }] };
  if (kind === "cant") return { title: "❌ Не могу", lines: [{ text: `Почему не получается${about}? Напишите одним сообщением — основатели увидят.`, style: "text" }] };
  if (kind === "done") return { title: "💬 Нужен комментарий", lines: [{ text: `Отмечено ✓ Напишите комментарий${about} одним сообщением.`, style: "text" }] };
  return { title: "💬 Комментарий", lines: [{ text: `Напишите комментарий${about} одним сообщением.`, style: "text" }] };
}

export const RU_ROUTINE = {
  none: "Сегодня открытых рутин нет. Спасибо!",
  ticked: (label: string, left: number) => (left ? `✓ ${label}. Осталось: ${left}` : `✓ ${label}`),
  done: "Рутина выполнена ✓ Спасибо!",
  already: "Уже отмечено.",
  closed: "Эта рутина на сегодня уже закрыта.",
  notYours: "Эта рутина вам недоступна.",
  pick: "Выберите пункт",
  writeComment: "Напишите комментарий одним сообщением",
  commentSaved: "Комментарий сохранён ✓ Основатели увидят.",
  partlySaved: "Отмечено «частично» ✓ Комментарий передан основателям.",
  cantSaved: "Понятно. Передал основателям ✓",
} as const;
