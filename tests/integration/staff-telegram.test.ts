import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNotNull } from "drizzle-orm";
import {
  notificationActionTokens,
  notificationsOutbox,
  people,
  taskComments,
  taskDeadlineRequests,
  taskEvents,
  tasks,
  telegramLinkCodes,
  telegramLinks,
  type OutboxItem,
} from "@/server/db/schema";
import { mintActionTokens } from "@/server/notifications/action-tokens";
import type { ChannelRegistry } from "@/server/notifications/channels";
import { dispatch } from "@/server/notifications/dispatcher";
import { createLinkCode } from "@/server/notifications/linking";
import { planTick } from "@/server/notifications/planner";
import { handleTelegramUpdate, type BotAction } from "@/server/notifications/telegram-bot";
import type { TelegramUpdate } from "@/server/notifications/telegram-api";
import { actionKey, type ActionCallbacks, type NeutralMessage, type NotificationChannel } from "@/server/notifications/types";
import {
  createPersonInvite,
  listTeamOnTelegram,
  setPersonBotEnabled,
  setPersonChase,
  setPersonPause,
  setTaskStaffChase,
  unlinkPerson,
  updateStaffDefaults,
} from "@/server/services/staff";
import {
  addTaskComment,
  decideDeadlineRequest,
  deleteTaskComment,
  getTaskStaffTrail,
  listTaskComments,
  updateTaskComment,
} from "@/server/services/task-comments";
import { createTask, getTask, updateTask } from "@/server/services/tasks";
import { DEFAULT_STAFF_SETTINGS } from "@/lib/staff-schemas";
import { createTestDb, type TestDb } from "../helpers/db";

/** Bishkek = UTC+6. "2026-11-02 10:00 local" → "2026-11-02T04:00:00Z". */
const local = (day: string, hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), h! - 6, m!));
};
const D = "2026-11-02";

let t: TestDb;
let edil: string;
let elmurat: string;
const EDIL_CHAT = 5_000_001;
const ELMURAT_CHAT = 5_000_002;
const FOUNDER_CHAT = 5_000_009;

beforeAll(async () => {
  t = await createTestDb();
  edil = t.personIds.edil!;
  elmurat = t.personIds.elmurat!;
});
afterAll(async () => {
  await t.handle.close();
});
beforeEach(async () => {
  const db = t.handle.db;
  await db.delete(notificationActionTokens);
  await db.delete(notificationsOutbox);
  await db.delete(taskComments);
  await db.delete(taskDeadlineRequests);
  await db.delete(telegramLinks);
  await db.delete(telegramLinkCodes);
  await db.delete(taskEvents);
  await db.delete(tasks);
  await db.update(people).set({ botEnabled: false, botEnabledAt: null, botPausedUntil: null, staffChase: null });
  await updateStaffDefaults(t.ctx("nuraaly"), { ...DEFAULT_STAFF_SETTINGS });
});

interface Sent {
  to: string;
  personId: string | null;
  message: NeutralMessage;
  callbacks: ActionCallbacks;
}
function recorder() {
  const sent: Sent[] = [];
  let n = 100;
  const channel: NotificationChannel = {
    name: "telegram",
    async send(recipient, message, callbacks) {
      sent.push({ to: recipient.userId, personId: recipient.personId ?? null, message, callbacks: callbacks ?? {} });
      return { ok: true, providerMessageId: String(n++) };
    },
  };
  // Founders are reachable (as with the dev inbox); a person needs a linked chat.
  const registry: ChannelRegistry = { get: () => channel, resolve: (r) => (!r.personId || r.telegramChatId ? channel : null) };
  return { sent, registry };
}

const msgUpdate = (chatId: number, text: string, extra: Record<string, unknown> = {}, type = "private"): TelegramUpdate => ({
  update_id: Math.floor(Math.random() * 1e9),
  message: { message_id: 1, chat: { id: chatId, type: type as "private" }, from: { id: chatId, first_name: "X" }, text, ...extra },
});
const press = (chatId: number, data: string, keyboard: string[] = [data]): TelegramUpdate => ({
  update_id: Math.floor(Math.random() * 1e9),
  callback_query: {
    id: "cq",
    from: { id: chatId },
    data,
    message: {
      message_id: 77,
      chat: { id: chatId, type: "private" },
      text: "msg",
      reply_markup: { inline_keyboard: [keyboard.map((d) => ({ text: "b", callback_data: d }))] },
    },
  },
});
const textOf = (a: BotAction[]) => a.map((x) => String(x.params.text ?? "")).join("\n");

async function linkPerson(personId: string, chatId: number, at = local(D, "08:30")) {
  const invite = await createPersonInvite(t.ctx("nuraaly", at), personId);
  const res = await handleTelegramUpdate(t.handle.db, msgUpdate(chatId, `/start ${invite.code}`), at);
  return { invite, res };
}
async function onTelegram(personId: string, chatId: number, at = local(D, "08:30")) {
  await linkPerson(personId, chatId, at);
  await setPersonBotEnabled(t.ctx("nuraaly", at), personId, true);
}
async function edilTask(title: string, dueDate: string | null, at = local(D, "08:40"), priority: "normal" | "urgent" = "normal") {
  return createTask(t.ctx("nuraaly", at), {
    title,
    visibility: "shared",
    companyId: t.companyIds.jobutify,
    assigneePersonId: edil,
    status: "todo",
    priority,
    dueDate,
  });
}
async function tick(at: Date, reg = recorder()) {
  await planTick(t.handle.db, at, { timeZone: "Asia/Bishkek" });
  await dispatch(t.handle.db, at, { registry: reg.registry, timeZone: "Asia/Bishkek" });
  return reg;
}
const personRows = async (personId: string): Promise<OutboxItem[]> =>
  t.handle.db.select().from(notificationsOutbox).where(eq(notificationsOutbox.personId, personId));
const founderStaffRows = async (userId: string) =>
  t.handle.db
    .select()
    .from(notificationsOutbox)
    .where(and(eq(notificationsOutbox.userId, userId), eq(notificationsOutbox.kind, "staff_update")));
const cb = (s: Sent, action: string, taskId: string) => s.callbacks[actionKey({ action, taskId })]!;

describe("linking a person", () => {
  it("invite → deep link → /start CODE in a private chat links the person and greets in Russian", async () => {
    const { invite, res } = await linkPerson(edil, EDIL_CHAT);
    expect(invite.deepLink).toBe(`https://t.me/founders_app_bot?start=${encodeURIComponent(invite.code)}`);
    expect(textOf(res)).toContain("Здравствуйте, Edil");
    const [link] = await t.handle.db.select().from(telegramLinks).where(eq(telegramLinks.personId, edil));
    expect(link!.chatId).toBe(String(EDIL_CHAT));
    expect(link!.userId).toBeNull();
    const team = await listTeamOnTelegram(t.ctx("nuraaly"));
    expect(team.find((m) => m.id === edil)).toMatchObject({ state: "linked", botEnabled: false, reachable: false });
  });

  it("uses TELEGRAM_BOT_USERNAME for the deep link when set", async () => {
    process.env.TELEGRAM_BOT_USERNAME = "@other_bot";
    try {
      const inv = await createPersonInvite(t.ctx("nuraaly"), edil);
      expect(inv.deepLink.startsWith("https://t.me/other_bot?start=")).toBe(true);
    } finally {
      delete process.env.TELEGRAM_BOT_USERNAME;
    }
  });

  it("a code works once, expires after 15 minutes, and only in a private chat", async () => {
    const at = local(D, "08:00");
    const inv = await createPersonInvite(t.ctx("nuraaly", at), edil);
    const group = await handleTelegramUpdate(t.handle.db, msgUpdate(EDIL_CHAT, `/start ${inv.code}`, {}, "group"), at);
    expect(textOf(group)).toContain("личном чате");
    const late = await handleTelegramUpdate(t.handle.db, msgUpdate(EDIL_CHAT, `/start ${inv.code}`), new Date(at.getTime() + 16 * 60_000));
    expect(textOf(late)).toContain("Code not accepted");

    const inv2 = await createPersonInvite(t.ctx("nuraaly", at), edil);
    expect(textOf(await handleTelegramUpdate(t.handle.db, msgUpdate(EDIL_CHAT, `/start ${inv2.code}`), at))).toContain("Здравствуйте");
    const again = await handleTelegramUpdate(t.handle.db, msgUpdate(EDIL_CHAT + 7, `/start ${inv2.code}`), at);
    expect(textOf(again)).toContain("Code not accepted");
  });

  it("a person's code never takes over a founder's chat; founders are not invited as staff", async () => {
    const { code } = await createLinkCode(t.handle.db, t.userIds.nuraaly, local(D, "08:00"));
    await handleTelegramUpdate(t.handle.db, msgUpdate(FOUNDER_CHAT, `/start ${code}`), local(D, "08:00"));
    const inv = await createPersonInvite(t.ctx("nuraaly"), edil);
    const res = await handleTelegramUpdate(t.handle.db, msgUpdate(FOUNDER_CHAT, `/start ${inv.code}`), local(D, "08:01"));
    expect(textOf(res)).toContain("основателю");
    const [founderLink] = await t.handle.db.select().from(telegramLinks).where(eq(telegramLinks.userId, t.userIds.nuraaly));
    expect(founderLink).toBeDefined();
    const [nuraalyPerson] = await t.handle.db.select().from(people).where(eq(people.userId, t.userIds.nuraaly));
    await expect(createPersonInvite(t.ctx("nuraaly"), nuraalyPerson!.id)).rejects.toThrow(/Settings/);
  });

  it("/stop deactivates the link (founders get one line), /start turns it back on; founders' /stop unlinks", async () => {
    await onTelegram(edil, EDIL_CHAT);
    const stop = await handleTelegramUpdate(t.handle.db, msgUpdate(EDIL_CHAT, "/stop"), local(D, "09:00"));
    expect(textOf(stop)).toContain("больше не будут приходить");
    const [link] = await t.handle.db.select().from(telegramLinks).where(eq(telegramLinks.personId, edil));
    expect(link!.stoppedAt).not.toBeNull();
    const lines = await founderStaffRows(t.userIds.nuraaly);
    expect(lines.some((r) => String((r.payload as { summaryLine: string }).summaryLine).includes("stopped the bot"))).toBe(true);
    expect(lines.every((r) => r.status === "parked")).toBe(true);

    // Nothing is sent while stopped.
    await edilTask("While stopped", D, local(D, "09:05"));
    const reg = await tick(local(D, "09:10"));
    expect(reg.sent.filter((s) => s.personId)).toHaveLength(0);

    const resume = await handleTelegramUpdate(t.handle.db, msgUpdate(EDIL_CHAT, "/start"), local(D, "09:20"));
    expect(textOf(resume)).toContain("снова включены");

    const { code } = await createLinkCode(t.handle.db, t.userIds.talant, local(D, "08:00"));
    await handleTelegramUpdate(t.handle.db, msgUpdate(FOUNDER_CHAT + 1, `/start ${code}`), local(D, "08:00"));
    const fStop = await handleTelegramUpdate(t.handle.db, msgUpdate(FOUNDER_CHAT + 1, "/stop"), local(D, "08:05"));
    expect(textOf(fStop)).toContain("Unlinked");
    expect(await t.handle.db.select().from(telegramLinks).where(eq(telegramLinks.userId, t.userIds.talant))).toHaveLength(0);
  });

  it("unlink forgets the chat and cancels what was waiting", async () => {
    await onTelegram(edil, EDIL_CHAT);
    await unlinkPerson(t.ctx("nuraaly"), edil);
    const res = await handleTelegramUpdate(t.handle.db, msgUpdate(EDIL_CHAT, "/tasks"), local(D, "09:00"));
    expect(textOf(res)).toContain("not linked");
  });
});

describe("who gets messages", () => {
  it("a linked person who is not switched on gets nothing; nor does a switched-on person who never linked", async () => {
    await linkPerson(edil, EDIL_CHAT);
    await setPersonBotEnabled(t.ctx("nuraaly"), elmurat, true);
    await edilTask("Not enabled", D);
    await createTask(t.ctx("nuraaly", local(D, "08:40")), {
      title: "Elmurat task",
      visibility: "shared",
      companyId: t.companyIds.jobutify,
      assigneePersonId: elmurat,
      status: "todo",
      priority: "normal",
      dueDate: D,
    });
    const reg = await tick(local(D, "09:00"));
    expect(reg.sent.filter((s) => s.personId)).toHaveLength(0);
    expect(await personRows(edil)).toHaveLength(0);
    expect(await personRows(elmurat)).toHaveLength(0);
  });

  it("a paused person gets nothing until the pause ends; the new-task message then goes out", async () => {
    await onTelegram(edil, EDIL_CHAT);
    await setPersonPause(t.ctx("nuraaly", local(D, "08:45")), edil, D);
    await edilTask("During pause", "2026-11-05", local(D, "08:50"));
    expect((await tick(local(D, "10:00"))).sent.filter((s) => s.personId)).toHaveLength(0);
    const next = await tick(local("2026-11-03", "09:00"));
    expect(next.sent.filter((s) => s.personId).map((s) => s.message.title)).toEqual(["Новая задача: During pause"]);
  });
});

describe("task messages to staff", () => {
  it("new task → once, in Russian, with Принято / Готово / Нужна помощь / Перенести срок", async () => {
    await onTelegram(edil, EDIL_CHAT);
    const task = await edilTask("Подготовить отчёт", "2026-11-12");
    const reg = await tick(local(D, "08:45"));
    const toEdil = reg.sent.filter((s) => s.personId === edil);
    expect(toEdil).toHaveLength(1);
    expect(toEdil[0]!.message.title).toBe("Новая задача: Подготовить отчёт");
    expect(toEdil[0]!.message.lines[0]!.text).toBe("Срок: 12.11 · Компания: Jobutify");
    expect(toEdil[0]!.message.actions!.map((a) => a.label)).toEqual(["Принято", "Готово", "Нужна помощь", "Перенести срок"]);
    expect(Object.keys(toEdil[0]!.callbacks)).toHaveLength(4);
    // Not again on the next tick (not due yet: no chase either).
    expect((await tick(local(D, "10:00"))).sent.filter((s) => s.personId)).toHaveLength(0);
    // Founders are not sent anything about the person's task by the staff flow.
    expect(await founderStaffRows(t.userIds.nuraaly)).toHaveLength(0);
    expect((await getTask(t.ctx("nuraaly"), task.id)).status).toBe("todo");
  });

  it("quiet hours hold staff messages until they end", async () => {
    await onTelegram(edil, EDIL_CHAT, local(D, "07:00"));
    await edilTask("Early task", "2026-11-12", local(D, "07:10"));
    expect((await tick(local(D, "07:20"))).sent.filter((s) => s.personId)).toHaveLength(0);
    const [row] = await personRows(edil);
    expect(row!.status).toBe("pending");
    expect(row!.nextAttemptAt!.toISOString()).toBe(local(D, "08:00").toISOString());
    expect((await tick(local(D, "08:05"))).sent.filter((s) => s.personId)).toHaveLength(1);
  });

  it("due day: one chase per slot of 120 minutes inside working hours, deduped per slot, until done", async () => {
    await onTelegram(edil, EDIL_CHAT, local("2026-11-01", "10:00"));
    // Assigned yesterday (new-task message yesterday), due today.
    const task = await edilTask("Сдать акт", D, local("2026-11-01", "10:00"));
    await tick(local("2026-11-01", "10:05"));
    await tick(local(D, "08:30")); // before working hours: nothing
    const at9 = await tick(local(D, "09:00"));
    expect(at9.sent.filter((s) => s.personId).map((s) => s.message.title)).toEqual(["Напоминание: Сдать акт"]);
    // Same slot (09:00–11:00): no second chase.
    expect((await tick(local(D, "10:30"))).sent.filter((s) => s.personId)).toHaveLength(0);
    // Next slot.
    const at11 = await tick(local(D, "11:00"));
    expect(at11.sent.filter((s) => s.personId)).toHaveLength(1);
    expect(at11.sent.filter((s) => s.personId)[0]!.message.actions!.map((a) => a.label)).toEqual(["Готово", "Нужна помощь", "Перенести срок"]);
    // After working hours: nothing.
    expect((await tick(local(D, "20:30"))).sent.filter((s) => s.personId)).toHaveLength(0);
    // Overdue tomorrow: chased again, "Задача просрочена".
    const next = await tick(local("2026-11-03", "09:01"));
    const chase = next.sent.filter((s) => s.personId)[0]!;
    expect(chase.message.title).toBe("Задача просрочена: Сдать акт");
    expect(chase.message.lines[0]!.text).toContain("Просрочено на 1 дн.");

    // Готово → done, the founder gets one summary line, chasing stops.
    const done = await handleTelegramUpdate(t.handle.db, press(EDIL_CHAT, cb(chase, "staff_done", task.id)), local("2026-11-03", "09:05"));
    expect(textOf(done)).toContain("Отмечено как выполненное");
    expect((await getTask(t.ctx("nuraaly"), task.id)).status).toBe("done");
    const lines = await founderStaffRows(t.userIds.nuraaly);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ status: "parked" });
    expect((lines[0]!.payload as { summaryLine: string }).summaryLine).toBe("Edil marked done (Telegram): Сдать акт");
    expect((await tick(local("2026-11-03", "11:00"))).sent.filter((s) => s.personId)).toHaveLength(0);

    // The founder's next morning summary lists it; the trail shows sent / done.
    const morning = recorder();
    await dispatch(t.handle.db, local("2026-11-04", "08:30"), { registry: morning.registry, timeZone: "Asia/Bishkek" });
    await planTick(t.handle.db, local("2026-11-04", "08:30"), { timeZone: "Asia/Bishkek" });
    await dispatch(t.handle.db, local("2026-11-04", "08:30"), { registry: morning.registry, timeZone: "Asia/Bishkek" });
    const summary = morning.sent.find((s) => s.to === t.userIds.nuraaly && s.message.title.startsWith("Good morning"));
    expect(JSON.stringify(summary!.message)).toContain("Edil marked done (Telegram): Сдать акт");
    const trail = await getTaskStaffTrail(t.ctx("nuraaly"), task.id);
    expect(trail.map((e) => e.what)).toEqual(["New task sent", "Reminder sent", "Reminder sent", "Reminder sent", "Marked done"]);
  });

  it("a new-task message in a slot replaces that slot's chase", async () => {
    await onTelegram(edil, EDIL_CHAT, local(D, "08:00"));
    await edilTask("Today", D, local(D, "09:30"));
    const reg = await tick(local(D, "09:35"));
    expect(reg.sent.filter((s) => s.personId).map((s) => s.message.title)).toEqual(["Новая задача: Today"]);
    const chase = (await personRows(edil)).find((r) => r.kind === "staff_chase");
    expect(chase).toMatchObject({ status: "cancelled", lastError: "already_pushed_this_slot" });
  });

  it("escalates to the task's founder after 3 unanswered chases and stops; an answer resumes", async () => {
    await onTelegram(edil, EDIL_CHAT, local("2026-11-01", "10:00"));
    const task = await edilTask("Ответить клиенту", D, local("2026-11-01", "10:00"));
    await tick(local("2026-11-01", "10:05"));
    for (const hm of ["09:00", "11:00", "13:00"]) await tick(local(D, hm));
    expect((await founderStaffRows(t.userIds.nuraaly))).toHaveLength(0);
    const at15 = await tick(local(D, "15:00"));
    expect(at15.sent.filter((s) => s.personId)).toHaveLength(0);
    const esc = at15.sent.find((s) => s.to === t.userIds.nuraaly);
    expect(esc!.message.lines[0]!.text).toBe(`Edil hasn't confirmed "Ответить клиенту" (3 reminders without an answer; due ${D})`);
    // Talant (not the task's founder) is not bothered.
    expect(at15.sent.some((s) => s.to === t.userIds.talant)).toBe(false);
    // Once only.
    await tick(local(D, "17:00"));
    expect((await founderStaffRows(t.userIds.nuraaly)).filter((r) => r.dedupeKey!.startsWith("esc:"))).toHaveLength(1);
    // Edil answers (Принято): chasing resumes in the next slot.
    const [anyToken] = await t.handle.db.select().from(notificationActionTokens).where(eq(notificationActionTokens.personId, edil));
    void anyToken;
    const tokens = await mintActionTokens(t.handle.db, {
      personId: edil,
      outboxId: null,
      actions: [{ action: "staff_accept", taskId: task.id, label: "Принято" }],
      now: local(D, "17:10"),
    });
    await handleTelegramUpdate(t.handle.db, press(EDIL_CHAT, tokens[actionKey({ action: "staff_accept", taskId: task.id })]!), local(D, "17:10"));
    expect((await tick(local(D, "19:00"))).sent.filter((s) => s.personId)).toHaveLength(1);
  });

  it("every timing is a setting: global defaults, per person, per task (off / cadence / cut-off)", async () => {
    await onTelegram(edil, EDIL_CHAT, local("2026-11-01", "10:00"));
    const a = await edilTask("A", D, local("2026-11-01", "10:00"));
    const b = await edilTask("B", D, local("2026-11-01", "10:00"));
    await tick(local("2026-11-01", "10:05"));
    await setPersonChase(t.ctx("nuraaly"), edil, { workStart: "10:00", chaseEveryMinutes: "60" });
    await setTaskStaffChase(t.ctx("nuraaly"), b.id, { chaseEnabled: "false" });
    expect((await tick(local(D, "09:30"))).sent.filter((s) => s.personId)).toHaveLength(0);
    const r10 = await tick(local(D, "10:00"));
    expect(r10.sent.filter((s) => s.personId).map((s) => s.message.title)).toEqual(["Напоминание: A"]);
    expect((await tick(local(D, "11:00"))).sent.filter((s) => s.personId)).toHaveLength(1);
    // Cut-off escalation (heads-up, chasing goes on).
    await setTaskStaffChase(t.ctx("nuraaly"), a.id, { escalateAt: "11:30", escalateAfterChases: "0" });
    const r1130 = await tick(local(D, "11:30"));
    expect(r1130.sent.find((s) => s.to === t.userIds.nuraaly)!.message.lines[0]!.text).toContain('still hasn\'t closed "A"');
    // Daily cap: global max 2 per day for everyone.
    await updateStaffDefaults(t.ctx("nuraaly"), { ...DEFAULT_STAFF_SETTINGS, maxPerDay: 2 });
    expect((await tick(local(D, "12:00"))).sent.filter((s) => s.personId)).toHaveLength(0);
    const capped = (await personRows(edil)).find((r) => r.dedupeKey === `chase:${a.id}:${D}:2`);
    expect(capped).toMatchObject({ status: "cancelled", lastError: "daily_cap_full" });
  });

  it("optional morning list of their open tasks (per person)", async () => {
    await onTelegram(edil, EDIL_CHAT, local("2026-11-01", "10:00"));
    await edilTask("Later", "2026-11-20", local("2026-11-01", "10:00"));
    await tick(local("2026-11-01", "10:05"));
    expect((await tick(local(D, "09:00"))).sent.filter((s) => s.personId)).toHaveLength(0);
    await setPersonChase(t.ctx("nuraaly"), edil, { morningList: "on", morningListTime: "09:30" });
    const r = await tick(local(D, "09:30"));
    expect(r.sent.filter((s) => s.personId).map((s) => s.message.title)).toEqual(["Доброе утро, Edil! Ваши задачи"]);
  });
});

describe("what a person can do (own tasks only)", () => {
  it("buttons work only on the person's own task: forged / other-person / founder tokens do nothing", async () => {
    await onTelegram(edil, EDIL_CHAT);
    await onTelegram(elmurat, ELMURAT_CHAT);
    const task = await edilTask("Edil's", D);
    const forElmurat = await mintActionTokens(t.handle.db, {
      personId: elmurat,
      outboxId: null,
      actions: [{ action: "staff_done", taskId: task.id, label: "x" }],
      now: local(D, "09:00"),
    });
    const elmuratData = forElmurat[actionKey({ action: "staff_done", taskId: task.id })]!;
    // Elmurat presses a token minted for him on Edil's task: refused by the task rule.
    const r1 = await handleTelegramUpdate(t.handle.db, press(ELMURAT_CHAT, elmuratData), local(D, "09:01"));
    expect(r1[0]!.params.text).toBe("Эта задача вам недоступна.");
    // Edil replays Elmurat's token: not his.
    const r2 = await handleTelegramUpdate(t.handle.db, press(EDIL_CHAT, elmuratData), local(D, "09:01"));
    expect(r2[0]!.params.text).toBe("Кнопка устарела или уже нажата.");
    // A founder's token pressed in Edil's chat.
    const founderTok = await mintActionTokens(t.handle.db, {
      userId: t.userIds.nuraaly,
      outboxId: null,
      actions: [{ action: "done", taskId: task.id, label: "Done" }],
      now: local(D, "09:00"),
    });
    const r3 = await handleTelegramUpdate(t.handle.db, press(EDIL_CHAT, founderTok[actionKey({ action: "done", taskId: task.id })]!), local(D, "09:02"));
    expect(r3[0]!.params.text).toBe("Кнопка устарела или уже нажата.");
    // Garbage.
    expect((await handleTelegramUpdate(t.handle.db, press(EDIL_CHAT, "a:not-a-real-token-123456"), local(D, "09:02")))[0]!.params.text).toBe(
      "Кнопка устарела или уже нажата.",
    );
    expect((await getTask(t.ctx("nuraaly"), task.id)).status).toBe("todo");

    // Reassigned away: Edil's own earlier token stops working.
    const edilTok = await mintActionTokens(t.handle.db, {
      personId: edil,
      outboxId: null,
      actions: [{ action: "staff_done", taskId: task.id, label: "x" }],
      now: local(D, "09:00"),
    });
    await updateTask(t.ctx("nuraaly"), task.id, { assigneePersonId: null });
    const r4 = await handleTelegramUpdate(t.handle.db, press(EDIL_CHAT, edilTok[actionKey({ action: "staff_done", taskId: task.id })]!), local(D, "09:03"));
    expect(r4[0]!.params.text).toBe("Эта задача вам недоступна.");
    expect((await getTask(t.ctx("nuraaly"), task.id)).status).toBe("todo");
  });

  it("Принято is logged; Нужна помощь adds a comment and pushes the founder", async () => {
    await onTelegram(edil, EDIL_CHAT);
    const task = await edilTask("Help me", "2026-11-12");
    const reg = await tick(local(D, "09:00"));
    const s = reg.sent.find((x) => x.personId === edil)!;
    const keyboard = Object.values(s.callbacks) as string[];
    const acc = await handleTelegramUpdate(t.handle.db, press(EDIL_CHAT, cb(s, "staff_accept", task.id), keyboard), local(D, "09:05"));
    expect(acc[0]!.params.text).toBe("Принято ✓ Основатели увидят.");
    // The other buttons stay under the message.
    const edit = acc.find((a) => a.method === "editMessageText")!;
    expect((edit.params.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard[0]).toHaveLength(3);
    await handleTelegramUpdate(t.handle.db, press(EDIL_CHAT, cb(s, "staff_help", task.id)), local(D, "09:06"));
    const comments = await listTaskComments(t.ctx("nuraaly"), task.id);
    expect(comments.map((c) => [c.text, c.kind, c.source, c.authorName])).toEqual([["Нужна помощь", "help", "telegram", "Edil"]]);
    const pushes = (await founderStaffRows(t.userIds.nuraaly)).filter((r) => r.status === "pending");
    expect(pushes).toHaveLength(1);
    const trail = await getTaskStaffTrail(t.ctx("nuraaly"), task.id);
    expect(trail.map((e) => e.what)).toEqual(["New task sent", "Accepted", "Asked for help"]);
  });

  it("Перенести срок → a request the founder approves with one tap (the person cannot change deadlines)", async () => {
    await onTelegram(edil, EDIL_CHAT);
    const { code } = await createLinkCode(t.handle.db, t.userIds.nuraaly, local(D, "08:00"));
    await handleTelegramUpdate(t.handle.db, msgUpdate(FOUNDER_CHAT, `/start ${code}`), local(D, "08:00"));
    const task = await edilTask("Move me", "2026-11-05");
    const reg = await tick(local(D, "09:00"));
    const s = reg.sent.find((x) => x.personId === edil)!;
    const move = await handleTelegramUpdate(t.handle.db, press(EDIL_CHAT, cb(s, "staff_move", task.id)), local(D, "09:05"));
    const options = move.find((a) => a.method === "sendMessage")!;
    const kb = (options.params.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
    expect(kb[0]!.map((b) => b.text)).toEqual(["+1 день", "+3 дня", "+7 дней"]);
    const req = await handleTelegramUpdate(t.handle.db, press(EDIL_CHAT, kb[0]![1]!.callback_data), local(D, "09:06"));
    expect(req[0]!.params.text).toBe("Запрос на перенос срока до 08.11 отправлен. Основатель подтвердит.");
    expect((await getTask(t.ctx("nuraaly"), task.id)).dueDate).toBe("2026-11-05");

    const founder = await tick(local(D, "10:00"));
    const push = founder.sent.find((x) => x.to === t.userIds.nuraaly && x.message.title === "Deadline change requested")!;
    expect(push.message.actions!.map((a) => a.label)).toEqual(["Approve 08.11", "Decline"]);
    const approveData = Object.entries(push.callbacks).find(([k]) => k.startsWith("deadline_approve:"))![1]!;
    // Edil cannot press the founder's approve button.
    expect((await handleTelegramUpdate(t.handle.db, press(EDIL_CHAT, approveData), local(D, "10:01")))[0]!.params.text).toBe(
      "Кнопка устарела или уже нажата.",
    );
    const ok = await handleTelegramUpdate(t.handle.db, press(FOUNDER_CHAT, approveData), local(D, "10:02"));
    expect(ok[0]!.params.text).toBe("Approved: deadline moved to 2026-11-08");
    expect((await getTask(t.ctx("nuraaly"), task.id)).dueDate).toBe("2026-11-08");
    const [reqRow] = await t.handle.db.select().from(taskDeadlineRequests);
    expect(reqRow).toMatchObject({ status: "approved", decidedByUserId: t.userIds.nuraaly });
    await expect(decideDeadlineRequest(t.ctx("talant"), reqRow!.id, false)).rejects.toThrow(/already/);
    // Edil hears back.
    const back = await tick(local(D, "10:10"));
    expect(back.sent.find((x) => x.personId === edil)!.message.lines[0]!.text).toBe("Срок по задаче «Move me» перенесён на 08.11.");
  });

  it("free text: a reply to a task message is a comment; otherwise «К какой задаче?»; files are not stored", async () => {
    await onTelegram(edil, EDIL_CHAT);
    const task = await edilTask("Reply here", "2026-11-12");
    const other = await edilTask("Other", "2026-11-13");
    await tick(local(D, "09:00"));
    const sentRow = (await personRows(edil)).find((r) => r.taskId === task.id)!;
    const r1 = await handleTelegramUpdate(
      t.handle.db,
      msgUpdate(EDIL_CHAT, "Сделаю к обеду", { reply_to_message: { message_id: Number(sentRow.providerMessageId) } }),
      local(D, "09:10"),
    );
    expect(textOf(r1)).toContain("Передал основателям");
    expect((await listTaskComments(t.ctx("nuraaly"), task.id)).map((c) => c.text)).toEqual(["Сделаю к обеду"]);

    const r2 = await handleTelegramUpdate(t.handle.db, msgUpdate(EDIL_CHAT, "А где файл?"), local(D, "09:20"));
    expect(textOf(r2)).toContain("К какой задаче?");
    const kb = (r2[0]!.params.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
    expect(kb.map((row) => row[0]!.text)).toEqual(["1. Reply here", "2. Other"]);
    await handleTelegramUpdate(t.handle.db, press(EDIL_CHAT, kb[1]![0]!.callback_data), local(D, "09:21"));
    expect((await listTaskComments(t.ctx("nuraaly"), other.id)).map((c) => c.text)).toEqual(["А где файл?"]);

    const photo = await handleTelegramUpdate(t.handle.db, msgUpdate(EDIL_CHAT, "", { text: undefined, photo: [{}] }), local(D, "09:30"));
    expect(textOf(photo)).toContain("Пока принимаю только текст");
    const lines = (await founderStaffRows(t.userIds.talant)).map((r) => (r.payload as { summaryLine: string }).summaryLine);
    expect(lines.some((l) => l.includes("sent a photo"))).toBe(true);
  });

  it("/tasks, /done N and /help", async () => {
    await onTelegram(edil, EDIL_CHAT);
    await edilTask("First", "2026-11-03");
    const second = await edilTask("Second", "2026-11-09");
    const list = await handleTelegramUpdate(t.handle.db, msgUpdate(EDIL_CHAT, "/tasks"), local(D, "09:00"));
    expect(textOf(list)).toContain("1. First");
    expect(textOf(list)).toContain("2. Second");
    const done = await handleTelegramUpdate(t.handle.db, msgUpdate(EDIL_CHAT, "/done 2"), local(D, "09:01"));
    expect(textOf(done)).toContain("Отмечено как выполненное");
    expect((await getTask(t.ctx("nuraaly"), second.id)).status).toBe("done");
    expect(textOf(await handleTelegramUpdate(t.handle.db, msgUpdate(EDIL_CHAT, "/done 9"), local(D, "09:02")))).toContain("Нет задачи");
    expect(textOf(await handleTelegramUpdate(t.handle.db, msgUpdate(EDIL_CHAT, "/help"), local(D, "09:03")))).toContain("/tasks");
    // Events are logged as the person.
    const events = await t.handle.db.select().from(taskEvents).where(isNotNull(taskEvents.actorPersonId));
    expect(events.map((e) => [e.kind, e.actorPersonId, e.actorUserId])).toEqual([["status_changed", edil, null]]);
  });
});

describe("task comments (founders)", () => {
  it("CRUD on own comments; others' comments are read-only; private todos stay private", async () => {
    const shared = await edilTask("Shared", D);
    const c = await addTaskComment(t.ctx("nuraaly"), shared.id, "First note");
    await updateTaskComment(t.ctx("nuraaly"), c.id, "Edited note");
    await expect(updateTaskComment(t.ctx("talant"), c.id, "hijack")).rejects.toThrow(/own comments/);
    await expect(deleteTaskComment(t.ctx("talant"), c.id)).rejects.toThrow(/own comments/);
    const seen = await listTaskComments(t.ctx("talant"), shared.id);
    expect(seen.map((x) => [x.text, x.mine, !!x.editedAt])).toEqual([["Edited note", false, true]]);
    await expect(addTaskComment(t.ctx("nuraaly"), shared.id, "   ")).rejects.toThrow();
    await deleteTaskComment(t.ctx("nuraaly"), c.id);
    expect(await listTaskComments(t.ctx("nuraaly"), shared.id)).toHaveLength(0);

    const todo = await createTask(t.ctx("nuraaly"), { title: "Mine", visibility: "private", status: "todo", priority: "normal" });
    await addTaskComment(t.ctx("nuraaly"), todo.id, "secret");
    await expect(listTaskComments(t.ctx("talant"), todo.id)).rejects.toThrow(/not found/);
    await expect(addTaskComment(t.ctx("talant"), todo.id, "x")).rejects.toThrow(/not found/);
    // Private todos can never be assigned to a person (so never reach staff).
    await expect(updateTask(t.ctx("nuraaly"), todo.id, { assigneePersonId: edil })).rejects.toThrow();
  });
});
