import "server-only";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { todayInTimeZone } from "@/lib/dates";
import type { Db } from "@/server/db/connect";
import { notificationsOutbox, telegramLinks } from "@/server/db/schema";
import type { PersonContext } from "@/server/services/access";
import { makeContext } from "@/server/services/context";
import { toServiceError } from "@/server/services/errors";
import { applyHoldingAskAction } from "@/server/services/holding-asks";
import { applyTaskAction } from "@/server/services/notifications";
import {
  getPersonTask,
  listPersonOpenTasks,
  loadStaffCard,
  personAccept,
  personBotSwitched,
  personCheckItem,
  personComment,
  personContext,
  personHelp,
  personMarkDone,
  personMessageWithoutTask,
  personRequestDeadline,
  personSentFile,
  personStartComment,
  takePendingComment,
  toLite,
} from "@/server/services/staff-tasks";
import { decideDeadlineRequest } from "@/server/services/task-comments";
import { getTodaySummary } from "@/server/services/tasks";
import {
  consumeActionToken,
  consumePersonActionToken,
  liveCallbacks,
  mintActionTokens,
  type ConsumedRoutineAction,
  type ConsumedStaffAction,
} from "./action-tokens";
import { consumeLinkCode, findLinkByChat, findPersonLinkByChat, setPersonLinkStopped } from "./linking";
import { buildHelp, buildMorningSummary, buildNotLinked, buildRoutineMessage, buildTasksList } from "./messages";
import {
  buildMoveOptions,
  buildRoutineMessageRu,
  buildRoutinePickRu,
  buildStaffTaskCard,
  STAFF_CARD_KINDS,
  type StaffCardKind,
  buildStaffHelp,
  buildStaffTaskList,
  buildStaffWelcome,
  buildWhichTask,
  MOVE_DAYS,
  remainingItems,
  routineCommentPrompt,
  RU,
  RU_ROUTINE,
  ruDate,
  type RoutineCommentKind,
  type RoutineMessageMode,
} from "./messages-ru";
import { OPEN_RUN_STATUSES, type AwaitingComment, type RunStatus } from "@/lib/routines";
import type { Routine, RoutineRun } from "@/server/db/schema";
import {
  addRoutineComment,
  findAwaitingComment,
  listOpenRunsForPerson,
  loadRunForActor,
  markRoutineItems,
  routineMessageInput,
  setAwaitingComment,
  tickRoutineRun,
  type TickActor,
} from "@/server/services/routines";
import { escapeHtml, fitTelegram, renderTelegram } from "./render-telegram";
import { TelegramApi, type TelegramMessage, type TelegramUpdate } from "./telegram-api";
import type { NeutralMessage } from "./types";

/** A Bot API call the handler wants made. Executed by `executeBotActions` (or shown in dev). */
export interface BotAction {
  method: "sendMessage" | "answerCallbackQuery" | "editMessageText";
  params: Record<string, unknown>;
}

function reply(chatId: number | string, message: NeutralMessage, callbacks?: Record<string, string | undefined>): BotAction {
  return { method: "sendMessage", params: { chat_id: chatId, ...renderTelegram(message, callbacks) } };
}

function plain(chatId: number | string, title: string, text: string): BotAction {
  return reply(chatId, { title, lines: [{ text }] });
}

/**
 * Handles one Telegram update (from the webhook or the dev poller).
 * - Unlinked chats get one polite "not linked" reply and nothing else.
 * - A founder's chat acts strictly as that founder, through the service layer.
 * - A person's chat (staff, linked with an invite code) acts as that PERSON: only their own tasks,
 *   through services/staff-tasks.ts; replies in Russian.
 * - Buttons carry only a server-side token; it must belong to the linked founder or person.
 */
export async function handleTelegramUpdate(db: Db, update: TelegramUpdate, now: Date): Promise<BotAction[]> {
  if (update.callback_query) return handleCallback(db, update.callback_query, now);
  const msg = update.message;
  if (!msg?.from || msg.from.is_bot) return [];
  const chatId = msg.chat.id;
  const text = msg.text?.trim() ?? "";
  const [rawCommand, ...args] = text.split(/\s+/);
  const command = text.startsWith("/") ? (rawCommand ?? "").toLowerCase().replace(/@\w+$/, "") : "";

  if (command === "/start" && args.length > 0) {
    if (msg.chat.type !== "private") {
      return [plain(chatId, "Private chats only", `Please send the code to the bot in a private chat. ${RU.privateOnly}`)];
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
      if (result.reason === "chat_taken") return [plain(chatId, "Код не принят", RU.chatTaken)];
      return [
        plain(
          chatId,
          "Code not accepted",
          `This code is wrong, expired or already used. Generate a new one on the Settings page. ${RU.codeInvalid}`,
        ),
      ];
    }
    if (result.kind === "person") return [reply(chatId, buildStaffWelcome(result.name))];
    return [
      plain(chatId, `Linked to ${result.shortName}`, "From now on your reminders and summaries come here. Send /help to see what I can do."),
    ];
  }

  if (msg.chat.type !== "private") return text ? [reply(chatId, buildNotLinked())] : [];
  const link = await findLinkByChat(db, String(chatId), String(msg.from.id));
  if (link) {
    if (!text) return [];
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
      case "/stop":
        await db.delete(telegramLinks).where(and(eq(telegramLinks.id, link.link.id), isNotNull(telegramLinks.userId)));
        return [plain(chatId, "Unlinked", "No more messages here. Generate a new link code on the Settings page to link again.")];
      default:
        return [reply(chatId, buildHelp())];
    }
  }

  const personLink = await findPersonLinkByChat(db, String(chatId), String(msg.from.id));
  if (personLink) {
    const pctx = personContext(db, personLink.person, now);
    try {
      return await handlePersonMessage(pctx, personLink.link, msg, command, args, update.update_id);
    } catch (err) {
      const se = toServiceError(err);
      if (!se) throw err;
      return [plain(chatId, "Не получилось", se.code === "not_found" ? RU.notYourTask : se.code === "validation" ? "Сообщение слишком длинное или пустое." : se.message)];
    }
  }
  return text ? [reply(chatId, buildNotLinked())] : [];
}

/** Kinds of non-text content, named for the founders' line. */
function fileKind(msg: TelegramMessage): string | null {
  if (msg.voice || msg.audio || msg.video_note) return "voice message";
  if (msg.photo) return "photo";
  if (msg.video) return "video";
  if (msg.document) return "file";
  if (msg.sticker) return "sticker";
  return null;
}

async function withButtons(pctx: PersonContext, chatId: number, message: NeutralMessage): Promise<BotAction> {
  const callbacks = message.actions?.length
    ? await mintActionTokens(pctx.db, { personId: pctx.person.id, outboxId: null, actions: message.actions, now: pctx.now })
    : undefined;
  return reply(chatId, message, callbacks);
}

const today = (pctx: PersonContext) => todayInTimeZone(pctx.now, pctx.timeZone);

async function handlePersonMessage(
  pctx: PersonContext,
  link: { id: string; stoppedAt: Date | null },
  msg: TelegramMessage,
  command: string,
  args: string[],
  updateId: number,
): Promise<BotAction[]> {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() ?? "";
  if (link.stoppedAt) {
    if (command === "/start") {
      await setPersonLinkStopped(pctx.db, link.id, null);
      await personBotSwitched(pctx, false);
      return [plain(chatId, "Бот включён", RU.resumed)];
    }
    return [plain(chatId, "Сообщения отключены", RU.stoppedHint)];
  }
  if (!text) {
    const kind = fileKind(msg);
    if (!kind) return [];
    await personSentFile(pctx, kind, updateId);
    return [plain(chatId, "Только текст", RU.textOnly)];
  }
  switch (command) {
    case "/start":
      return [reply(chatId, buildStaffWelcome(pctx.person.shortName || pctx.person.fullName))];
    case "/help":
      return [reply(chatId, buildStaffHelp())];
    case "/tasks":
      return [await withButtons(pctx, chatId, buildStaffTaskList(await listPersonOpenTasks(pctx), today(pctx)))];
    case "/routines": {
      // Today's open runs, each with its buttons (a checklist shows only what is not ticked yet).
      const runs = await listOpenRunsForPerson(pctx.db, pctx.person.id, pctx.now);
      if (!runs.length) return [plain(chatId, "Рутины", RU_ROUTINE.none)];
      const out: BotAction[] = [];
      for (const { routine, run } of runs) {
        out.push(await withButtons(pctx, chatId, buildRoutineMessageRu(await routineMessageInput(pctx.db, routine, run), "ask")));
      }
      return out;
    }
    case "/stop":
      await setPersonLinkStopped(pctx.db, link.id, pctx.now);
      await pctx.db
        .update(notificationsOutbox)
        .set({ status: "cancelled", lastError: "stopped", nextAttemptAt: null })
        .where(
          and(
            eq(notificationsOutbox.personId, pctx.person.id),
            // Waiting, held (quiet hours / pause are pending with a later attempt), not linked or parked.
            inArray(notificationsOutbox.status, ["pending", "not_linked", "parked"]),
          ),
        );
      await personBotSwitched(pctx, true);
      return [plain(chatId, "Сообщения отключены", RU.stopped)];
    case "/done": {
      const n = Number(args[0]);
      const open = await listPersonOpenTasks(pctx);
      const task = Number.isInteger(n) && n >= 1 ? open[n - 1] : undefined;
      if (!task) return [plain(chatId, "Не найдено", RU.doneNotFound)];
      const r = await personMarkDone(pctx, task.id);
      return [plain(chatId, task.title, r.review ? RU.review : RU.done)];
    }
    default:
      if (command) return [reply(chatId, buildStaffHelp())];
  }
  // «💬 Комментарий» was pressed: this text is that task's comment.
  const waiting = await takePendingComment(pctx, link.id);
  const waitingTask = waiting ? await getPersonTask(pctx, waiting).catch(() => null) : null;
  if (waitingTask) {
    await personComment(pctx, waitingTask.task.id, text);
    return [plain(chatId, waitingTask.task.title, RU.commentSaved)];
  }
  // Free text right after «Комментарий» / «Частично» / «Не могу»: the comment on that routine run.
  const pending = await findAwaitingComment(pctx.db, { personId: pctx.person.id }, pctx.now);
  if (pending) return routineCommentReply(pctx, chatId, pending, text.slice(0, 2000));
  // Free text: a reply to a task message becomes that task's comment; otherwise "К какой задаче?".
  if (msg.reply_to_message) {
    const [row] = await pctx.db
      .select({ taskId: notificationsOutbox.taskId })
      .from(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.personId, pctx.person.id),
          eq(notificationsOutbox.providerMessageId, String(msg.reply_to_message.message_id)),
          isNotNull(notificationsOutbox.taskId),
        ),
      )
      .limit(1);
    const own = row?.taskId ? await getPersonTask(pctx, row.taskId).catch(() => null) : null;
    if (own) {
      await personComment(pctx, own.task.id, text);
      return [plain(chatId, own.task.title, RU.commentSaved)];
    }
  }
  const open = await listPersonOpenTasks(pctx);
  if (!open.length) {
    await personMessageWithoutTask(pctx, text, updateId);
    return [plain(chatId, "Передано", RU.noTasksComment)];
  }
  return [await withButtons(pctx, chatId, buildWhichTask(open, text.slice(0, 4000)))];
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
  if (!link) {
    const personLink = await findPersonLinkByChat(db, String(chat.id), String(cq.from.id));
    if (personLink && !personLink.link.stoppedAt) {
      return handlePersonCallback(personContext(db, personLink.person, now), personLink.link.id, cq, answer);
    }
    return [answer("This chat is not linked to Founder Cockpit.")];
  }

  const token = await consumeActionToken(db, cq.data, link.user.id, now);
  if (!token) return [answer("This button has expired or was already used.")];

  if (token.kind === "routine") {
    return routineCallback(db, cq, { userId: link.user.id }, token, now, answer, false);
  }

  let result: string;
  try {
    const ctx = makeContext(db, link.user, now);
    if (token.kind === "task") result = await applyTaskAction(ctx, token.action, token.taskId);
    else if (token.kind === "holding") result = await applyHoldingAskAction(ctx, token.askId);
    else {
      const d = await decideDeadlineRequest(ctx, token.requestId, token.action === "deadline_approve");
      result = d.status === "approved" ? `Approved: deadline moved to ${d.proposedDueDate}` : "Declined: the deadline stays";
    }
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return [answer(se.code === "not_found" ? (token.kind === "task" ? "Task not found." : "Not found.") : se.message)];
  }

  const actions: BotAction[] = [answer(result)];
  if (cq.message) {
    const subject =
      token.kind === "task"
        ? (s: Live) => s.taskId === token.taskId
        : token.kind === "holding"
          ? (s: Live) => s.holdingAskId === token.askId
          : (s: Live) => s.deadlineRequestId === token.requestId;
    const keyboard = await remainingKeyboard(db, cq.message, cq.data, subject, link.user.id, now);
    actions.push(editAction(chat.id, cq.message, result, keyboard));
  }
  return actions;
}

async function handlePersonCallback(
  pctx: PersonContext,
  linkId: string,
  cq: NonNullable<TelegramUpdate["callback_query"]>,
  answer: (text: string) => BotAction,
): Promise<BotAction[]> {
  const consumed = await consumePersonActionToken(pctx.db, cq.data!, pctx.person.id, pctx.now);
  if (!consumed) return [answer(RU.buttonExpired)];
  if (consumed.kind === "routine") return routineCallback(pctx.db, cq, { personId: pctx.person.id }, consumed, pctx.now, answer, true);
  const token: ConsumedStaffAction = consumed;
  const chatId = cq.message!.chat.id;
  const extra: BotAction[] = [];
  let result: string;
  // Which buttons of the message stay: Принято / Перенести срок keep the task's other buttons;
  // Готово, a deadline option and a "К какой задаче?" pick remove the task's (or all) buttons.
  let drop: "pressed" | "task" | "all" = "pressed";
  try {
    switch (token.action) {
      case "staff_accept":
        await personAccept(pctx, token.taskId);
        result = RU.accepted;
        break;
      case "staff_done": {
        const r = await personMarkDone(pctx, token.taskId);
        result = r.alreadyClosed ? (r.review ? RU.alreadyInReview : RU.alreadyDone) : r.review ? RU.review : RU.done;
        drop = "task";
        break;
      }
      case "staff_help":
        await personHelp(pctx, token.taskId);
        result = RU.help;
        break;
      case "staff_move": {
        const own = await getPersonTask(pctx, token.taskId);
        if (own.task.status === "done" || own.task.status === "cancelled") {
          result = RU.noDeadlineMove;
          break;
        }
        extra.push(await withButtons(pctx, chatId, buildMoveOptions(toLite(own.task, own.companyName), today(pctx))));
        result = "Выберите новый срок";
        break;
      }
      case "staff_move_1d":
      case "staff_move_3d":
      case "staff_move_7d": {
        const proposed = await personRequestDeadline(pctx, token.taskId, MOVE_DAYS[token.action]);
        result = RU.moveRequested(ruDate(proposed));
        drop = "all";
        break;
      }
      case "staff_comment_pick": {
        const text = typeof token.payload.text === "string" ? token.payload.text : "";
        await personComment(pctx, token.taskId, text);
        result = RU.commentSaved;
        drop = "all";
        break;
      }
      case "staff_comment":
        await personStartComment(pctx, linkId, token.taskId);
        // The card shows the prompt (and the popup too); the next text is the comment.
        result = RU.commentPrompt;
        break;
      case "staff_check": {
        const item = typeof token.payload.item === "string" ? token.payload.item : "";
        const r = await personCheckItem(pctx, token.taskId, item);
        result = r.status === "already" ? RU.alreadyChecked : RU.checked(r.label, r.remaining);
        break;
      }
    }
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return [answer(se.code === "not_found" ? RU.notYourTask : se.code === "validation" ? RU.noDeadlineMove : se.message)];
  }
  const actions: BotAction[] = [answer(result)];
  // A task card (0032): re-draw the SAME message with the task's new state (✅ items, «Принято»,
  // done) and fresh buttons, instead of only appending a line.
  const cardKind = token.payload.card;
  if (cq.message && typeof cardKind === "string" && (STAFF_CARD_KINDS as readonly string[]).includes(cardKind)) {
    const card = await loadStaffCard(pctx, token.taskId).catch(() => null);
    if (card) {
      const message = buildStaffTaskCard(card, today(pctx), cardKind as StaffCardKind, result);
      const callbacks = message.actions?.length
        ? await mintActionTokens(pctx.db, { personId: pctx.person.id, outboxId: null, actions: message.actions, now: pctx.now })
        : undefined;
      const rendered = renderTelegram(fitTelegram(message).message, callbacks);
      actions.push({
        method: "editMessageText",
        params: {
          chat_id: chatId,
          message_id: cq.message.message_id,
          text: rendered.text,
          parse_mode: "HTML",
          // Without reply_markup Telegram removes the keyboard (a closed task has no buttons).
          ...(rendered.reply_markup ? { reply_markup: rendered.reply_markup } : {}),
        },
      });
      return [...actions, ...extra];
    }
  }
  if (cq.message) {
    const keyboard =
      drop === "all"
        ? []
        : await remainingKeyboard(
            pctx.db,
            cq.message,
            cq.data!,
            drop === "task" ? (s) => s.taskId === token.taskId : () => false,
            { personId: pctx.person.id },
            pctx.now,
          );
    actions.push(editAction(chatId, cq.message, result, keyboard));
  }
  return [...actions, ...extra];
}

function editAction(chatId: number, message: TelegramMessage, result: string, keyboard: Button[][]): BotAction {
  const original = message.text ? escapeHtml(message.text) : "";
  // editMessageText without reply_markup removes every button, so the message's other buttons
  // are sent again — only those that still work.
  return {
    method: "editMessageText",
    params: {
      chat_id: chatId,
      message_id: message.message_id,
      text: `${original}\n\n<i>${escapeHtml(result)}</i>`.trim(),
      parse_mode: "HTML",
      ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    },
  };
}

type Button = { text: string; callback_data: string };
type Live = { taskId: string | null; holdingAskId: string | null; deadlineRequestId: string | null; routineRunId: string | null };

const ownerOf = (actor: TickActor) => ("personId" in actor ? { personId: actor.personId } : { userId: actor.userId });

/** The routine message of a run as it stands now (Russian for a person, English for a founder). */
async function routineMessageFor(db: Db, routine: Routine, run: RoutineRun, russian: boolean, mode: RoutineMessageMode = "ask"): Promise<NeutralMessage> {
  const input = await routineMessageInput(db, routine, run);
  return russian ? buildRoutineMessageRu(input, mode) : buildRoutineMessage(input, mode === "reminder");
}

/** Edits a message in place to `message`, with fresh one-time tokens for its buttons (none = no keyboard). */
async function editInPlace(db: Db, chatId: number | string, messageId: number, message: NeutralMessage, actor: TickActor, now: Date): Promise<BotAction> {
  const fitted = fitTelegram(message).message;
  const callbacks = fitted.actions?.length ? await mintActionTokens(db, { ...ownerOf(actor), outboxId: null, actions: fitted.actions, now }) : undefined;
  return { method: "editMessageText", params: { chat_id: chatId, message_id: messageId, ...renderTelegram(fitted, callbacks) } };
}

/**
 * A routine button (founder or person), as the routine's assignee only (another person's or a
 * forged token never gets here: tokens are bound to their owner, and the services re-check the
 * assignee). A tick EDITS the message in place: the checklist with its new state, «Прогресс 3/5»,
 * buttons for what is still open, and at the end «Готово, спасибо! 5/5 ✅». «💬 Комментарий» /
 * «🟡 Частично» / «❌ Не могу» (staff) first offer a pick of the item on a checklist, then the bot
 * asks for the comment: the person's next text message is saved (see handlePersonMessage).
 */
async function routineCallback(
  db: Db,
  cq: NonNullable<TelegramUpdate["callback_query"]>,
  actor: TickActor,
  token: ConsumedRoutineAction,
  now: Date,
  answer: (text: string) => BotAction,
  russian: boolean,
): Promise<BotAction[]> {
  const chatId = cq.message?.chat.id;
  const messageId = cq.message?.message_id;
  const notFound = () => [answer(russian ? RU_ROUTINE.notYours : "Not found.")];
  try {
    if (token.action === "routine_tick" || token.action === "routine_done") {
      const r = await tickRoutineRun(db, token.runId, actor, token.action === "routine_tick" ? token.item : null, now);
      let result: string;
      if (russian) {
        result =
          r.status === "done"
            ? RU_ROUTINE.done
            : r.status === "closed"
              ? RU_ROUTINE.closed
              : r.status === "already"
                ? RU_ROUTINE.already
                : RU_ROUTINE.ticked(r.label ?? "", r.remaining.length);
      } else {
        result =
          r.status === "done"
            ? "Routine done ✓"
            : r.status === "closed"
              ? "Today's run is already closed"
              : r.status === "already"
                ? "Already ticked"
                : `✓ ${r.label}. ${r.remaining.length} left`;
      }
      const actions: BotAction[] = [answer(result)];
      if (chatId !== undefined && messageId !== undefined) {
        actions.push(await editInPlace(db, chatId, messageId, await routineMessageFor(db, r.routine, r.run, russian), actor, now));
        // An item flagged "needs a comment": the next text message is its comment.
        if (russian && r.needsComment && r.status !== "already" && token.item) {
          await setAwaitingComment(db, r.run.id, actor, { item: token.item, kind: "done", since: now.toISOString(), chatId, messageId });
          actions.push(reply(chatId, routineCommentPrompt("done", r.label)));
        }
      }
      return actions;
    }

    // Comment / partly / can't / pick / back: staff only.
    if (!russian) return [answer("Use the app for comments.")];
    const { routine, run } = await loadRunForActor(db, token.runId, actor);
    const open = OPEN_RUN_STATUSES.includes(run.status as RunStatus);
    const input = await routineMessageInput(db, routine, run);
    if (token.action === "routine_back") {
      await setAwaitingComment(db, run.id, actor, null);
      const actions: BotAction[] = [answer("↩")];
      if (chatId !== undefined && messageId !== undefined) actions.push(await editInPlace(db, chatId, messageId, buildRoutineMessageRu(input), actor, now));
      return actions;
    }
    const kind: RoutineCommentKind =
      token.action === "routine_pick" ? (token.pickKind ?? "comment") : token.action === "routine_partly" ? "partly" : token.action === "routine_cant" ? "cant" : "comment";
    if (kind !== "comment" && !open) return [answer(RU_ROUTINE.closed)];
    let item: string | null;
    if (token.action === "routine_pick") {
      item = token.item && token.item !== "_all" ? token.item : null;
    } else {
      const choices = kind === "comment" ? run.items : remainingItems(input);
      // A checklist with a real choice: pick the item first.
      if (run.items.length && (kind === "comment" ? choices.length >= 1 : choices.length > 1)) {
        const actions: BotAction[] = [answer(RU_ROUTINE.pick)];
        if (chatId !== undefined && messageId !== undefined) actions.push(await editInPlace(db, chatId, messageId, buildRoutinePickRu(input, kind), actor, now));
        return actions;
      }
      item = choices.length === 1 ? choices[0]!.key : null;
    }
    await setAwaitingComment(db, run.id, actor, { item, kind, since: now.toISOString(), chatId: chatId ?? null, messageId: messageId ?? null });
    const label = item ? (run.items.find((i) => i.key === item)?.label ?? null) : null;
    const actions: BotAction[] = [answer(RU_ROUTINE.writeComment)];
    if (chatId !== undefined && messageId !== undefined) {
      if (token.action === "routine_pick") actions.push(await editInPlace(db, chatId, messageId, buildRoutineMessageRu(input), actor, now));
      actions.push(reply(chatId, routineCommentPrompt(kind, label)));
    }
    return actions;
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    if (se.code === "not_found") return notFound();
    return [answer(se.code === "conflict" && russian ? RU_ROUTINE.closed : se.message)];
  }
}

/**
 * The person's text after «Комментарий» / «Частично» / «Не могу» (or a "needs a comment" tick):
 * saved on the run / item; «Частично» / «Не могу» mark the item(s) with it (founders are told about
 * «Не могу»). The routine message is edited to its new state.
 */
async function routineCommentReply(
  pctx: PersonContext,
  chatId: number,
  pending: { routine: Routine; run: RoutineRun; awaiting: AwaitingComment },
  text: string,
): Promise<BotAction[]> {
  const actor = { personId: pctx.person.id };
  const { awaiting } = pending;
  let routine: Routine;
  let run: RoutineRun;
  let saved: string;
  if (awaiting.kind === "partly" || awaiting.kind === "cant") {
    const res = await markRoutineItems(pctx.db, pending.run.id, actor, { item: awaiting.item, state: awaiting.kind, comment: text }, pctx.now);
    routine = res.routine;
    run = res.run;
    saved = awaiting.kind === "partly" ? RU_ROUTINE.partlySaved : RU_ROUTINE.cantSaved;
  } else {
    const res = await addRoutineComment(pctx.db, pending.run.id, actor, { item: awaiting.item, text, kind: awaiting.kind }, pctx.now);
    routine = res.routine;
    run = res.run;
    saved = RU_ROUTINE.commentSaved;
  }
  const out: BotAction[] = [];
  if (awaiting.messageId && awaiting.chatId !== undefined && awaiting.chatId !== null) {
    out.push(await editInPlace(pctx.db, awaiting.chatId, awaiting.messageId, await routineMessageFor(pctx.db, routine, run, true), actor, pctx.now));
  }
  out.push(plain(chatId, routine.title, saved));
  return out;
}

async function remainingKeyboard(
  db: Db,
  message: TelegramMessage,
  pressed: string,
  sameSubject: (s: Live) => boolean,
  owner: string | { personId: string },
  now: Date,
): Promise<Button[][]> {
  const isButton = (b: unknown): b is Button =>
    !!b && typeof (b as Button).callback_data === "string" && (b as Button).callback_data !== pressed;
  const original = (message.reply_markup?.inline_keyboard ?? []).map((row) => row.filter(isButton));
  const buttons = original.flat();
  if (!buttons.length) return [];
  const live = await liveCallbacks(db, buttons.map((b) => b.callback_data), owner, now);
  const keep = (b: Button) => {
    const s = live.get(b.callback_data);
    return !!s && !sameSubject(s);
  };
  // Keep the original layout (the grouped overdue push has one row per task); empty rows go.
  return original.map((row) => row.filter(keep)).filter((row) => row.length > 0);
}

/** Performs the calls through the Bot API. Errors are logged, never thrown (Telegram would retry). */
export async function executeBotActions(actions: BotAction[], token: string): Promise<void> {
  const api = new TelegramApi(token);
  for (const a of actions) {
    const res = await api.call(a.method, a.params);
    if (!res.ok) console.warn(`[telegram] ${a.method} failed: ${res.description ?? "unknown error"}`);
  }
}
