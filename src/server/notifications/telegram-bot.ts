import "server-only";
import type { Db } from "@/server/db/connect";
import { makeContext } from "@/server/services/context";
import { toServiceError } from "@/server/services/errors";
import { applyHoldingAskAction } from "@/server/services/holding-asks";
import { applyTaskAction } from "@/server/services/notifications";
import { getTodaySummary } from "@/server/services/tasks";
import { consumeActionToken, liveCallbacks } from "./action-tokens";
import { consumeLinkCode, findLinkByChat } from "./linking";
import { buildHelp, buildMorningSummary, buildNotLinked, buildTasksList } from "./messages";
import { escapeHtml, renderTelegram } from "./render-telegram";
import { TelegramApi, type TelegramUpdate } from "./telegram-api";
import type { NeutralMessage } from "./types";

/** A Bot API call the handler wants made. Executed by `executeBotActions` (or shown in dev). */
export interface BotAction {
  method: "sendMessage" | "answerCallbackQuery" | "editMessageText";
  params: Record<string, unknown>;
}

function reply(chatId: number | string, message: NeutralMessage): BotAction {
  return { method: "sendMessage", params: { chat_id: chatId, ...renderTelegram(message) } };
}

function plain(chatId: number | string, title: string, text: string): BotAction {
  return reply(chatId, { title, lines: [{ text }] });
}

/**
 * Handles one Telegram update (from the webhook or the dev poller).
 * - Unlinked chats get one polite "not linked" reply and nothing else.
 * - Linked chats act strictly as their founder, through the service layer.
 * - Buttons carry only a server-side token; it must belong to the linked founder.
 */
export async function handleTelegramUpdate(db: Db, update: TelegramUpdate, now: Date): Promise<BotAction[]> {
  if (update.callback_query) return handleCallback(db, update.callback_query, now);
  const msg = update.message;
  if (!msg?.text || !msg.from || msg.from.is_bot) return [];
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const [rawCommand, ...args] = text.split(/\s+/);
  const command = (rawCommand ?? "").toLowerCase().replace(/@\w+$/, "");

  if (command === "/start" && args.length > 0) {
    if (msg.chat.type !== "private") {
      return [plain(chatId, "Private chats only", "Please send the code to the bot in a private chat.")];
    }
    const result = await consumeLinkCode(
      db,
      args.join(""),
      {
        chatId: String(chatId),
        telegramUserId: String(msg.from.id),
        username: msg.from.username ?? null,
        firstName: msg.from.first_name ?? null,
      },
      now,
    );
    if (!result.ok) {
      return [
        plain(chatId, "Code not accepted", "This code is wrong, expired or already used. Generate a new one on the Settings page."),
      ];
    }
    return [
      plain(chatId, `Linked to ${result.shortName}`, "From now on your reminders and summaries come here. Send /help to see what I can do."),
    ];
  }

  const link = msg.chat.type === "private" ? await findLinkByChat(db, String(chatId), String(msg.from.id)) : null;
  if (!link) return [reply(chatId, buildNotLinked())];

  const ctx = makeContext(db, link.user, now);
  switch (command) {
    case "/today": {
      const summary = await getTodaySummary(ctx);
      return [reply(chatId, { ...buildMorningSummary(summary, [], link.user.shortName), title: `Today, ${link.user.shortName}` })];
    }
    case "/tasks":
      return [reply(chatId, buildTasksList(await getTodaySummary(ctx)))];
    case "/start":
      return [plain(chatId, `Hi ${link.user.shortName}`, "You are already linked. Send /help to see the commands.")];
    default:
      return [reply(chatId, buildHelp())];
  }
}

async function handleCallback(
  db: Db,
  cq: NonNullable<TelegramUpdate["callback_query"]>,
  now: Date,
): Promise<BotAction[]> {
  const answer = (text: string): BotAction => ({ method: "answerCallbackQuery", params: { callback_query_id: cq.id, text } });
  const chat = cq.message?.chat;
  if (!chat || chat.type !== "private" || !cq.data) return [answer("This button does not work here.")];

  const link = await findLinkByChat(db, String(chat.id), String(cq.from.id));
  if (!link) return [answer("This chat is not linked to Founder Cockpit.")];

  const token = await consumeActionToken(db, cq.data, link.user.id, now);
  if (!token) return [answer("This button has expired or was already used.")];

  let result: string;
  try {
    const ctx = makeContext(db, link.user, now);
    result =
      token.kind === "task"
        ? await applyTaskAction(ctx, token.action, token.taskId)
        : await applyHoldingAskAction(ctx, token.askId);
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return [answer(se.code === "not_found" ? (token.kind === "task" ? "Task not found." : "Not found.") : se.message)];
  }

  const actions: BotAction[] = [answer(result)];
  if (cq.message) {
    const original = cq.message.text ? escapeHtml(cq.message.text) : "";
    // editMessageText without reply_markup removes every button, so the summary's other
    // buttons (other tasks, the other holding line) are sent again — only those that still
    // work: not the one just pressed, none for the same task / item, none used or expired.
    const keyboard = await remainingKeyboard(db, cq.message, cq.data, token, link.user.id, now);
    actions.push({
      method: "editMessageText",
      params: {
        chat_id: chat.id,
        message_id: cq.message.message_id,
        text: `${original}\n\n<i>${escapeHtml(result)}</i>`.trim(),
        parse_mode: "HTML",
        ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      },
    });
  }
  return actions;
}

type Button = { text: string; callback_data: string };

async function remainingKeyboard(
  db: Db,
  message: NonNullable<NonNullable<TelegramUpdate["callback_query"]>["message"]>,
  pressed: string,
  token: Awaited<ReturnType<typeof consumeActionToken>>,
  userId: string,
  now: Date,
): Promise<Button[][]> {
  const buttons = (message.reply_markup?.inline_keyboard ?? [])
    .flat()
    .filter((b): b is Button => typeof b.callback_data === "string" && b.callback_data !== pressed);
  if (!buttons.length) return [];
  const live = await liveCallbacks(db, buttons.map((b) => b.callback_data), userId, now);
  const sameSubject = (s: { taskId: string | null; holdingAskId: string | null }) =>
    token?.kind === "task" ? s.taskId === token.taskId : token?.kind === "holding" ? s.holdingAskId === token.askId : false;
  const keep = buttons.filter((b) => {
    const s = live.get(b.callback_data);
    return !!s && !sameSubject(s);
  });
  const rows: Button[][] = [];
  for (let i = 0; i < keep.length; i += 2) rows.push(keep.slice(i, i + 2));
  return rows;
}

/** Performs the calls through the Bot API. Errors are logged, never thrown (Telegram would retry). */
export async function executeBotActions(actions: BotAction[], token: string): Promise<void> {
  const api = new TelegramApi(token);
  for (const a of actions) {
    const res = await api.call(a.method, a.params);
    if (!res.ok) console.warn(`[telegram] ${a.method} failed: ${res.description ?? "unknown error"}`);
  }
}
