/**
 * Routines UX (0031): several asks a day (one run, each ask re-asks what is open), reminder modes,
 * escalation recipients, start / end dates (Asia/Bishkek), the message edited in place on each
 * tick, comments / «Частично» / «Не могу» in the bot, "needs a comment" items, checklist edits
 * while today's run is open, Re-run, the assignee ↔ company rule, history and message log.
 * In-memory PGlite, no real Telegram.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { DEFAULT_STAFF_SETTINGS } from "@/lib/staff-schemas";
import {
  notificationActionTokens,
  notificationsOutbox,
  people,
  routineComments,
  routineRuns,
  routines,
  telegramLinkCodes,
  telegramLinks,
} from "@/server/db/schema";
import type { ChannelRegistry } from "@/server/notifications/channels";
import { dispatch } from "@/server/notifications/dispatcher";
import { planTick } from "@/server/notifications/planner";
import { handleTelegramUpdate, type BotAction } from "@/server/notifications/telegram-bot";
import type { TelegramUpdate } from "@/server/notifications/telegram-api";
import { actionKey, type ActionCallbacks, type NeutralMessage, type NotificationChannel } from "@/server/notifications/types";
import {
  createRoutine,
  getRoutine,
  listRoutineMessages,
  listRoutineRuns,
  listRoutines,
  rerunRoutineToday,
  routineFormOptions,
  runRoutineNow,
  setRoutineStatus,
  updateRoutine,
} from "@/server/services/routines";
import { createPersonInvite, setPersonBotEnabled, updateStaffDefaults } from "@/server/services/staff";
import { createTestDb, type TestDb } from "../helpers/db";

const local = (day: string, hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), h! - 6, m!));
};
const MON = "2026-11-02";
const TUE = "2026-11-03";
const WED = "2026-11-04";
const TZ = "Asia/Bishkek";
const CHAT = 7_200_002;

let t: TestDb;
let elmurat: string;
let edil: string;

beforeAll(async () => {
  t = await createTestDb();
  elmurat = t.personIds.elmurat!;
  edil = t.personIds.edil!;
});
afterAll(async () => {
  await t.handle.close();
});
beforeEach(async () => {
  const db = t.handle.db;
  await db.delete(notificationActionTokens);
  await db.delete(notificationsOutbox);
  await db.delete(routineComments);
  await db.delete(routineRuns);
  await db.delete(routines);
  await db.delete(telegramLinks);
  await db.delete(telegramLinkCodes);
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
    message: { message_id: 42, chat: { id: chatId, type: "private" }, text: "m", reply_markup: { inline_keyboard: [[{ text: "b", callback_data: data }]] } },
  },
});
async function onTelegram(personId: string, chat: number, at = local(MON, "08:00")) {
  const inv = await createPersonInvite(t.ctx("nuraaly", at), personId);
  await handleTelegramUpdate(t.handle.db, msgUpdate(chat, `/start ${inv.code}`), at);
  await setPersonBotEnabled(t.ctx("nuraaly", at), personId, true);
}
async function tick(at: Date, reg = recorder()) {
  await planTick(t.handle.db, at, { timeZone: TZ });
  await dispatch(t.handle.db, at, { registry: reg.registry, timeZone: TZ });
  return reg;
}
const to = (r: { sent: Sent[] }, personId: string) => r.sent.filter((s) => s.personId === personId);
const runs = (routineId: string) => t.handle.db.select().from(routineRuns).where(eq(routineRuns.routineId, routineId));
const cbFor = (s: Sent, label: string) => {
  const a = s.message.actions!.find((x) => x.label === label);
  if (!a) throw new Error(`no button ${label}: ${s.message.actions!.map((x) => x.label).join(", ")}`);
  return s.callbacks[actionKey(a)]!;
};
const labelsOf = (a: BotAction | undefined) =>
  ((a?.params.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined)?.inline_keyboard ?? []).flat();
const edit = (a: BotAction[]) => a.find((x) => x.method === "editMessageText");
const sendText = (a: BotAction[]) => a.filter((x) => x.method === "sendMessage").map((x) => String(x.params.text));

const routine = (over: Record<string, unknown> = {}) =>
  createRoutine(t.ctx("nuraaly", local(MON, "08:00")), {
    title: "1C записи",
    description: "",
    companyId: "",
    assignee: `person:${elmurat}`,
    scheduleKind: "weekly",
    days: [1, 2, 3, 4, 5, 6, 7],
    time: "15:00",
    confirmation: "checklist",
    items: "Kiwi Go\nJobutify\nAlura Brand",
    chase: { reminderMode: "every", chaseEveryMinutes: "120", chaseUntil: "19:00", escalateAt: "off", escalateAfterChases: "0" },
    ...over,
  });

describe("planner: several asks a day, reminder modes, escalation recipients", () => {
  it("asks at 10:00 and 16:00 on ONE run; the 16:00 ask shows only what is still open", async () => {
    await onTelegram(elmurat, CHAT);
    const r = await routine({ time: undefined, times: ["10:00", "16:00"], chase: { reminderMode: "once", chaseUntil: "19:00", escalateAt: "off", escalateAfterChases: "0" } });
    const at10 = to(await tick(local(MON, "10:00")), elmurat);
    expect(at10.map((s) => s.message.title)).toEqual(["📋 Рутина: 1C записи"]);
    await handleTelegramUpdate(t.handle.db, press(CHAT, cbFor(at10[0]!, "✓ Kiwi Go")), local(MON, "10:05"));
    // "Ask once": no reminders between the asks.
    for (const hm of ["11:00", "12:00", "14:00", "15:59"]) expect(to(await tick(local(MON, hm)), elmurat)).toHaveLength(0);
    const at16 = to(await tick(local(MON, "16:00")), elmurat);
    expect(at16).toHaveLength(1);
    expect(at16[0]!.message.actions!.filter((a) => a.action === "routine_tick").map((a) => a.label)).toEqual(["✓ Jobutify", "✓ Alura Brand"]);
    expect(await runs(r.id)).toHaveLength(1);
    expect(to(await tick(local(MON, "18:00")), elmurat)).toHaveLength(0);
    const [view] = await listRoutines(t.ctx("nuraaly", local(MON, "16:30")), { personId: elmurat });
    expect(view!.scheduleText).toBe("Every day 10:00, 16:00");
    expect(view!.planText).toContain("at 10:00 and 16:00 (each later ask only about what is still open), no reminders");
  });

  it("'Remind 2 times' every 60 min, then nothing; escalation by time goes only to the founders picked", async () => {
    await onTelegram(elmurat, CHAT);
    const r = await routine({
      confirmation: "button",
      items: "",
      chase: { reminderMode: "times", remindTimes: "2", chaseEveryMinutes: "60", chaseUntil: "20:00", escalateAt: "18:00", escalateAfterChases: "0", escalateTo: [t.userIds.nuraaly] },
    });
    const got: string[] = [];
    for (const hm of ["15:00", "16:00", "17:00", "18:00", "19:00"]) {
      const reg = await tick(local(MON, hm));
      for (const s of to(reg, elmurat)) got.push(`${hm} ${s.message.title}`);
      if (hm === "18:00") {
        const esc = reg.sent.filter((s) => s.message.title === "Routine not done");
        expect(esc.map((s) => s.to)).toEqual([t.userIds.nuraaly]);
      }
    }
    expect(got).toEqual(["15:00 📋 Рутина: 1C записи", "16:00 ⏰ Напоминание: 1C записи", "17:00 ⏰ Напоминание: 1C записи"]);
    expect((await runs(r.id))[0]).toMatchObject({ status: "escalated", chaseCount: 2 });
  });
});

describe("start and end dates (Asia/Bishkek)", () => {
  it("no run before the start; after the end day (local midnight, still Tuesday in UTC) the routine is 'ended' and stays quiet", async () => {
    await onTelegram(elmurat, CHAT);
    const r = await routine({ startsOn: TUE, endsOn: TUE });
    expect(to(await tick(local(MON, "15:00")), elmurat)).toHaveLength(0);
    expect(await runs(r.id)).toHaveLength(0);
    expect(to(await tick(local(TUE, "15:00")), elmurat)).toHaveLength(1);
    // 23:59 Tuesday in Bishkek: still active.
    await tick(local(TUE, "23:59"));
    expect((await t.handle.db.select().from(routines).where(eq(routines.id, r.id)))[0]!.status).toBe("active");
    // 00:05 Wednesday in Bishkek = 18:05 Tuesday UTC: ended.
    const wedEarly = local(WED, "00:05");
    expect(wedEarly.toISOString()).toBe("2026-11-03T18:05:00.000Z");
    await tick(wedEarly);
    expect((await t.handle.db.select().from(routines).where(eq(routines.id, r.id)))[0]!.status).toBe("ended");
    expect(to(await tick(local(WED, "15:00")), elmurat)).toHaveLength(0);
    expect((await runs(r.id)).map((x) => [x.runDate, x.status])).toEqual([[TUE, "missed"]]);
    const [view] = await listRoutines(t.ctx("nuraaly", local(WED, "16:00")), { status: "ended" });
    expect(view).toMatchObject({ status: "ended", nextDueAt: null });
    await expect(runRoutineNow(t.ctx("nuraaly", local(WED, "16:00")), r.id)).rejects.toThrow(/ended/);
    await expect(setRoutineStatus(t.ctx("nuraaly", local(WED, "16:00")), r.id, "active")).rejects.toThrow(/Ends on/);
    // A later end date brings it back.
    const back = await updateRoutine(t.ctx("nuraaly", local(WED, "16:00")), r.id, {
      title: "1C записи",
      assignee: `person:${elmurat}`,
      scheduleKind: "weekly",
      days: [1, 2, 3, 4, 5, 6, 7],
      time: "15:00",
      confirmation: "button",
      items: "",
      endsOn: "2026-11-30",
    });
    expect(back.status).toBe("active");
    await expect(createRoutine(t.ctx("nuraaly", local(WED, "10:00")), { title: "Old", assignee: `person:${elmurat}`, scheduleKind: "weekly", days: [1], time: "10:00", confirmation: "button", items: "", endsOn: TUE })).rejects.toThrow(
      /past/,
    );
  });
});

describe("the bot: edit in place, comments, partly / can't", () => {
  it("each tick EDITS the message (states, progress, buttons for what is open) and ends with «Готово, спасибо! 3/3 ✅»", async () => {
    await onTelegram(elmurat, CHAT);
    const r = await routine({ companyId: t.companyIds.jobutify });
    const ask = to(await tick(local(MON, "15:00")), elmurat)[0]!;
    const a1 = await handleTelegramUpdate(t.handle.db, press(CHAT, cbFor(ask, "✓ Kiwi Go")), local(MON, "15:10"));
    expect(a1[0]!.params.text).toBe("✓ Kiwi Go. Осталось: 2");
    const e1 = edit(a1)!;
    expect(e1.params).toMatchObject({ chat_id: CHAT, message_id: 42, parse_mode: "HTML" });
    expect(String(e1.params.text)).toContain("<b>Прогресс: 1/3</b>");
    expect(String(e1.params.text)).toContain("✅ Kiwi Go");
    expect(String(e1.params.text)).toContain("🏢 Jobutify");
    expect(labelsOf(e1).map((b) => b.text)).toEqual(["✓ Jobutify", "✓ Alura Brand", "✅ Всё готово", "💬 Комментарий", "🟡 Частично", "❌ Не могу"]);
    // The edited keyboard's buttons work (fresh tokens).
    const all = labelsOf(e1).find((b) => b.text === "✅ Всё готово")!.callback_data;
    const a2 = await handleTelegramUpdate(t.handle.db, press(CHAT, all), local(MON, "15:20"));
    expect(a2[0]!.params.text).toBe("Рутина выполнена ✓ Спасибо!");
    expect(String(edit(a2)!.params.text)).toContain("Готово, спасибо! 3/3 ✅");
    expect(edit(a2)!.params.reply_markup).toBeUndefined();
    const [run] = await runs(r.id);
    expect(run!.status).toBe("done");
    expect(run!.itemStates.i1).toMatchObject({ state: "done", by: "Elmurat", byPersonId: elmurat, at: local(MON, "15:10").toISOString() });
    // The history shows who ticked what, when.
    const [h] = await listRoutineRuns(t.ctx("nuraaly", local(MON, "20:00")), r.id);
    expect(h!.items.map((i) => [i.label, i.state, i.by])).toEqual([
      ["Kiwi Go", "done", "Elmurat"],
      ["Jobutify", "done", "Elmurat"],
      ["Alura Brand", "done", "Elmurat"],
    ]);
    expect(h!.asks).toHaveLength(1);
  });

  it("«💬 Комментарий» → pick the item → the next text is saved on it (founders: a summary line)", async () => {
    await onTelegram(elmurat, CHAT);
    const r = await routine();
    const ask = to(await tick(local(MON, "15:00")), elmurat)[0]!;
    const c1 = await handleTelegramUpdate(t.handle.db, press(CHAT, cbFor(ask, "💬 Комментарий")), local(MON, "15:05"));
    const pick = labelsOf(edit(c1));
    expect(pick.map((b) => b.text)).toEqual(["→ Kiwi Go", "→ Jobutify", "→ Alura Brand", "Ко всей рутине", "← Назад"]);
    const c2 = await handleTelegramUpdate(t.handle.db, press(CHAT, pick[1]!.callback_data), local(MON, "15:06"));
    expect(sendText(c2).join("\n")).toContain("пункт «Jobutify»");
    // The message is back to its normal buttons.
    expect(labelsOf(edit(c2)).map((b) => b.text)).toContain("✓ Jobutify");
    const c3 = await handleTelegramUpdate(t.handle.db, msgUpdate(CHAT, "Жду выписку из банка"), local(MON, "15:07"));
    expect(sendText(c3)).toEqual([expect.stringContaining("Комментарий сохранён ✓")]);
    expect(edit(c3)!.params.message_id).toBe(42);
    const comments = await t.handle.db.select().from(routineComments).where(eq(routineComments.routineId, r.id));
    expect(comments.map((c) => [c.itemKey, c.kind, c.text, c.authorPersonId])).toEqual([["i2", "comment", "Жду выписку из банка", elmurat]]);
    const lines = await t.handle.db.select().from(notificationsOutbox).where(like(notificationsOutbox.dedupeKey, "routine-comment:%"));
    expect(lines.map((l) => (l.payload as { summaryLine: string }).summaryLine)[0]).toBe('Elmurat commented on "1C записи" (Jobutify): Жду выписку из банка');
    // The next text is a normal message again (no pending comment).
    const after = await handleTelegramUpdate(t.handle.db, msgUpdate(CHAT, "привет"), local(MON, "15:08"));
    expect(sendText(after).join("")).not.toContain("Комментарий сохранён");
    const [view] = await listRoutines(t.ctx("nuraaly", local(MON, "15:10")), { personId: elmurat });
    expect(view!.commentsCount).toBe(1);
    // The list's one query also carries the latest run (lateral join) and reachability.
    expect(view!.reachable).toBe(true);
    expect(view!.lastRun).toMatchObject({ routineId: r.id, runDate: MON });
    expect(view!.lastRun!.startedAt).toBeInstanceOf(Date);
    expect(view!.today?.id).toBe(view!.lastRun!.id);
    expect((await getRoutine(t.ctx("nuraaly", local(MON, "15:10")), r.id)).commentsCount).toBe(1);
  });

  it("the list without runs or a chat: no last run, not reachable, no comments; an unknown routine is not found", async () => {
    const r = await routine();
    const [view] = await listRoutines(t.ctx("nuraaly", local(MON, "09:00")), { personId: elmurat });
    expect(view).toMatchObject({ lastRun: null, today: null, reachable: false, commentsCount: 0 });
    expect((await getRoutine(t.ctx("nuraaly", local(MON, "09:00")), r.id)).routine.id).toBe(r.id);
    await expect(getRoutine(t.ctx("nuraaly"), "00000000-0000-4000-8000-000000000000")).rejects.toThrow(/not found/i);
    // Linked and switched on, but paused until later: still not reachable.
    await onTelegram(elmurat, CHAT);
    expect((await listRoutines(t.ctx("nuraaly", local(MON, "09:00")), { personId: elmurat }))[0]!.reachable).toBe(true);
    await t.handle.db.update(people).set({ botPausedUntil: local(TUE, "00:00") }).where(eq(people.id, elmurat));
    expect((await listRoutines(t.ctx("nuraaly", local(MON, "09:00")), { personId: elmurat }))[0]!.reachable).toBe(false);
  });

  it("«🟡 Частично» and «❌ Не могу» require a comment; can't tells the founders; nothing open → the run closes (can't outcome)", async () => {
    await onTelegram(elmurat, CHAT);
    const r = await routine({ items: "Kiwi Go\nJobutify" });
    const ask = to(await tick(local(MON, "15:00")), elmurat)[0]!;
    await handleTelegramUpdate(t.handle.db, press(CHAT, cbFor(ask, "✓ Kiwi Go")), local(MON, "15:01"));
    // One open item: «Частично» goes straight to the comment prompt.
    const p1 = await handleTelegramUpdate(t.handle.db, press(CHAT, cbFor(ask, "🟡 Частично")), local(MON, "15:02"));
    expect(sendText(p1).join("")).toContain("Что сделано, а что нет — пункт «Jobutify»");
    expect((await runs(r.id))[0]!.itemStates.i2).toBeUndefined();
    const p2 = await handleTelegramUpdate(t.handle.db, msgUpdate(CHAT, "половина документов"), local(MON, "15:03"));
    expect(sendText(p2).join("")).toContain("Отмечено «частично»");
    expect(String(edit(p2)!.params.text)).toContain("🟡 Jobutify — «половина документов»");
    const [run] = await runs(r.id);
    expect(run).toMatchObject({ status: "partly" });
    expect(run!.itemStates.i2).toMatchObject({ state: "partly", comment: "половина документов", by: "Elmurat" });

    // A button routine: «Не могу» → comment → closed, founders pushed (their rules).
    const b = await routine({ title: "Возвраты WB", confirmation: "button", items: "", time: "16:00" });
    const ask2 = to(await tick(local(MON, "16:00")), elmurat).find((s) => s.message.title.includes("Возвраты"))!;
    await handleTelegramUpdate(t.handle.db, press(CHAT, cbFor(ask2, "❌ Не могу")), local(MON, "16:01"));
    const c2 = await handleTelegramUpdate(t.handle.db, msgUpdate(CHAT, "Склад закрыт"), local(MON, "16:02"));
    expect(sendText(c2).join("")).toContain("Передал основателям");
    const [bRun] = await runs(b.id);
    expect(bRun).toMatchObject({ status: "missed" });
    const cant = await t.handle.db.select().from(notificationsOutbox).where(like(notificationsOutbox.dedupeKey, `routine-cant:${bRun!.id}:%`));
    expect(cant).toHaveLength(2);
    expect(cant[0]).toMatchObject({ kind: "staff_update", status: "pending" });
    expect((cant[0]!.payload as { summaryLine: string }).summaryLine).toBe(`Elmurat can't do "Возвраты WB" today: Склад закрыт`);
    const [h] = await listRoutineRuns(t.ctx("nuraaly", local(MON, "17:00")), b.id);
    expect(h!.outcome).toBe("cant");
    expect(h!.comments.map((c) => [c.kind, c.text, c.author])).toEqual([["cant", "Склад закрыт", "Elmurat"]]);
    // Re-run: today's missing items are asked again (can't → open), the done ones stay done.
    const again = await rerunRoutineToday(t.ctx("nuraaly", local(MON, "17:00")), r.id);
    expect(again.status).toBe("open");
    expect(again.itemStates.i1?.state).toBe("done");
    expect(again.itemStates.i2).toBeUndefined();
    const sent = to(await tick(local(MON, "17:00")), elmurat).find((s) => s.message.title.includes("1C"))!;
    expect(sent.message.actions!.filter((a) => a.action === "routine_tick").map((a) => a.label)).toEqual(["✓ Jobutify"]);
  });

  it("an item flagged 'needs a comment' asks for it on tick; the text becomes that item's comment", async () => {
    await onTelegram(elmurat, CHAT);
    const r = await routine({ items: JSON.stringify([{ label: "Касса", details: "Сверить с банком", needsComment: true }, { label: "Склад" }]) });
    const ask = to(await tick(local(MON, "15:00")), elmurat)[0]!;
    expect(ask.message.lines.map((l) => l.text)).toContain("    Сверить с банком");
    const a = await handleTelegramUpdate(t.handle.db, press(CHAT, cbFor(ask, "✓ Касса")), local(MON, "15:01"));
    expect(sendText(a).join("")).toContain("Напишите комментарий — пункт «Касса»");
    await handleTelegramUpdate(t.handle.db, msgUpdate(CHAT, "Остаток 12 400"), local(MON, "15:02"));
    const [run] = await runs(r.id);
    expect(run!.itemStates.i1).toMatchObject({ state: "done", comment: "Остаток 12 400" });
    const [c] = await t.handle.db.select().from(routineComments).where(eq(routineComments.runId, run!.id));
    expect(c).toMatchObject({ itemKey: "i1", kind: "done" });
  });
});

describe("services: checklist edits while today's run is open; assignee ↔ company", () => {
  const input = (items: unknown, extra: Record<string, unknown> = {}) => ({
    title: "1C записи",
    assignee: `person:${elmurat}`,
    scheduleKind: "weekly",
    days: [1, 2, 3, 4, 5, 6, 7],
    time: "15:00",
    confirmation: "checklist",
    items,
    chase: { reminderMode: "every", chaseEveryMinutes: "120", chaseUntil: "19:00", escalateAt: "off", escalateAfterChases: "0" },
    ...extra,
  });

  it("open run: new items join it, removed ones drop out, the person gets ONE updated message", async () => {
    await onTelegram(elmurat, CHAT);
    const r = await routine();
    const ask = to(await tick(local(MON, "15:00")), elmurat)[0]!;
    await handleTelegramUpdate(t.handle.db, press(CHAT, cbFor(ask, "✓ Kiwi Go")), local(MON, "15:01"));
    await handleTelegramUpdate(t.handle.db, press(CHAT, cbFor(ask, "✓ Jobutify")), local(MON, "15:02"));
    const ed = await updateRoutine(
      t.ctx("nuraaly", local(MON, "15:30")),
      r.id,
      input(JSON.stringify([{ key: "i1", label: "Kiwi Go" }, { key: "i3", label: "Alura Brand (all shops)" }, { label: "Upsell Group" }])),
    );
    expect(ed.todayEffect).toBe("open_run_updated");
    const [run] = await runs(r.id);
    expect(run!.items.map((i) => [i.key, i.label])).toEqual([
      ["i1", "Kiwi Go"],
      ["i3", "Alura Brand (all shops)"],
      ["i4", "Upsell Group"],
    ]);
    expect(run!.itemsDone).toEqual(["i1"]);
    expect(Object.keys(run!.itemStates)).toEqual(["i1"]);
    const reg = await tick(local(MON, "15:31"));
    const upd = to(reg, elmurat);
    expect(upd.map((s) => s.message.title)).toEqual(["🔄 Рутина обновлена: 1C записи"]);
    expect(upd[0]!.message.actions!.filter((a) => a.action === "routine_tick").map((a) => a.label)).toEqual(["✓ Alura Brand (all shops)", "✓ Upsell Group"]);
    expect(to(await tick(local(MON, "15:40")), elmurat)).toHaveLength(0);
  });

  it("a done run stays done (from the next run) unless 'add to today too' reopens it with the new items", async () => {
    await onTelegram(elmurat, CHAT);
    const r = await routine({ items: "Kiwi Go" });
    const ask = to(await tick(local(MON, "15:00")), elmurat)[0]!;
    await handleTelegramUpdate(t.handle.db, press(CHAT, cbFor(ask, "✓ Kiwi Go")), local(MON, "15:01"));
    expect((await runs(r.id))[0]!.status).toBe("done");
    const later = await updateRoutine(t.ctx("nuraaly", local(MON, "16:00")), r.id, input("Kiwi Go\nJobutify"));
    expect(later.todayEffect).toBe("next_run");
    expect((await runs(r.id))[0]).toMatchObject({ status: "done" });
    const today = await updateRoutine(t.ctx("nuraaly", local(MON, "16:05")), r.id, input("Kiwi Go\nJobutify\nAlura Brand", { applyToToday: "true" }));
    expect(today.todayEffect).toBe("reopened");
    const [run] = await runs(r.id);
    expect(run).toMatchObject({ status: "open", itemsDone: ["i1"], doneAt: null });
    expect(run!.items.map((i) => i.label)).toEqual(["Kiwi Go", "Jobutify", "Alura Brand"]);
    expect(to(await tick(local(MON, "16:06")), elmurat).map((s) => s.message.title)).toEqual(["🔄 Рутина обновлена: 1C записи"]);
  });

  it("server-side: a person's routine must be for one of their companies (or group-wide); founders: any; the form gets each person's companies", async () => {
    const base = { title: "WMS", scheduleKind: "weekly", days: [1], time: "10:00", confirmation: "button", items: "" };
    await expect(createRoutine(t.ctx("nuraaly"), { ...base, assignee: `person:${edil}`, companyId: t.companyIds["kiwi-go"] })).rejects.toThrow(/does not work for that company/);
    await createRoutine(t.ctx("nuraaly"), { ...base, assignee: `person:${edil}`, companyId: t.companyIds.jobutify });
    await createRoutine(t.ctx("nuraaly"), { ...base, assignee: `person:${edil}`, companyId: "" });
    await createRoutine(t.ctx("nuraaly"), { ...base, assignee: `user:${t.userIds.talant}`, companyId: t.companyIds["kiwi-go"] });
    await expect(
      createRoutine(t.ctx("nuraaly"), { ...base, assignee: `person:${edil}`, chase: { escalateTo: [edil] } }),
    ).rejects.toThrow(/founders/);
    const opts = await routineFormOptions(t.ctx("nuraaly"));
    expect(opts.people.find((p) => p.id === edil)!.companyIds).toEqual([t.companyIds.jobutify]);
    expect(opts.people.find((p) => p.id === elmurat)!.companyIds).toHaveLength(5);
  });

  it("the message log lists every message about the routine (asks, reminders, founder lines) with its status", async () => {
    await onTelegram(elmurat, CHAT);
    const r = await routine({ items: "Kiwi Go", chase: { reminderMode: "every", chaseEveryMinutes: "120", chaseUntil: "19:00", escalateAt: "18:00", escalateAfterChases: "0" } });
    await tick(local(MON, "15:00"));
    await tick(local(MON, "17:00"));
    await tick(local(MON, "18:00"));
    const log = await listRoutineMessages(t.ctx("nuraaly", local(MON, "18:30")), r.id);
    expect(log.map((m) => m.kind).sort()).toEqual(["Ask", "Escalation", "Escalation", "Reminder"]);
    expect(log.find((m) => m.kind === "Ask")).toMatchObject({ to: "Elmurat", status: "sent" });
    const [h] = await listRoutineRuns(t.ctx("nuraaly", local(MON, "18:30")), r.id);
    expect(h!.reminders.map((d) => d.toISOString())).toEqual([local(MON, "17:00").toISOString()]);
    expect(h!.run.escalatedAt).not.toBeNull();
    const rows = await t.handle.db.select().from(notificationsOutbox).where(and(eq(notificationsOutbox.kind, "staff_routine"), eq(notificationsOutbox.status, "sent")));
    expect(rows).toHaveLength(2);
  });
});
