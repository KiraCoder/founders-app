/**
 * Telegram renderer: NeutralMessage -> sendMessage params (HTML parse mode + inline keyboard).
 * Pure; every piece of user text is escaped.
 */
import { actionKey, type ActionCallbacks, type NeutralMessage } from "./types";

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

export function renderTelegramText(message: NeutralMessage): string {
  const out: string[] = [`<b>${escapeHtml(message.title)}</b>`];
  for (const line of message.lines) {
    const t = escapeHtml(line.text);
    switch (line.style) {
      case "heading":
        out.push("", `<b>${t}</b>`);
        break;
      case "item":
        out.push(`• ${t}`);
        break;
      case "muted":
        out.push(`<i>${t}</i>`);
        break;
      default:
        out.push(t);
    }
  }
  let text = out.join("\n");
  if (text.length > TELEGRAM_MAX_TEXT) {
    // Cut on a line boundary so we never split an HTML tag or entity.
    const cut = text.lastIndexOf("\n", TELEGRAM_MAX_TEXT - 20);
    text = `${text.slice(0, cut > 0 ? cut : TELEGRAM_MAX_TEXT - 20)}\n…`;
  }
  return text;
}

/** Buttons appear only when the dispatcher minted a callback token for them. Two per row. */
export function renderTelegram(message: NeutralMessage, callbacks: ActionCallbacks = {}): TelegramRendered {
  const buttons: InlineKeyboardButton[] = [];
  for (const a of message.actions ?? []) {
    const data = callbacks[actionKey(a)];
    if (data) buttons.push({ text: a.label, callback_data: data });
  }
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return {
    text: renderTelegramText(message),
    parse_mode: "HTML",
    ...(rows.length ? { reply_markup: { inline_keyboard: rows } } : {}),
  };
}
