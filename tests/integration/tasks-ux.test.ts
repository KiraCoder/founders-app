/**
 * Tasks UX (0032): the person → company rule, explicit chase modes end to end, the checklist with
 * ticks from Telegram, the task card edited in place, «💬 Комментарий», one updated card after
 * changes, Chase now / Pause, the founder-nudge choice, the list activity and the timeline.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { DEFAULT_STAFF_SETTINGS } from "@/lib/staff-schemas";
import {
  notificationActionTokens,
  notificationsOutbox,
  people,
  personCompanies,
  taskChecklistItems,
  taskComments,
  taskDeadlineRequests,
  taskEvents,
  tasks,
  telegramLinkCodes,
  telegramLinks,
} from "@/server/db/schema";
import { mintActionTokens } from "@/server/notifications/action-tokens";
import type { ChannelRegistry } from "@/server/notifications/channels";
import { dispatch } from "@/server/notifications/dispatcher";
import { planTick } from "@/server/notifications/planner";
import { handleTelegramUpdate, type BotAction } from "@/server/notifications/telegram-bot";
import type { TelegramUpdate } from "@/server/notifications/telegram-api";
import { actionKey, type ActionCallbacks, type NeutralMessage, type NotificationChannel } from "@/server/notifications/types";
import { createPersonInvite, setPersonBotEnabled, updateStaffDefaults } from "@/server/services/staff";
import { chaseTaskNow, getTaskTimeline, setTaskChase, setTaskChasePaused, taskActivityFor } from "@/server/services/task-activity";
import { addChecklistItem, listChecklist, setChecklistItemDone } from "@/server/services/task-checklist";
import { listTaskComments } from "@/server/services/task-comments";
import { createTask, getTask, updateTask, updateTaskDetailed } from "@/server/services/tasks";
import { createTestDb, type TestDb } from "../helpers/db";

const local = (day: string, hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), h! - 6, m!));
};
const D = "2026-11-02";
const EDIL_CHAT = 6_000_001;
const ELMURAT_CHAT = 6_000_002;

let t: TestDb;
let edil: string;
let elmurat: string;

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
  await db.delete(taskChecklistItems);
  await db.delete(tasks);
  await db.update(people).set({ botEnabled: false, botEnabledAt: null, botPausedUntil: null, staffChase: null });
  await db.update(personCompanies).set({ isActive: true });
  await updateStaffDefaults(t.ctx("nuraaly"), { ...DEFAULT_STAFF_SETTINGS });
});

interface Sent {
  personId: string | null;
  to: string;
  message: NeutralMessage;
  callbacks: ActionCallbacks;
}
function recorder() {
  const sent: Sent[] = [];
  let n = 500;
  const channel: NotificationChannel = {
    name: "telegram",
    async send(recipient, message, callbacks) {
      sent.push({ to: recipient.userId, personId: recipient.personId ?? null, message, callbacks: callbacks ?? {} });
      return { ok: true, providerMessageId: String(n++) };
    },
  };
  const registry: ChannelRegistry = { get: () => channel, resolve: (r) => (!r.personId || r.telegramChatId ? channel : null) };
  return { sent, registry };
}
async function tick(at: Date, reg = recorder()) {
  await planTick(t.handle.db, at, { timeZone: "Asia/Bishkek" });
  await dispatch(t.handle.db, at, { registry: reg.registry, timeZone: "Asia/Bishkek" });
  return reg;
}
async function sendDue(at: Date, reg = recorder()) {
  await dispatch(t.handle.db, at, { registry: reg.registry, timeZone: "Asia/Bishkek" });
  return reg;
}
const msgUpdate = (chatId: number, text: string): TelegramUpdate => ({
  update_id: Math.floor(Math.random() * 1e9),
  message: { message_id: 1, chat: { id: chatId, type: "private" }, from: { id: chatId, first_name: "X" }, text },
});
const press = (chatId: number, data: string): TelegramUpdate => ({
  update_id: Math.floor(Math.random() * 1e9),
  callback_query: {
    id: "cq",
    from: { id: chatId },
    data,
    message: { message_id: 77, chat: { id: chatId, type: "private" }, text: "card", reply_markup: { inline_keyboard: [[{ text: "b", callback_data: data }]] } },
  },
});
async function onTelegram(personId: string, chatId: number, at = local(D, "08:30")) {
  const invite = await createPersonInvite(t.ctx("nuraaly", at), personId);
  await handleTelegramUpdate(t.handle.db, msgUpdate(chatId, `/start ${invite.code}`), at);
  await setPersonBotEnabled(t.ctx("nuraaly", at), personId, true);
}
const edit = (actions: BotAction[]) => actions.find((a) => a.method === "editMessageText")!;
const buttons = (a: BotAction) =>
  ((a.params.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] } | undefined)?.inline_keyboard ?? []).flat();

describe("assignee → company", () => {
  it("a person who works for one company gets that company; another company is refused with their companies named", async () => {
    const ctx = t.ctx("nuraaly");
    const task = await createTask(ctx, { title: "Edil only Jobutify", visibility: "shared", assigneePersonId: edil });
    expect(task.company?.id).toBe(t.companyIds.jobutify);

    await expect(
      createTask(ctx, { title: "Wrong company", visibility: "shared", assigneePersonId: elmurat, companyId: t.companyIds["upsell-group"] }),
    ).rejects.toMatchObject({ code: "validation", fields: { companyId: [expect.stringContaining("Elmurat works for")] } });
    // Several companies: one must be picked.
    await expect(createTask(ctx, { title: "No company", visibility: "shared", assigneePersonId: elmurat })).rejects.toMatchObject({
      code: "validation",
      fields: { companyId: [expect.stringMatching(/^Pick a company: .*Jobutify/)] },
    });
    const ok = await createTask(ctx, { title: "Kiwi", visibility: "shared", assigneePersonId: elmurat, companyId: t.companyIds["kiwi-go"] });
    expect(ok.assignee).toMatchObject({ kind: "person", id: elmurat });
  });

  it("only an active link counts for a new assignment; an existing one is kept when other fields change", async () => {
    const ctx = t.ctx("nuraaly");
    const task = await createTask(ctx, { title: "Before", visibility: "shared", assigneePersonId: edil, companyId: t.companyIds.jobutify });
    await t.handle.db.update(personCompanies).set({ isActive: false }).where(eq(personCompanies.personId, edil));
    // Editing the title keeps Edil (no silent un-assign, no error).
    expect((await updateTask(ctx, task.id, { title: "After" })).assignee?.id).toBe(edil);
    // A new task for Edil now fails: he works for no company.
    await expect(
      createTask(ctx, { title: "New", visibility: "shared", assigneePersonId: edil, companyId: t.companyIds.jobutify }),
    ).rejects.toMatchObject({ code: "validation", message: expect.stringContaining("does not work for any company") });
  });
});

describe("explicit chase modes (end to end)", () => {
  async function edilTask(title: string, dueDate: string | null) {
    return createTask(t.ctx("nuraaly", local(D, "08:40")), {
      title,
      visibility: "shared",
      companyId: t.companyIds.jobutify,
      assigneePersonId: edil,
      dueDate,
    });
  }
  const chases = (reg: { sent: Sent[] }) => reg.sent.filter((s) => s.personId === edil && !s.message.title.startsWith("🆕"));

  it("“Remind once on the due date”: one reminder on the due day, none after", async () => {
    await onTelegram(edil, EDIL_CHAT);
    const task = await edilTask("Once", D);
    await setTaskChase(t.ctx("nuraaly"), task.id, { chase: "once", escalation: "off" });
    await tick(local(D, "08:45")); // new-task card
    expect(chases(await tick(local(D, "09:05"))).map((s) => s.message.title)).toEqual(["🔔 Напоминание: Once"]);
    expect(chases(await tick(local(D, "11:05")))).toHaveLength(0);
    expect(chases(await tick(local(D, "15:05")))).toHaveLength(0);
    expect(chases(await tick(local("2026-11-03", "09:05")))).toHaveLength(0);
  });

  it("“every N days”: one reminder on every N-th day from the due date; “every N hours” uses that cadence", async () => {
    await onTelegram(edil, EDIL_CHAT);
    const task = await edilTask("Every 2 days", D);
    await setTaskChase(t.ctx("nuraaly"), task.id, { chase: "every", everyN: "2", everyUnit: "days", escalation: "off" });
    await tick(local(D, "08:45"));
    expect(chases(await tick(local(D, "09:05")))).toHaveLength(1);
    expect(chases(await tick(local(D, "13:05")))).toHaveLength(0);
    expect(chases(await tick(local("2026-11-03", "09:05")))).toHaveLength(0);
    expect(chases(await tick(local("2026-11-04", "11:05")))).toHaveLength(1);

    await setTaskChase(t.ctx("nuraaly"), task.id, { chase: "every", everyN: "1", everyUnit: "hours", escalation: "off" });
    expect(chases(await tick(local("2026-11-04", "12:05")))).toHaveLength(1);
    expect(chases(await tick(local("2026-11-04", "13:05")))).toHaveLength(1);
  });

  it("“Don't chase” and Pause send nothing; Chase now still sends one reminder at once", async () => {
    await onTelegram(edil, EDIL_CHAT);
    const task = await edilTask("Quiet", D);
    await setTaskChase(t.ctx("nuraaly"), task.id, { chase: "off" });
    await tick(local(D, "08:45"));
    expect(chases(await tick(local(D, "09:05")))).toHaveLength(0);
    await setTaskChase(t.ctx("nuraaly"), task.id, { chase: "default" });
    await setTaskChasePaused(t.ctx("nuraaly"), task.id, true);
    expect(chases(await tick(local(D, "11:05")))).toHaveLength(0);
    expect((await taskActivityFor(t.ctx("nuraaly"), [task]))[task.id]!.chase.paused).toBe(true);

    await chaseTaskNow(t.ctx("nuraaly", local(D, "11:20")), task.id);
    const now = await sendDue(local(D, "11:20"));
    expect(chases(now).map((s) => s.message.title)).toEqual(["🔔 Напоминание: Quiet"]);
    const timeline = await getTaskTimeline(t.ctx("nuraaly"), task.id);
    expect(timeline.map((e) => e.what)).toContain("Reminder #1 sent (Chase now) · delivered");
  });

  it("Chase now explains why nothing can be sent", async () => {
    const task = await edilTask("Not linked", D);
    await expect(chaseTaskNow(t.ctx("nuraaly"), task.id)).rejects.toMatchObject({ message: expect.stringContaining("not linked Telegram") });
  });

  it("escalation “N days after due” tells both founders once; “off” never stops or escalates", async () => {
    await onTelegram(edil, EDIL_CHAT);
    const task = await edilTask("Escalate", D);
    await setTaskChase(t.ctx("nuraaly"), task.id, { chase: "default", escalation: "days", escalateDays: "2" });
    await tick(local(D, "08:45"));
    await tick(local("2026-11-03", "09:05"));
    const founderRows = () =>
      t.handle.db.select().from(notificationsOutbox).where(and(eq(notificationsOutbox.kind, "staff_update"), eq(notificationsOutbox.taskId, task.id)));
    expect(await founderRows()).toHaveLength(0);
    await tick(local("2026-11-04", "09:05"));
    await tick(local("2026-11-04", "11:05"));
    const rows = await founderRows();
    expect(rows.map((r) => r.userId).sort()).toEqual([t.userIds.nuraaly, t.userIds.talant].sort());
    expect(rows[0]!.dedupeKey).toBe(`esc:${task.id}:${D}:days`);
  });
});

describe("founder nudges per task", () => {
  it("“Don't nudge” drops the founder's due-today push; “Only on the due date” drops the overdue chase", async () => {
    const ctx = t.ctx("nuraaly");
    const today = await createTask(ctx, { title: "Due today, no nudge", visibility: "private", dueDate: D });
    await setTaskChase(ctx, today.id, { founderNudge: "off" });
    const late = await createTask(ctx, { title: "Overdue, due day only", visibility: "private", dueDate: "2026-11-01" });
    await setTaskChase(ctx, late.id, { founderNudge: "due_day" });
    const usual = await createTask(ctx, { title: "Usual", visibility: "private", dueDate: D });
    await planTick(t.handle.db, local(D, "08:00"), { timeZone: "Asia/Bishkek", staff: false });
    const rows = await t.handle.db.select().from(notificationsOutbox).where(eq(notificationsOutbox.userId, t.userIds.nuraaly));
    const about = new Set(rows.map((r) => r.taskId).filter(Boolean));
    expect(about.has(usual.id)).toBe(true);
    expect(about.has(today.id)).toBe(false);
    expect(about.has(late.id)).toBe(false);
  });
});

describe("checklist + the task card in Telegram", () => {
  async function sentTask() {
    await onTelegram(edil, EDIL_CHAT);
    const ctx = t.ctx("nuraaly", local(D, "08:40"));
    const task = await createTask(ctx, { title: "Сдать документы", visibility: "shared", assigneePersonId: edil, dueDate: "2026-11-05" });
    await addChecklistItem(ctx, task.id, { title: "Акт", details: "Подписанный" }, { notify: false });
    await addChecklistItem(ctx, task.id, { title: "Счёт" }, { notify: false });
    const reg = await tick(local(D, "08:45"));
    const card = reg.sent.find((s) => s.personId === edil)!;
    return { task, card };
  }

  it("the new-task card lists the checklist with ⬜ and a tick button per item", async () => {
    const { card } = await sentTask();
    expect(card.message.title).toBe("🆕 Новая задача: Сдать документы");
    const texts = card.message.lines.map((l) => l.text);
    expect(texts).toEqual(expect.arrayContaining(["🏢 Jobutify", "Чек-лист · 0 из 2 ▱▱▱▱▱", "⬜ Акт", "⬜ Счёт"]));
    expect(card.message.actions!.filter((a) => a.action === "staff_check").map((a) => a.label)).toEqual(["⬜ 1. Акт", "⬜ 2. Счёт"]);
  });

  it("a tick in Telegram re-draws the SAME message (✅, progress, fewer buttons) and keeps time + who", async () => {
    const { task, card } = await sentTask();
    const items = await listChecklist(t.ctx("nuraaly"), task.id);
    const tok = card.callbacks[actionKey({ action: "staff_check", taskId: task.id, item: items[0]!.id })]!;
    const res = await handleTelegramUpdate(t.handle.db, press(EDIL_CHAT, tok), local(D, "10:00"));
    expect(res[0]!.params.text).toBe("✅ Акт. Осталось пунктов: 1");
    const e = edit(res);
    expect(e.params.message_id).toBe(77);
    expect(e.params.text).toContain("✅ Акт");
    expect(e.params.text).toContain("⬜ Счёт");
    expect(e.params.text).toContain("Чек-лист · 1 из 2");
    expect(buttons(e).map((b) => b.text)).not.toContain("⬜ 1. Акт");
    expect(buttons(e).map((b) => b.text)).toContain("⬜ 2. Счёт");

    const after = await listChecklist(t.ctx("talant"), task.id);
    expect(after[0]).toMatchObject({ doneBy: "Edil", doneVia: "telegram" });
    expect(after[0]!.doneAt?.toISOString()).toBe(local(D, "10:00").toISOString());
    // The same token again does nothing.
    expect((await handleTelegramUpdate(t.handle.db, press(EDIL_CHAT, tok), local(D, "10:01")))[0]!.params.text).toBe("Кнопка устарела или уже нажата.");
    // Another person's chat cannot use Edil's buttons.
    await onTelegram(elmurat, ELMURAT_CHAT);
    const other = buttons(e).find((b) => b.text === "⬜ 2. Счёт")!.callback_data;
    expect((await handleTelegramUpdate(t.handle.db, press(ELMURAT_CHAT, other), local(D, "10:02")))[0]!.params.text).toBe("Кнопка устарела или уже нажата.");
    expect((await listChecklist(t.ctx("nuraaly"), task.id))[1]!.doneAt).toBeNull();
    // The timeline shows the tick.
    expect((await getTaskTimeline(t.ctx("nuraaly"), task.id)).map((x) => x.what)).toContain("Ticked “Акт” (Telegram)");
  });

  it("✅ Готово (needs review, the default) re-draws the card as «На проверке» with no buttons; the task is In Review", async () => {
    const { task, card } = await sentTask();
    const res = await handleTelegramUpdate(t.handle.db, press(EDIL_CHAT, card.callbacks[actionKey({ action: "staff_done", taskId: task.id })]!), local(D, "10:00"));
    const e = edit(res);
    expect(String(e.params.text).startsWith("<b>👀 На проверке у основателя: Сдать документы</b>")).toBe(true);
    expect(e.params.reply_markup).toBeUndefined();
    expect((await getTask(t.ctx("nuraaly"), task.id)).status).toBe("in_review");
  });

  it("✅ Готово without «needs review» re-draws the card as done with no buttons", async () => {
    const { task, card } = await sentTask();
    await updateTask(t.ctx("nuraaly", local(D, "09:00")), task.id, { needsReview: false });
    const res = await handleTelegramUpdate(t.handle.db, press(EDIL_CHAT, card.callbacks[actionKey({ action: "staff_done", taskId: task.id })]!), local(D, "10:00"));
    const e = edit(res);
    expect(String(e.params.text).startsWith("<b>✅ Выполнено: Сдать документы</b>")).toBe(true);
    expect(e.params.reply_markup).toBeUndefined();
    expect((await getTask(t.ctx("nuraaly"), task.id)).status).toBe("done");
  });

  it("«💬 Комментарий» → the next text is saved as the task's comment and the founder gets a line", async () => {
    const { task, card } = await sentTask();
    const res = await handleTelegramUpdate(t.handle.db, press(EDIL_CHAT, card.callbacks[actionKey({ action: "staff_comment", taskId: task.id })]!), local(D, "10:00"));
    expect(String(edit(res).params.text)).toContain("Напишите комментарий");
    const reply = await handleTelegramUpdate(t.handle.db, msgUpdate(EDIL_CHAT, "Акт будет завтра"), local(D, "10:03"));
    expect(String(reply[0]!.params.text)).toContain("Передал основателям");
    const comments = await listTaskComments(t.ctx("nuraaly"), task.id);
    expect(comments.map((c) => [c.text, c.source])).toEqual([["Акт будет завтра", "telegram"]]);
    const lines = await t.handle.db
      .select()
      .from(notificationsOutbox)
      .where(and(eq(notificationsOutbox.userId, t.userIds.nuraaly), eq(notificationsOutbox.kind, "staff_update")));
    expect(lines.map((l) => l.status)).toEqual(["parked"]);
    // Only once: the next text is not attached to the task any more.
    const next = await handleTelegramUpdate(t.handle.db, msgUpdate(EDIL_CHAT, "Ещё текст"), local(D, "10:05"));
    expect(String(next[0]!.params.text)).toContain("К какой задаче?");
  });

  it("changes to a sent task queue ONE updated card, built when sent; nothing before the task was sent", async () => {
    await onTelegram(edil, EDIL_CHAT);
    const ctx = t.ctx("nuraaly", local(D, "08:40"));
    const task = await createTask(ctx, { title: "Отчёт", visibility: "shared", assigneePersonId: edil, dueDate: "2026-11-05" });
    // Not sent yet: no extra message (the new-task card will show the item).
    expect((await addChecklistItem(ctx, task.id, { title: "Первый" })).notified).toBe(false);
    await tick(local(D, "08:45"));
    const at = local(D, "09:00");
    const a = await addChecklistItem(t.ctx("nuraaly", at), task.id, { title: "Второй" });
    expect(a).toMatchObject({ notified: true, personName: "Edil" });
    await addChecklistItem(t.ctx("nuraaly", at), task.id, { title: "Третий" });
    const moved = await updateTaskDetailed(t.ctx("nuraaly", at), task.id, { dueDate: "2026-11-06" });
    expect(moved.staffNotice.notified).toBe(true);
    const waiting = await t.handle.db
      .select()
      .from(notificationsOutbox)
      .where(and(eq(notificationsOutbox.personId, edil), eq(notificationsOutbox.kind, "staff_task_update")));
    expect(waiting).toHaveLength(1);
    // A founder's own tick sends nothing.
    const items = await listChecklist(t.ctx("nuraaly"), task.id);
    await setChecklistItemDone(t.ctx("nuraaly", at), items[0]!.id, true);
    const reg = await sendDue(local(D, "09:02"));
    const upd = reg.sent.filter((s) => s.personId === edil);
    expect(upd.map((s) => s.message.title)).toEqual(["✏️ Задача обновлена: Отчёт"]);
    const texts = upd[0]!.message.lines.map((l) => l.text);
    expect(texts).toEqual(expect.arrayContaining(["✅ Первый", "⬜ Второй", "⬜ Третий", "📅 Срок: 06.11"]));
  });

  it("a founder's own token cannot tick a person's item", async () => {
    const { task } = await sentTask();
    const items = await listChecklist(t.ctx("nuraaly"), task.id);
    const tok = await mintActionTokens(t.handle.db, {
      userId: t.userIds.nuraaly,
      outboxId: null,
      actions: [{ action: "staff_check", taskId: task.id, item: items[0]!.id, label: "x", payload: { item: items[0]!.id } }],
      now: local(D, "09:00"),
    });
    const res = await handleTelegramUpdate(t.handle.db, press(EDIL_CHAT, Object.values(tok)[0]!), local(D, "09:01"));
    expect(res[0]!.params.text).toBe("Кнопка устарела или уже нажата.");
    expect((await listChecklist(t.ctx("nuraaly"), task.id))[0]!.doneAt).toBeNull();
  });
});

describe("list activity", () => {
  it("shows the last message, the last answer, comments and checklist progress", async () => {
    await onTelegram(edil, EDIL_CHAT);
    const ctx = t.ctx("nuraaly", local(D, "08:40"));
    const task = await createTask(ctx, { title: "Activity", visibility: "shared", assigneePersonId: edil, dueDate: D });
    await addChecklistItem(ctx, task.id, { title: "One" }, { notify: false });
    const reg = await tick(local(D, "08:45"));
    const card = reg.sent.find((s) => s.personId === edil)!;
    await handleTelegramUpdate(t.handle.db, press(EDIL_CHAT, card.callbacks[actionKey({ action: "staff_accept", taskId: task.id })]!), local(D, "08:50"));
    await handleTelegramUpdate(t.handle.db, press(EDIL_CHAT, card.callbacks[actionKey({ action: "staff_help", taskId: task.id })]!), local(D, "08:51"));
    const a = (await taskActivityFor(t.ctx("nuraaly"), [task]))[task.id]!;
    expect(a).toMatchObject({ comments: 1, checklist: { done: 0, total: 1 }, sentToPerson: true, reminders: 0 });
    expect(a.lastSent).toMatchObject({ what: "New task sent", status: "sent" });
    expect(a.lastReply).toMatchObject({ what: "Asked for help" });
  });
});
