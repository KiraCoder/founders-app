/**
 * Telegram renderer: NeutralMessage -> sendMessage params (HTML parse mode + inline keyboard).
 * Pure; every piece of user text is escaped.
 */
import { actionKey, holdingRef, taskRef, type ActionCallbacks, type MessageLine, type NeutralMessage } from "./types";

export const TELEGRAM_MAX_TEXT = 4096;

/** Escapes the three characters Telegram's HTML mode cares about. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface TelegramRendered {
  text: string;
  parse_mode: "HTML";
  reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
}

/** One rendered line (headings carry their blank line before them). */
export function renderLine(line: MessageLine): string {
  const t = escapeHtml(line.text);
  switch (line.style) {
    case "heading":
      return `\n<b>${t}</b>`;
    case "item":
      return `• ${t}`;
    case "muted":
      return `<i>${t}</i>`;
    default:
      return t;
  }
}

/** Characters a line adds to the rendered text (its newline included). */
export function renderedLineLength(line: MessageLine): number {
  return renderLine(line).length + 1;
}

/** Characters the bold title takes. */
export function renderTelegramTitleLength(title: string): number {
  return `<b>${escapeHtml(title)}</b>`.length;
}

const ELLIPSIS = "\n…";

export interface FittedMessage {
  /** The message with only the lines that fit (plus a final "…" line when some were left out). */
  message: NeutralMessage;
  /** Refs (MessageLine.refs) of the lines that made it into the text. */
  keptRefs: Set<string>;
  /** Refs of lines that were left out (only when the message was too long). */
  droppedRefs: Set<string>;
}

/**
 * Fits a message into Telegram's limit by dropping WHOLE lines from the end (never an HTML
 * tag or entity), and reports which line refs survived. The dispatcher marks holding asks,
 * AI requests and parked items as shown/bundled only when their line is in `keptRefs`, so
 * nothing is ever marked as delivered that the founder did not see.
 * Buttons of holding items whose line was left out are removed too, and so are the buttons of
 * a task whose line (taskRef) was left out.
 */
export function fitTelegram(message: NeutralMessage): FittedMessage {
  const keptRefs = new Set<string>();
  const droppedRefs = new Set<string>();
  let total = `<b>${escapeHtml(message.title)}</b>`.length;
  const kept: MessageLine[] = [];
  let cut = false;
  for (const line of message.lines) {
    const len = renderedLineLength(line);
    if (!cut && total + len + ELLIPSIS.length <= TELEGRAM_MAX_TEXT) {
      total += len;
      kept.push(line);
      for (const r of line.refs ?? []) keptRefs.add(r);
    } else {
      cut = true;
      for (const r of line.refs ?? []) droppedRefs.add(r);
    }
  }
  if (!cut) return { message, keptRefs, droppedRefs };
  for (const r of keptRefs) droppedRefs.delete(r);
  const actions = message.actions?.filter((a) =>
    a.askId ? keptRefs.has(holdingRef(a.askId)) : !(a.taskId && droppedRefs.has(taskRef(a.taskId))),
  );
  return {
    message: { ...message, lines: [...kept, { text: "…", style: "text" }], ...(actions ? { actions } : {}) },
    keptRefs,
    droppedRefs,
  };
}

export function renderTelegramText(message: NeutralMessage): string {
  const out: string[] = [`<b>${escapeHtml(message.title)}</b>`];
  for (const line of message.lines) out.push(renderLine(line));
  let text = out.join("\n");
  if (text.length > TELEGRAM_MAX_TEXT) {
    // Backstop (the dispatcher fits summaries first): cut on a line boundary so we never
    // split an HTML tag or entity.
    const cutAt = text.lastIndexOf("\n", TELEGRAM_MAX_TEXT - 20);
    text = `${text.slice(0, cutAt > 0 ? cutAt : TELEGRAM_MAX_TEXT - 20)}\n…`;
  }
  return text;
}

/**
 * Buttons appear only when the dispatcher minted a callback token for them. Two per row, or
 * one row per `row` number when the actions carry one (the grouped overdue push: one row per task).
 */
export function renderTelegram(message: NeutralMessage, callbacks: ActionCallbacks = {}): TelegramRendered {
  const buttons: { button: InlineKeyboardButton; row?: number }[] = [];
  for (const a of message.actions ?? []) {
    const data = callbacks[actionKey(a)];
    if (data) buttons.push({ button: { text: a.label, callback_data: data }, row: a.row });
  }
  const rows: InlineKeyboardButton[][] = [];
  if (buttons.some((b) => b.row !== undefined)) {
    const byRow = new Map<number, InlineKeyboardButton[]>();
    for (const b of buttons) {
      const r = b.row ?? Number.MAX_SAFE_INTEGER;
      byRow.set(r, [...(byRow.get(r) ?? []), b.button]);
    }
    for (const r of [...byRow.keys()].sort((x, y) => x - y)) rows.push(byRow.get(r)!);
  } else {
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2).map((b) => b.button));
  }
  return {
    text: renderTelegramText(message),
    parse_mode: "HTML",
    ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}),
  };
}
