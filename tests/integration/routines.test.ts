/**
 * Routines (0029): schedule → run → ask → checklist ticks → re-ask only what is missing → chase,
 * quiet hours, until, escalation → missed / partly; pause; founder routines; authorization; CRUD.
 * In-memory PGlite, no real Telegram.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { DEFAULT_STAFF_SETTINGS } from "@/lib/staff-schemas";
import {
  appSettings,
  notificationActionTokens,
  notificationsOutbox,
  people,
  routineRuns,
  routines,
  telegramLinkCodes,
  telegramLinks,
} from "@/server/db/schema";
import { ensureExampleRoutine, EXAMPLE_ROUTINE_KEY } from "@/server/db/example-routines";
import { mintActionTokens } from "@/server/notifications/action-tokens";
import type { ChannelRegistry } from "@/server/notifications/channels";
import { dispatch } from "@/server/notifications/dispatcher";
import { createLinkCode } from "@/server/notifications/linking";
import { planTick } from "@/server/notifications/planner";
import { handleTelegramUpdate, type BotAction } from "@/server/notifications/telegram-bot";
import type { TelegramUpdate } from "@/server/notifications/telegram-api";
import { actionKey, type ActionCallbacks, type NeutralMessage, type NotificationChannel } from "@/server/notifications/types";
import {
  createExampleRoutine,
  createRoutine,
  deleteRoutine,
  exampleRoutineAvailable,
  listRoutineRuns,
  listRoutines,
  runRoutineNow,
  setRoutineStatus,
  updateRoutine,
} from "@/server/services/routines";
import { createPersonInvite, setPersonBotEnabled, setPersonChase, updateStaffDefaults } from "@/server/services/staff";
import { createTestDb, type TestDb } from "../helpers/db";

const local = (day: string, hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), h! - 6, m!));
};
const MON = "2026-11-02";
const TUE = "2026-11-03";
const TZ = "Asia/Bishkek";
const ELMURAT_CHAT = 7_000_002;
const EDIL_CHAT = 7_000_001;
const FOUNDER_CHAT = 7_000_009;

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
  let n = 100;
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
const press = (chatId: number, data: string, keyboard: string[] = [data]): TelegramUpdate => ({
  update_id: Math.floor(Math.random() * 1e9),
  callback_query: {
    id: "cq",
    from: { id: chatId },
    data,
    message: { message_id: 9, chat: { id: chatId, type: "private" }, text: "m", reply_markup: { inline_keyboard: [keyboard.map((d) => ({ text: "b", callback_data: d }))] } },
  },
});
const textOf = (a: BotAction[]) => a.map((x) => String(x.params.text ?? "")).join("\n");

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
const oneC = (over: Record<string, unknown> = {}) =>
  createRoutine(t.ctx("nuraaly", local(MON, "08:00")), {
    title: "1C записи",
    description: "",
    companyId: "",
    assignee: `person:${elmurat}`,
    scheduleKind: "weekly",
    days: [1, 2, 3, 4, 5, 6],
    time: "15:00",
    confirmation: "checklist",
    items: "Kiwi Go\nJobutify\nAlura Brand",
    chase: { chaseEveryMinutes: "120", chaseUntil: "19:00", escalateAt: "19:00" },
    ...over,
  });
const runs = (routineId: string) => t.handle.db.select().from(routineRuns).where(eq(routineRuns.routineId, routineId));
const cbFor = (s: Sent, label: string) => {
  const a = s.message.actions!.find((x) => x.label === label)!;
  return s.callbacks[actionKey(a)]!;
};

describe("seed: the founder's first routine", () => {
  it("Elmurat 1C exists after the seed (Mon–Sat 15:00, one item per active company, Marketing not on it); idempotent, never re-created", async () => {
    // The test DB was seeded: the beforeEach removed it, so re-run the seed helper with the marker cleared.
    await t.handle.db.delete(appSettings).where(eq(appSettings.key, "example_routines_seeded"));
    expect(await ensureExampleRoutine(t.handle.db, local(MON, "08:00"))).toBe(true);
    expect(await ensureExampleRoutine(t.handle.db, local(MON, "08:00"))).toBe(false);
    const [r] = await t.handle.db.select().from(routines).where(eq(routines.seedKey, EXAMPLE_ROUTINE_KEY));
    expect(r).toMatchObject({ assigneePersonId: elmurat, time: "15:00", days: [1, 2, 3, 4, 5, 6], confirmation: "checklist" });
    expect(r!.items.map((i) => i.label)).toEqual(["Kiwi Go", "Jobutify", "Alura Brand", "Alura Style", "Upsell Group", "Asqa Zou Holding"]);
    expect(r!.chase).toEqual({ chaseEveryMinutes: 120, chaseUntil: "19:00", escalateAt: "19:00" });
    // Deleted by a founder → the seed does not bring it back; the page button can.
    await t.handle.db.delete(routines);
    expect(await ensureExampleRoutine(t.handle.db, local(MON, "08:00"))).toBe(false);
    expect(await exampleRoutineAvailable(t.ctx("nuraaly"))).toBe(true);
    await createExampleRoutine(t.ctx("nuraaly"));
    expect(await exampleRoutineAvailable(t.ctx("nuraaly"))).toBe(false);
    await expect(createExampleRoutine(t.ctx("nuraaly"))).rejects.toThrow(/already exists/);
  });
});

describe("runs, checklist and chasing", () => {
  it("opens one run on a scheduled day at the ask time; ticks re-ask only what is missing; all ticked → done", async () => {
    await onTelegram(elmurat, ELMURAT_CHAT);
    const r = await oneC();
    expect(to(await tick(local(MON, "14:50")), elmurat)).toHaveLength(0);
    expect(await runs(r.id)).toHaveLength(0);
    const ask = to(await tick(local(MON, "15:00")), elmurat);
    expect(ask.map((s) => s.message.title)).toEqual(["Рутина: 1C записи"]);
    expect(ask[0]!.message.actions!.map((a) => a.label)).toEqual(["✓ Kiwi Go", "✓ Jobutify", "✓ Alura Brand", "✓ Всё сделано"]);
    // Idempotent: the same tick again changes nothing.
    expect(to(await tick(local(MON, "15:10")), elmurat)).toHaveLength(0);
    expect(await runs(r.id)).toHaveLength(1);

    const keyboard = Object.values(ask[0]!.callbacks) as string[];
    const t1 = await handleTelegramUpdate(t.handle.db, press(ELMURAT_CHAT, cbFor(ask[0]!, "✓ Kiwi Go"), keyboard), local(MON, "15:20"));
    expect(t1[0]!.params.text).toBe("✓ Kiwi Go. Осталось: 2");
    const edit = t1.find((a) => a.method === "editMessageText")!;
    expect(JSON.stringify(edit.params.reply_markup)).not.toContain(cbFor(ask[0]!, "✓ Kiwi Go"));
    // Pressing the same item again (another copy) is harmless.
    const again = await mintActionTokens(t.handle.db, {
      personId: elmurat,
      outboxId: null,
      actions: [{ action: "routine_tick", runId: (await runs(r.id))[0]!.id, item: (ask[0]!.message.actions![0] as { item?: string }).item!, label: "x" }],
      now: local(MON, "15:21"),
    });
    expect((await handleTelegramUpdate(t.handle.db, press(ELMURAT_CHAT, Object.values(again)[0]!), local(MON, "15:21")))[0]!.params.text).toBe("Уже отмечено.");

    // 17:00 reminder: only the two unticked items.
    const re = to(await tick(local(MON, "17:00")), elmurat)[0]!;
    expect(re.message.title).toBe("Напоминание: 1C записи");
    expect(re.message.actions!.map((a) => a.label)).toEqual(["✓ Jobutify", "✓ Alura Brand", "✓ Всё сделано"]);
    // /routines shows the same.
    const cmd = await handleTelegramUpdate(t.handle.db, msgUpdate(ELMURAT_CHAT, "/routines"), local(MON, "17:05"));
    expect(textOf(cmd)).toContain("Alura Brand");
    expect(textOf(cmd)).not.toContain("Kiwi Go");
    await handleTelegramUpdate(t.handle.db, press(ELMURAT_CHAT, cbFor(re, "✓ Jobutify")), local(MON, "17:10"));
    const last = await handleTelegramUpdate(t.handle.db, press(ELMURAT_CHAT, cbFor(re, "✓ Alura Brand")), local(MON, "17:11"));
    expect(last[0]!.params.text).toBe("Рутина выполнена ✓ Спасибо!");
    const [run] = await runs(r.id);
    expect(run).toMatchObject({ status: "done", chaseCount: 1 });
    // Nothing more today; the founders get one summary line.
    expect(to(await tick(local(MON, "18:59")), elmurat)).toHaveLength(0);
    const lines = await t.handle.db
      .select()
      .from(notificationsOutbox)
      .where(and(eq(notificationsOutbox.userId, t.userIds.nuraaly), eq(notificationsOutbox.kind, "staff_update")));
    expect(lines.map((l) => (l.payload as { summaryLine: string }).summaryLine)).toEqual(['Elmurat finished the routine "1C записи" (Telegram)']);
    const history = await listRoutineRuns(t.ctx("nuraaly", local(MON, "20:00")), r.id);
    expect(history.map((h) => h.outcome)).toEqual(["on_time"]);
  });

  it("escalates to the founders at the escalate time; unfinished runs close as partly / missed; the next run still happens", async () => {
    await onTelegram(elmurat, ELMURAT_CHAT);
    const r = await oneC();
    const ask = to(await tick(local(MON, "15:00")), elmurat)[0]!;
    await handleTelegramUpdate(t.handle.db, press(ELMURAT_CHAT, cbFor(ask, "✓ Kiwi Go")), local(MON, "15:05"));
    await tick(local(MON, "17:00"));
    // 19:00 = chase until: no reminder, but the founders hear about it.
    const at19 = await tick(local(MON, "19:00"));
    expect(to(at19, elmurat)).toHaveLength(0);
    const esc = at19.sent.filter((s) => s.message.title === "Routine not done");
    expect(esc.map((s) => s.to).sort()).toEqual([t.userIds.nuraaly, t.userIds.talant].sort());
    expect(esc[0]!.message.lines[0]!.text).toBe('Elmurat hasn\'t finished "1C записи" today — missing: Jobutify, Alura Brand (1 reminder)');
    expect((await runs(r.id))[0]!.status).toBe("escalated");
    // Once only.
    await tick(local(MON, "19:30"));
    expect((await t.handle.db.select().from(notificationsOutbox).where(eq(notificationsOutbox.dedupeKey, `routine-esc:${(await runs(r.id))[0]!.id}`))).length).toBe(2);
    // Next day: Monday's run is closed "partly"; Tuesday's run opens at 15:00.
    await tick(local(TUE, "09:00"));
    expect((await runs(r.id)).map((x) => [x.runDate, x.status])).toEqual([[MON, "partly"]]);
    await tick(local(TUE, "15:00"));
    await tick(local("2026-11-04", "09:00"));
    const all = (await runs(r.id)).sort((a, b) => a.runDate.localeCompare(b.runDate));
    expect(all.map((x) => [x.runDate, x.status])).toEqual([
      [MON, "partly"],
      [TUE, "missed"],
    ]);
    const hist = await listRoutineRuns(t.ctx("nuraaly", local("2026-11-04", "10:00")), r.id);
    expect(hist.map((h) => [h.outcome, h.missing.length])).toEqual([
      ["missed", 3],
      ["partly", 2],
    ]);
  });

  it("not on unscheduled days; quiet hours hold; escalation after N reminders; per-routine cadence", async () => {
    await onTelegram(elmurat, ELMURAT_CHAT);
    await setPersonChase(t.ctx("nuraaly"), elmurat, { quietStart: "16:00", quietEnd: "16:30" });
    const r = await oneC({
      days: [1],
      confirmation: "button",
      items: "",
      chase: { chaseEveryMinutes: "60", chaseUntil: "20:00", escalateAfterChases: "2", escalateAt: "off" },
    });
    expect(to(await tick(local(TUE, "15:00")), elmurat)).toHaveLength(0);
    expect(await runs(r.id)).toHaveLength(0);
    const ask = to(await tick(local(MON, "15:00")), elmurat);
    expect(ask[0]!.message.actions!.map((a) => a.label)).toEqual(["Готово"]);
    // 16:00 reminder falls in quiet hours: held until 16:30.
    expect(to(await tick(local(MON, "16:00")), elmurat)).toHaveLength(0);
    expect(to(await tick(local(MON, "16:30")), elmurat)).toHaveLength(1);
    const at17 = await tick(local(MON, "17:00"));
    expect(to(at17, elmurat)).toHaveLength(1);
    // 2 reminders without it being done → escalated on the next pass.
    const at1710 = await tick(local(MON, "17:10"));
    expect(at1710.sent.some((s) => s.message.title === "Routine not done")).toBe(true);
    // Готово still closes it (late).
    const tok = to(at17, elmurat)[0]!;
    await handleTelegramUpdate(t.handle.db, press(ELMURAT_CHAT, cbFor(tok, "Готово")), local(MON, "17:20"));
    const hist = await listRoutineRuns(t.ctx("nuraaly", local(MON, "18:00")), r.id);
    expect(hist[0]!.outcome).toBe("late");
  });

  it("pause stops runs and cancels waiting messages; resume brings them back; the bot off → no run", async () => {
    await onTelegram(elmurat, ELMURAT_CHAT);
    const r = await oneC();
    await setRoutineStatus(t.ctx("nuraaly"), r.id, "paused");
    expect(to(await tick(local(MON, "15:00")), elmurat)).toHaveLength(0);
    expect(await runs(r.id)).toHaveLength(0);
    await setRoutineStatus(t.ctx("nuraaly"), r.id, "active");
    await setPersonBotEnabled(t.ctx("nuraaly"), elmurat, false);
    expect(to(await tick(local(MON, "15:10")), elmurat)).toHaveLength(0);
    expect(await runs(r.id)).toHaveLength(0);
    await setPersonBotEnabled(t.ctx("nuraaly"), elmurat, true);
    expect(to(await tick(local(MON, "15:20")), elmurat)).toHaveLength(1);
    // A paused routine's queued reminder is cancelled.
    await planTick(t.handle.db, local(MON, "17:00"), { timeZone: TZ });
    await setRoutineStatus(t.ctx("nuraaly"), r.id, "paused");
    const pending = await t.handle.db.select().from(notificationsOutbox).where(eq(notificationsOutbox.kind, "staff_routine"));
    expect(pending.filter((p) => p.status === "pending")).toHaveLength(0);
  });

  it("Run now: opens today's run on any day and asks right away (once per slot)", async () => {
    await onTelegram(elmurat, ELMURAT_CHAT);
    const r = await oneC({ days: [7] });
    await runRoutineNow(t.ctx("nuraaly", local(MON, "16:00")), r.id);
    const reg = recorder();
    await dispatch(t.handle.db, local(MON, "16:00"), { registry: reg.registry, timeZone: TZ });
    expect(to(reg, elmurat).map((s) => s.message.title)).toEqual(["Рутина: 1C записи"]);
    // The planner's 15:00 slot for this run is the same slot: not asked twice.
    expect(to(await tick(local(MON, "16:05")), elmurat)).toHaveLength(0);
    expect(to(await tick(local(MON, "17:00")), elmurat).map((s) => s.message.title)).toEqual(["Напоминание: 1C записи"]);
  });
});

describe("founder routines", () => {
  it("nag the founder through their normal channel and rules; the founder ticks with the buttons", async () => {
    const { code } = await createLinkCode(t.handle.db, t.userIds.talant, local(MON, "08:00"));
    await handleTelegramUpdate(t.handle.db, msgUpdate(FOUNDER_CHAT, `/start ${code}`), local(MON, "08:00"));
    const r = await createRoutine(t.ctx("nuraaly"), {
      title: "Review cash",
      assignee: `user:${t.userIds.talant}`,
      scheduleKind: "monthly",
      monthDay: "2",
      days: [],
      time: "11:00",
      confirmation: "button",
      items: "",
    });
    const reg = await tick(local(MON, "11:00"));
    const push = reg.sent.find((s) => s.to === t.userIds.talant && s.message.title === "Routine: Review cash")!;
    expect(push.message.actions!.map((a) => a.label)).toEqual(["Done"]);
    expect(reg.sent.some((s) => s.to === t.userIds.nuraaly && s.message.title.startsWith("Routine"))).toBe(false);
    // Nuraaly cannot press Talant's button.
    const data = Object.values(push.callbacks)[0]!;
    expect((await handleTelegramUpdate(t.handle.db, press(FOUNDER_CHAT + 1, data), local(MON, "11:05")))[0]!.params.text).toContain("not linked");
    const ok = await handleTelegramUpdate(t.handle.db, press(FOUNDER_CHAT, data), local(MON, "11:05"));
    expect(ok[0]!.params.text).toBe("Routine done ✓");
    expect((await runs(r.id))[0]!.status).toBe("done");
  });
});

describe("authorization", () => {
  it("a person ticks only runs of their own routines; forged / other-person tokens do nothing", async () => {
    await onTelegram(elmurat, ELMURAT_CHAT);
    await onTelegram(edil, EDIL_CHAT);
    const r = await oneC();
    const ask = to(await tick(local(MON, "15:00")), elmurat)[0]!;
    const runId = (await runs(r.id))[0]!.id;
    // Elmurat's token pressed in Edil's chat.
    expect((await handleTelegramUpdate(t.handle.db, press(EDIL_CHAT, cbFor(ask, "✓ Kiwi Go")), local(MON, "15:01")))[0]!.params.text).toBe(
      "Кнопка устарела или уже нажата.",
    );
    // A token minted for Edil on Elmurat's run: refused by the assignee rule.
    const forEdil = await mintActionTokens(t.handle.db, {
      personId: edil,
      outboxId: null,
      actions: [{ action: "routine_done", runId, label: "x" }],
      now: local(MON, "15:02"),
    });
    expect((await handleTelegramUpdate(t.handle.db, press(EDIL_CHAT, Object.values(forEdil)[0]!), local(MON, "15:02")))[0]!.params.text).toBe(
      "Эта рутина вам недоступна.",
    );
    expect((await handleTelegramUpdate(t.handle.db, press(EDIL_CHAT, "a:forged-token-0000000000"), local(MON, "15:03")))[0]!.params.text).toBe(
      "Кнопка устарела или уже нажата.",
    );
    expect((await runs(r.id))[0]).toMatchObject({ status: "open", itemsDone: [] });
    // Edil's /routines shows nothing of Elmurat's.
    expect(textOf(await handleTelegramUpdate(t.handle.db, msgUpdate(EDIL_CHAT, "/routines"), local(MON, "15:04")))).toContain("открытых рутин нет");
  });

  it("CRUD is founders-only; validation; delete only without history (archive instead); filters", async () => {
    const staff = { ...t.ctx("nuraaly"), user: { ...t.founders.nuraaly, role: "staff" as const } };
    await expect(listRoutines(staff)).rejects.toThrow(/Only the founders/);
    await expect(oneC({ assignee: "person:not-a-uuid" })).rejects.toThrow();
    const [founderPerson] = await t.handle.db.select().from(people).where(eq(people.userId, t.userIds.nuraaly));
    await expect(oneC({ assignee: `person:${founderPerson!.id}` })).rejects.toThrow(/Founders/);
    const r = await oneC({ companyId: t.companyIds.jobutify });
    await expect(createRoutine(staff, {})).rejects.toThrow(/Only the founders/);
    const edited = await updateRoutine(t.ctx("talant"), r.id, {
      title: "1C (edited)",
      assignee: `person:${elmurat}`,
      scheduleKind: "weekly",
      days: [2],
      time: "16:00",
      confirmation: "checklist",
      items: "Jobutify\nNew item",
      companyId: t.companyIds.jobutify,
    });
    expect(edited.items.find((i) => i.label === "Jobutify")!.key).toBe(r.items.find((i) => i.label === "Jobutify")!.key);
    expect((await listRoutines(t.ctx("nuraaly"), { companyId: t.companyIds.jobutify })).map((v) => v.routine.title)).toEqual(["1C (edited)"]);
    expect(await listRoutines(t.ctx("nuraaly"), { companyId: t.companyIds["kiwi-go"] })).toHaveLength(0);
    expect(await listRoutines(t.ctx("nuraaly"), { personId: elmurat })).toHaveLength(1);
    expect(await listRoutines(t.ctx("nuraaly"), { status: "paused" })).toHaveLength(0);
    // With a run it can only be archived.
    await runRoutineNow(t.ctx("nuraaly"), r.id);
    await expect(deleteRoutine(t.ctx("nuraaly"), r.id)).rejects.toThrow(/archive/);
    await setRoutineStatus(t.ctx("nuraaly"), r.id, "archived");
    await expect(updateRoutine(t.ctx("nuraaly"), r.id, {})).rejects.toThrow(/Restore/);
    const fresh = await oneC({ title: "Never ran" });
    await deleteRoutine(t.ctx("nuraaly"), fresh.id);
    expect((await listRoutines(t.ctx("nuraaly"))).map((v) => v.routine.title)).toEqual(["1C (edited)"]);
  });
});
