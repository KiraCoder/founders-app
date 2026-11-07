import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { holdingAskItems } from "@/server/db/schema";
import type { ChannelRegistry } from "@/server/notifications/channels";
import { dispatch } from "@/server/notifications/dispatcher";
import { consumeLinkCode, createLinkCode } from "@/server/notifications/linking";
import { planTick } from "@/server/notifications/planner";
import { handleTelegramUpdate } from "@/server/notifications/telegram-bot";
import type { ActionCallbacks, NeutralMessage, NotificationChannel } from "@/server/notifications/types";
import { listFlows, updateFlow } from "@/server/services/holding";
import { holdingSummarySection } from "@/server/services/holding-asks";
import { updateMyPreferences } from "@/server/services/notifications";
import { todayInTimeZone } from "@/lib/dates";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * Anti-spam: ask / reminder items must not pile up while a founder's summary is not
 * delivered (Telegram not linked, failed sends, quiet hours). Reproduces the review case:
 * Talant is not linked from 11 Nov to 13 Dec and links on Monday 14 Dec.
 */
const bishkek = (day: string, hm: string) => new Date(`${day}T${hm}:00+06:00`);

let t: TestDb;
interface Sent {
  userId: string;
  message: NeutralMessage;
  callbacks?: ActionCallbacks;
  day: string;
}
const sent: Sent[] = [];
let currentDay = "";
let failSends = false;
const channel: NotificationChannel = {
  name: "telegram",
  async send(recipient, message, callbacks) {
    if (failSends) return { ok: false, error: "network down" };
    sent.push({ userId: recipient.userId, message, callbacks, day: currentDay });
    return { ok: true, providerMessageId: "1" };
  },
};
// Like the real Telegram registry: only founders with a linked chat can be reached.
const registry: ChannelRegistry = { get: () => channel, resolve: (r) => (r.telegramChatId ? channel : null) };

async function tick(now: Date) {
  currentDay = todayInTimeZone(now, "Asia/Bishkek");
  await planTick(t.handle.db, now);
  await dispatch(t.handle.db, now, { registry, clock: () => now });
}
async function days(from: string, to: string) {
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d = new Date(d.getTime() + 86_400_000)) {
    for (const hm of ["07:00", "08:30", "09:30", "12:00"]) await tick(bishkek(d.toISOString().slice(0, 10), hm));
  }
}
const morningOf = (who: "nuraaly" | "talant", day: string) =>
  sent.find((s) => s.userId === t.userIds[who] && s.message.title.startsWith("Good morning") && s.day === day);
const holdingLines = (m: NeutralMessage) => {
  const i = m.lines.findIndex((l) => l.text === "Holding · акты");
  return i < 0 ? [] : m.lines.slice(i + 1).filter((l) => l.style === "item").map((l) => l.text);
};
const itemsOf = async (who: "nuraaly" | "talant") =>
  (await t.handle.db.select().from(holdingAskItems)).filter((r) => r.userId === t.userIds[who]);

async function link(who: "nuraaly" | "talant", chat: string, now: Date) {
  const { code } = await createLinkCode(t.handle.db, t.userIds[who], now);
  expect((await consumeLinkCode(t.handle.db, code, { chatId: chat, telegramUserId: chat }, now)).ok).toBe(true);
}

beforeAll(async () => {
  t = await createTestDb({ now: bishkek("2026-11-01", "12:00") });
  const flows = await listFlows(t.ctx("nuraaly"));
  const sew = flows.find((f) => f.label === "Alura Style → Alura Brand")!;
  await updateFlow(t.ctx("nuraaly"), sew.id, { since: "2026-09-01" });
  const prefs = { eveningCheckEnabled: false, eveningCheckTime: "19:00", quietStart: "21:00", quietEnd: "08:00", maxOtherPerDay: 3, urgentAtNight: false };
  await updateMyPreferences(t.ctx("nuraaly"), { ...prefs, morningSummaryTime: "08:30" });
  await updateMyPreferences(t.ctx("talant"), { ...prefs, morningSummaryTime: "09:30" });
  await link("nuraaly", "111", bishkek("2026-11-01", "12:00"));
});
afterAll(async () => {
  await t.handle.close();
});

describe("ask / reminder items never pile up", () => {
  it("Talant not linked 11 Nov–13 Dec, links Monday 14 Dec: ONE reminder line + ONE ask line, two buttons", async () => {
    await tick(bishkek("2026-11-11", "08:30"));
    // Nuraaly asks Elmurat from Telegram: Sep and Oct become "requested".
    const n = morningOf("nuraaly", "2026-11-11")!;
    await handleTelegramUpdate(
      t.handle.db,
      {
        update_id: 1,
        callback_query: { id: "cb", from: { id: 111 }, data: Object.values(n.callbacks!)[0]!, message: { message_id: 5, chat: { id: 111, type: "private" }, text: "Good morning" } },
      },
      bishkek("2026-11-11", "08:40"),
    );
    // Weekly reminders (23 Nov, 30 Nov, 7 Dec) and the December ask (11 Dec) are planned
    // for Talant while nothing reaches him.
    await days("2026-11-12", "2026-12-13");
    const before = (await itemsOf("talant")).filter((i) => i.status === "pending");
    // Each new round superseded the previous one of the same kind: one pending per kind.
    expect(before.map((i) => `${i.kind}|${i.roundKey}`).sort()).toEqual(["ask|2026-12", "reminder|2026-12-07"]);
    const superseded = (await itemsOf("talant")).filter((i) => i.reason === "superseded");
    expect(superseded.map((i) => i.roundKey).sort()).toEqual(["2026-11-23", "2026-11-30"]);

    await link("talant", "222", bishkek("2026-12-14", "06:00"));
    await days("2026-12-14", "2026-12-14");
    const m = morningOf("talant", "2026-12-14")!.message;
    // ONE line per person (Elmurat): his missing акт and what he still owes; two buttons.
    expect(holdingLines(m)).toEqual([
      "Ask Elmurat for 1 missing акт: Alura Style → Alura Brand (Nov); still waiting for 2 акты (asked 11 Nov): Alura Style → Alura Brand (Sep, Oct)",
    ]);
    expect(m.actions).toHaveLength(2);
    const pending = (await itemsOf("talant")).filter((i) => i.status === "pending");
    expect(pending).toHaveLength(0);
  });

  it("Telegram: pressing one button keeps the summary's other still-valid buttons", async () => {
    const m = morningOf("talant", "2026-12-14")!;
    const [askData, reminderData] = Object.values(m.callbacks!);
    const keyboard = { inline_keyboard: [[{ text: "I asked Elmurat", callback_data: askData! }, { text: "I asked again", callback_data: reminderData! }]] };
    const press = (data: string) =>
      handleTelegramUpdate(
        t.handle.db,
        { update_id: 2, callback_query: { id: "cb", from: { id: 222 }, data, message: { message_id: 7, chat: { id: 222, type: "private" }, text: "Good morning", reply_markup: keyboard } } },
        bishkek("2026-12-14", "09:40"),
      );
    const first = await press(askData!);
    const edit = first.find((a) => a.method === "editMessageText")!;
    expect(edit.params.reply_markup).toEqual({ inline_keyboard: [[{ text: "I asked again", callback_data: reminderData }]] });
    const second = await press(reminderData!);
    // Both used now: the edited message has no buttons left.
    expect(second.find((a) => a.method === "editMessageText")!.params.reply_markup).toBeUndefined();
  });

  it("failed sends: retries do not stack items either", async () => {
    failSends = true;
    // Mondays 21 and 28 Dec: a new reminder each week while every send fails.
    await days("2026-12-21", "2026-12-21");
    await days("2026-12-28", "2026-12-28");
    failSends = false;
    const pending = (await itemsOf("nuraaly")).filter((i) => i.status === "pending");
    expect(pending.map((i) => `${i.kind}|${i.roundKey}`)).toEqual(["reminder|2026-12-28"]);
  });

  it("backstop: two pending items of one kind are merged into one line and one button", async () => {
    const db = t.handle.db;
    const ctx = t.ctx("nuraaly", bishkek("2026-12-29", "08:30"));
    const [newest] = (await itemsOf("nuraaly")).filter((i) => i.status === "pending");
    // An older pending reminder with an overlapping month (as if left by an older version).
    const [older] = await db
      .insert(holdingAskItems)
      .values({ userId: t.userIds.nuraaly, kind: "reminder", roundKey: "2026-12-14x", cells: newest!.cells, createdAt: bishkek("2026-12-14", "07:00") })
      .returning();
    const section = (await holdingSummarySection(ctx))!;
    expect(section.lines.filter((l) => l.style === "item")).toHaveLength(1);
    expect(section.actions).toEqual([expect.objectContaining({ askId: newest!.id })]);
    expect(section.itemIds).toEqual([newest!.id]);
    const after = await itemsOf("nuraaly");
    expect(after.find((i) => i.id === older!.id)).toMatchObject({ status: "cancelled", reason: "superseded" });
  });
});
