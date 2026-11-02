import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { holdingAskItems, intercompanyActs, notificationsOutbox, people, users } from "@/server/db/schema";
import type { ChannelRegistry } from "@/server/notifications/channels";
import { dispatch } from "@/server/notifications/dispatcher";
import { consumeLinkCode, createLinkCode } from "@/server/notifications/linking";
import { planTick } from "@/server/notifications/planner";
import { handleTelegramUpdate } from "@/server/notifications/telegram-bot";
import type { TelegramUpdate } from "@/server/notifications/telegram-api";
import type { ActionCallbacks, NeutralMessage, NotificationChannel } from "@/server/notifications/types";
import { listFlows, getActsGrid, updateFlow, type FlowView } from "@/server/services/holding";
import { askCardFromGrid, markAskedInApp } from "@/server/services/holding-asks";
import { updateMyPreferences } from "@/server/services/notifications";
import { todayInTimeZone } from "@/lib/dates";
import { createTestDb, type TestDb } from "../helpers/db";

/** Local Bishkek time (UTC+6) → Date. */
const bishkek = (day: string, hm: string) => new Date(`${day}T${hm}:00+06:00`);

let t: TestDb;
let sew: FlowView;
let app: FlowView;

interface Sent {
  userId: string;
  message: NeutralMessage;
  callbacks?: ActionCallbacks;
  /** Bishkek day it went out. */
  day: string;
}
const sent: Sent[] = [];
let currentDay = "";
const channel: NotificationChannel = {
  name: "dev",
  async send(recipient, message, callbacks) {
    sent.push({ userId: recipient.userId, message, callbacks, day: currentDay });
    return { ok: true, providerMessageId: "rec" };
  },
};
const registry: ChannelRegistry = { get: () => channel, resolve: () => channel };

async function tick(now: Date) {
  currentDay = todayInTimeZone(now, "Asia/Bishkek");
  await planTick(t.handle.db, now);
  await dispatch(t.handle.db, now, { registry, clock: () => now });
}

/** plan + dispatch every 30 minutes from 07:00 to 22:00 on each day. */
async function days(from: string, to: string) {
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d = new Date(d.getTime() + 86_400_000)) {
    const day = d.toISOString().slice(0, 10);
    for (let m = 7 * 60; m <= 22 * 60; m += 30) {
      await tick(bishkek(day, `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`));
    }
  }
}

const morningOf = (who: "nuraaly" | "talant", day: string) =>
  sent.find((s) => s.userId === t.userIds[who] && s.message.title.startsWith("Good morning") && s.day === day);

const holdingLines = (m: NeutralMessage) => {
  const i = m.lines.findIndex((l) => l.text === "Holding · акты");
  return i < 0 ? [] : m.lines.slice(i + 1).filter((l) => l.style === "item").map((l) => l.text);
};

async function items(who?: "nuraaly" | "talant") {
  const rows = await t.handle.db.select().from(holdingAskItems);
  return who ? rows.filter((r) => r.userId === t.userIds[who]) : rows;
}

function press(chatId: number, data: string): TelegramUpdate {
  return {
    update_id: 9,
    callback_query: { id: "cb", from: { id: chatId }, data, message: { message_id: 10, chat: { id: chatId, type: "private" }, text: "Good morning" } },
  };
}

beforeAll(async () => {
  t = await createTestDb({ now: bishkek("2026-11-01", "12:00") });
  const flows = await listFlows(t.ctx("nuraaly"));
  sew = flows.find((f) => f.label === "Alura Style → Alura Brand")!;
  app = flows.find((f) => f.label === "Jobutify → Kiwi Go")!;
  await updateFlow(t.ctx("nuraaly"), sew.id, { since: "2026-09-01" });
  await updateFlow(t.ctx("nuraaly"), app.id, { since: "2026-10-01" });
  // Talant reads his summary an hour later than Nuraaly.
  const prefs = { eveningCheckEnabled: false, eveningCheckTime: "19:00", quietStart: "21:00", quietEnd: "08:00", maxOtherPerDay: 3, urgentAtNight: false };
  await updateMyPreferences(t.ctx("nuraaly"), { ...prefs, morningSummaryTime: "08:30" });
  await updateMyPreferences(t.ctx("talant"), { ...prefs, morningSummaryTime: "09:30" });
  const { code } = await createLinkCode(t.handle.db, t.userIds.nuraaly, bishkek("2026-11-01", "12:00"));
  expect((await consumeLinkCode(t.handle.db, code, { chatId: "111", telegramUserId: "111" }, bishkek("2026-11-01", "12:00"))).ok).toBe(true);
});
afterAll(async () => {
  await t.handle.close();
});

const runDays = days;

describe("pushing the founders to ask Elmurat", () => {
  it("nothing before the 11th (October is still in the grace days)", async () => {
    await runDays("2026-11-09", "2026-11-10");
    expect(await items()).toHaveLength(0);
    const m = morningOf("nuraaly", "2026-11-10")!.message;
    expect(holdingLines(m)).toEqual([]);
    expect(m.actions ?? []).toEqual([]);
  });

  it("on the 11th: ONE grouped item per founder in the morning summary, with a button; nothing else is pushed", async () => {
    await tick(bishkek("2026-11-11", "08:30"));
    expect(await items()).toHaveLength(2);
    const n = morningOf("nuraaly", "2026-11-11")!;
    expect(holdingLines(n.message)).toEqual([
      "Ask Elmurat for 3 missing акты: Alura Style → Alura Brand (Sep, Oct), Jobutify → Kiwi Go (Oct)",
    ]);
    expect(n.message.actions).toEqual([{ label: "I asked Elmurat", action: "holding_asked", askId: expect.any(String) }]);
    const cb = Object.values(n.callbacks ?? {});
    expect(cb).toHaveLength(1);
    // The item was shown once; ticking again all day queues nothing new.
    expect((await items("nuraaly"))[0]).toMatchObject({ status: "shown", kind: "ask", roundKey: "2026-11" });
    for (const hm of ["08:35", "09:00"]) await tick(bishkek("2026-11-11", hm));
    expect(await items()).toHaveLength(2);
    expect((await items("talant"))[0]).toMatchObject({ status: "pending" });
    // Only morning summaries were queued: holding never adds a push of its own.
    const kinds = new Set((await t.handle.db.select().from(notificationsOutbox)).map((r) => r.kind));
    expect([...kinds]).toEqual(["morning_summary"]);
  });

  it("Nuraaly taps “I asked Elmurat” in Telegram → cells turn requested, Talant's pending item is cancelled", async () => {
    const n = morningOf("nuraaly", "2026-11-11")!;
    const data = Object.values(n.callbacks!)[0]!;
    const res = await handleTelegramUpdate(t.handle.db, press(111, data), bishkek("2026-11-11", "09:00"));
    expect(res[0]).toMatchObject({ method: "answerCallbackQuery", params: { text: expect.stringContaining("Marked 3 акты as asked today") } });
    const acts = await t.handle.db.select().from(intercompanyActs);
    expect(acts.map((a) => `${a.period}|${a.status}|${a.requestedOn}|${a.requestedBy === t.userIds.nuraaly}`).sort()).toEqual([
      "2026-09-01|requested|2026-11-11|true",
      "2026-10-01|requested|2026-11-11|true",
      "2026-10-01|requested|2026-11-11|true",
    ]);
    expect((await items("nuraaly"))[0]).toMatchObject({ status: "done", resolvedBy: t.userIds.nuraaly });
    expect((await items("talant"))[0]).toMatchObject({ status: "cancelled", reason: "asked_by:Nuraaly" });
    // Talant's 09:30 summary has no holding section.
    await tick(bishkek("2026-11-11", "09:30"));
    const tm = morningOf("talant", "2026-11-11")!.message;
    expect(holdingLines(tm)).toEqual([]);
    for (const hm of ["12:00", "18:00"]) await tick(bishkek("2026-11-11", hm));
    expect(await items()).toHaveLength(2);
    // The same button again does nothing (single-use token).
    const again = await handleTelegramUpdate(t.handle.db, press(111, data), bishkek("2026-11-11", "09:05"));
    expect(again[0]).toMatchObject({ params: { text: "This button has expired or was already used." } });
  });

  it("reminder: only after 7 days, only on Monday, at most weekly", async () => {
    await runDays("2026-11-12", "2026-11-22");
    // Monday 16 Nov: asked 5 days ago → no reminder.
    expect((await items()).filter((i) => i.kind === "reminder")).toHaveLength(0);
    await runDays("2026-11-23", "2026-11-29");
    const week1 = (await items()).filter((i) => i.kind === "reminder");
    expect(week1.map((i) => i.roundKey)).toEqual(["2026-11-23", "2026-11-23"]);
    const line = holdingLines(morningOf("talant", "2026-11-23")!.message);
    expect(line).toEqual([
      "Still waiting for 3 акты from Elmurat (asked 11 Nov): Alura Style → Alura Brand (Sep, Oct), Jobutify → Kiwi Go (Oct)",
    ]);
    expect(morningOf("talant", "2026-11-23")!.message.actions).toEqual([
      { label: "I asked again", action: "holding_asked", askId: expect.any(String) },
    ]);
    // Tuesday to Sunday: no other day mentions it.
    for (const day of ["2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29"]) {
      expect(holdingLines(morningOf("talant", day)!.message)).toEqual([]);
    }
    // Talant asks again in the app on Tuesday → dates move; next Monday (6 days) no reminder.
    await markAskedInApp(t.ctx("talant", bishkek("2026-11-24", "10:00")), askCardFromGrid(await getActsGrid(t.ctx("talant", bishkek("2026-11-24", "10:00")))).waiting.cells, "again");
    await runDays("2026-11-30", "2026-12-06");
    expect((await items()).filter((i) => i.kind === "reminder").map((i) => i.roundKey)).toEqual(["2026-11-23", "2026-11-23"]);
    await runDays("2026-12-07", "2026-12-07");
    const reminders = (await items()).filter((i) => i.kind === "reminder");
    expect(reminders.map((i) => i.roundKey).sort()).toEqual(["2026-11-23", "2026-11-23", "2026-12-07", "2026-12-07"]);
  });

  it("next month asks only for what is missing then (November), not what was already asked", async () => {
    await runDays("2026-12-11", "2026-12-11");
    const dec = (await items()).filter((i) => i.roundKey === "2026-12");
    expect(dec).toHaveLength(2);
    expect(holdingLines(morningOf("nuraaly", "2026-12-11")!.message)).toEqual([
      "Ask Elmurat for 2 missing акты: Alura Style → Alura Brand (Nov), Jobutify → Kiwi Go (Nov)",
    ]);
  });

  it("asking in the app cancels the other founder's pending item before his summary", async () => {
    // Fresh round in January: plan at 07:00, before either summary.
    await tick(bishkek("2027-01-11", "07:00"));
    expect((await items()).filter((i) => i.roundKey === "2027-01").every((i) => i.status === "pending")).toBe(true);
    const ctx = t.ctx("talant", bishkek("2027-01-11", "07:10"));
    const card = askCardFromGrid(await getActsGrid(ctx));
    expect(card.message).toContain("Элмурат, здравствуйте!");
    expect(card.message).toContain("декабрь 2026");
    expect(await markAskedInApp(ctx, card.missing.cells, "missing")).toBe(card.missing.count);
    const jan = (await items()).filter((i) => i.roundKey === "2027-01");
    expect(jan.find((i) => i.userId === t.userIds.talant)).toMatchObject({ status: "done" });
    expect(jan.find((i) => i.userId === t.userIds.nuraaly)).toMatchObject({ status: "cancelled", reason: "asked_by:Talant" });
    await tick(bishkek("2027-01-11", "08:30"));
    // 11 Jan 2027 is a Monday: only the weekly reminder about the older months is left.
    const lines = holdingLines(morningOf("nuraaly", "2027-01-11")!.message);
    expect(lines.some((l) => l.startsWith("Ask Elmurat"))).toBe(false);
    expect(lines).toEqual([expect.stringMatching(/^Still waiting for 3 акты from Elmurat \(asked 24 Nov\)/)]);
  });

  it("nothing ever goes to anyone but the two founders (Elmurat is a people record, not a recipient)", async () => {
    const founders = [t.userIds.nuraaly, t.userIds.talant];
    expect(new Set(sent.map((s) => s.userId))).toEqual(new Set(founders));
    const rows = await t.handle.db.select().from(notificationsOutbox);
    expect(rows.every((r) => founders.includes(r.userId))).toBe(true);
    expect((await items()).every((i) => founders.includes(i.userId))).toBe(true);
    const [elmurat] = await t.handle.db.select().from(people).where(eq(people.fullName, "Elmurat"));
    expect(elmurat!.userId).toBeNull();
    const founderRoles = await t.handle.db.select({ role: users.role }).from(users).where(inArray(users.id, founders));
    expect(founderRoles.every((r) => r.role === "founder")).toBe(true);
  });
});
