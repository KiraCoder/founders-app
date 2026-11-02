/**
 * C2 review fixes: one push per task per day, atomic claims, urgent caps, unlinked
 * founders, per-item failures, parked items re-rendered, webhook responses, old buttons.
 * Never talks to Telegram: fetch is stubbed wherever a token is set.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { POST as webhook } from "@/app/api/telegram/webhook/route";
import type { DbHandle } from "@/server/db/connect";
import {
  notificationActionTokens,
  notificationPreferences,
  notificationsOutbox,
  reminderSnoozes,
  taskEvents,
  tasks,
  telegramLinkCodes,
  telegramLinks,
  type OutboxItem,
} from "@/server/db/schema";
import { mintActionTokens } from "@/server/notifications/action-tokens";
import { createChannelRegistry, createDevRegistry, type ChannelRegistry } from "@/server/notifications/channels";
import { dispatch, MAX_ATTEMPTS, STALE_CLAIM_MS, URGENT_TASK_PUSHES_PER_DAY } from "@/server/notifications/dispatcher";
import { consumeLinkCode, createLinkCode } from "@/server/notifications/linking";
import { enqueue } from "@/server/notifications/outbox";
import { planTick } from "@/server/notifications/planner";
import { TelegramApi } from "@/server/notifications/telegram-api";
import { handleTelegramUpdate } from "@/server/notifications/telegram-bot";
import type { TelegramUpdate } from "@/server/notifications/telegram-api";
import { runTick } from "@/server/notifications/tick";
import type { NeutralMessage, NotificationChannel, Recipient } from "@/server/notifications/types";
import { snoozeTaskReminder, unlinkMyTelegram, updateMyPreferences } from "@/server/services/notifications";
import { changeTaskDeadline, createTask, getTask } from "@/server/services/tasks";
import { createTestDb, FIXED_NOW, type TestDb } from "../helpers/db";

const at = (utc: string) => new Date(utc);
const EVENING = at("2026-11-02T13:00:00Z"); // 19:00 Bishkek
const text = (m: unknown) => JSON.stringify(m);
const PREFS = {
  morningSummaryTime: "08:30",
  eveningCheckEnabled: true,
  eveningCheckTime: "19:00",
  quietStart: "21:00",
  quietEnd: "08:00",
  maxOtherPerDay: 3,
  urgentAtNight: false,
};

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.handle.close();
});
beforeEach(async () => {
  const db = t.handle.db;
  await db.delete(notificationActionTokens);
  await db.delete(notificationsOutbox);
  await db.delete(reminderSnoozes);
  await db.delete(telegramLinks);
  await db.delete(telegramLinkCodes);
  await db.delete(notificationPreferences);
  await db.delete(taskEvents);
  await db.delete(tasks);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
});

type Sent = { userId: string; message: NeutralMessage };

/** Records every message. `chatRequired` mimics production: unlinked founders are unreachable. */
function recorder(opts: { chatRequired?: boolean; onSend?: (r: Recipient, m: NeutralMessage) => Promise<void> | void } = {}) {
  const sent: Sent[] = [];
  const channel: NotificationChannel = {
    name: "dev",
    async send(recipient, message) {
      await opts.onSend?.(recipient, message);
      sent.push({ userId: recipient.userId, message });
      return { ok: true, providerMessageId: "rec" };
    },
  };
  const registry: ChannelRegistry = {
    get: () => channel,
    resolve: (r) => (opts.chatRequired && !r.telegramChatId ? null : channel),
  };
  return { sent, registry };
}

async function outbox(userId?: string): Promise<OutboxItem[]> {
  const q = t.handle.db.select().from(notificationsOutbox);
  return userId ? q.where(eq(notificationsOutbox.userId, userId)) : q;
}

async function task(who: "nuraaly" | "talant", title: string, dueDate: string, extra: Record<string, unknown> = {}) {
  return createTask(t.ctx(who), { title, companyId: t.companyIds["kiwi-go"], dueDate, ...extra });
}

async function link(who: "nuraaly" | "talant", chatId: number) {
  const { code } = await createLinkCode(t.handle.db, t.userIds[who], FIXED_NOW);
  const res = await consumeLinkCode(t.handle.db, code, { chatId: String(chatId), telegramUserId: String(chatId) }, FIXED_NOW);
  expect(res.ok).toBe(true);
}

/** Runs plan + dispatch every `stepMinutes` between two instants. */
async function runDay(from: Date, to: Date, registry: ChannelRegistry, stepMinutes = 30) {
  for (let ms = from.getTime(); ms <= to.getTime(); ms += stepMinutes * 60_000) {
    await planTick(t.handle.db, new Date(ms));
    await dispatch(t.handle.db, new Date(ms), { registry });
  }
}

const taskPushes = (sent: Sent[], title: string) =>
  sent.filter((s) => !s.message.title.startsWith("Good morning") && s.message.title !== "Evening check" && text(s.message).includes(title));

describe("#1 one push per task per local day", () => {
  it("snooze, then a chase day: only the snooze reminder arrives that day", async () => {
    // Due 31 Oct: 2 Nov is day 2 (no chase), 3 Nov is day 3 (chase day).
    const late = await task("nuraaly", "Snoozed late", "2026-10-31");
    await snoozeTaskReminder(t.ctx("nuraaly"), late.id); // 2 Nov 12:00 -> reminder 3 Nov 12:00
    const { sent, registry } = recorder();
    // 3 Nov 08:00 .. 23:30 Bishkek, a tick every 30 minutes.
    await runDay(at("2026-11-03T02:00:00Z"), at("2026-11-03T17:30:00Z"), registry);
    const pushes = taskPushes(sent, "Snoozed late");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.message.title).toBe("Reminder");
    const rows = (await outbox(t.userIds.nuraaly)).filter((r) => r.taskId === late.id);
    expect(rows.filter((r) => r.kind === "overdue_chase")).toHaveLength(0);
    expect(rows.find((r) => r.kind === "task_reminder")?.status).toBe("sent");
  });

  it("snooze of a task due tomorrow: no due-today nudge on top of the reminder", async () => {
    const due = await task("nuraaly", "Due tomorrow", "2026-11-03");
    await snoozeTaskReminder(t.ctx("nuraaly"), due.id);
    const { sent, registry } = recorder();
    await runDay(at("2026-11-03T02:00:00Z"), at("2026-11-03T17:30:00Z"), registry);
    expect(taskPushes(sent, "Due tomorrow")).toHaveLength(1);
  });

  it("snoozing twice the same day keeps exactly one reminder, at the latest time", async () => {
    const late = await task("nuraaly", "Twice", "2026-11-01");
    await snoozeTaskReminder(t.ctx("nuraaly"), late.id);
    await snoozeTaskReminder(t.ctx("nuraaly", at("2026-11-02T07:00:00Z")), late.id);
    const reminders = (await outbox(t.userIds.nuraaly)).filter((r) => r.kind === "task_reminder");
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({ status: "pending", dedupeKey: `touch:${late.id}:2026-11-03` });
    expect(reminders[0]!.scheduledFor.toISOString()).toBe("2026-11-03T07:00:00.000Z");
  });

  it("the dispatcher refuses a second push for the same task the same day, even under another key", async () => {
    const db = t.handle.db;
    const late = await task("nuraaly", "Two keys", "2026-11-02");
    await enqueue(db, { userId: t.userIds.nuraaly, kind: "task_reminder", taskId: late.id, scheduledFor: FIXED_NOW, dedupeKey: "a" });
    await enqueue(db, { userId: t.userIds.nuraaly, kind: "task_due_today", taskId: late.id, scheduledFor: FIXED_NOW, dedupeKey: "b" });
    const { sent, registry } = recorder();
    await dispatch(db, FIXED_NOW, { registry });
    await dispatch(db, at("2026-11-02T08:00:00Z"), { registry });
    expect(taskPushes(sent, "Two keys")).toHaveLength(1);
    expect((await outbox()).map((r) => r.lastError)).toContain("already_pushed_today");
  });
});

describe("#2 atomic claims", () => {
  it("an overlapping run never sends what a slow run is still sending", async () => {
    const db = t.handle.db;
    const late = await task("nuraaly", "Slow one", "2026-11-02");
    await enqueue(db, { userId: t.userIds.nuraaly, kind: "task_reminder", taskId: late.id, scheduledFor: FIXED_NOW, dedupeKey: "slow" });
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inSend = new Promise<void>((r) => (started = r));
    const slow = recorder({
      onSend: async () => {
        started();
        await gate;
      },
    });
    const first = dispatch(db, FIXED_NOW, { registry: slow.registry });
    await inSend;
    const [row] = await db.select().from(notificationsOutbox).where(eq(notificationsOutbox.dedupeKey, "slow"));
    expect(row!.status).toBe("sending");
    expect(row!.claimedAt).not.toBeNull();

    // A second run 5 minutes later (logical time) and even 9 real minutes later: nothing to take.
    const other = recorder();
    const wall = new Date(Date.now() + 9 * 60_000);
    const second = await dispatch(db, at("2026-11-02T06:05:00Z"), { registry: other.registry, clock: () => wall });
    expect(second.sent).toBe(0);
    expect(other.sent).toHaveLength(0);

    release();
    expect((await first).sent).toBe(1);
    expect(slow.sent).toHaveLength(1);
    const [done] = await db.select().from(notificationsOutbox).where(eq(notificationsOutbox.dedupeKey, "slow"));
    expect(done).toMatchObject({ status: "sent", attempts: 1, claimedAt: null });
  });

  it("an in-flight push counts against the budget of an overlapping run", async () => {
    const db = t.handle.db;
    await updateMyPreferences(t.ctx("nuraaly"), { ...PREFS, maxOtherPerDay: 1 });
    const a = await task("nuraaly", "Budget A", "2026-11-02");
    const b = await task("nuraaly", "Budget B", "2026-11-02");
    await enqueue(db, { userId: t.userIds.nuraaly, kind: "task_reminder", taskId: a.id, scheduledFor: FIXED_NOW, dedupeKey: "ba" });
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inSend = new Promise<void>((r) => (started = r));
    const slow = recorder({ onSend: async () => (started(), gate) });
    const first = dispatch(db, FIXED_NOW, { registry: slow.registry });
    await inSend;
    await enqueue(db, { userId: t.userIds.nuraaly, kind: "task_reminder", taskId: b.id, scheduledFor: FIXED_NOW, dedupeKey: "bb" });
    const other = recorder();
    const second = await dispatch(db, FIXED_NOW, { registry: other.registry });
    expect(second.parked).toBe(1);
    release();
    await first;
    const rows = await outbox(t.userIds.nuraaly);
    expect(rows.find((r) => r.dedupeKey === "ba")?.status).toBe("sent");
    expect(rows.find((r) => r.dedupeKey === "bb")?.status).toBe("parked");
  });

  it("a claim abandoned by a crashed run is taken again only after the timeout, as one attempt", async () => {
    const db = t.handle.db;
    const late = await task("nuraaly", "Crashed", "2026-11-02");
    await enqueue(db, { userId: t.userIds.nuraaly, kind: "task_reminder", taskId: late.id, scheduledFor: FIXED_NOW, dedupeKey: "crash" });
    const wall = new Date("2026-11-02T06:00:00Z");
    await db
      .update(notificationsOutbox)
      .set({ status: "sending", claimedAt: new Date(wall.getTime() - STALE_CLAIM_MS + 60_000) })
      .where(eq(notificationsOutbox.dedupeKey, "crash"));
    const { sent, registry } = recorder();
    expect((await dispatch(db, FIXED_NOW, { registry, clock: () => wall })).sent).toBe(0);
    const later = new Date(wall.getTime() + 2 * 60_000);
    expect((await dispatch(db, FIXED_NOW, { registry, clock: () => later })).sent).toBe(1);
    const [row] = await db.select().from(notificationsOutbox).where(eq(notificationsOutbox.dedupeKey, "crash"));
    expect(row).toMatchObject({ status: "sent", attempts: 2 }); // 1 for the lost claim + 1 send
    expect(sent).toHaveLength(1);
  });

  it("a claim abandoned too often is marked failed instead of retried forever", async () => {
    const db = t.handle.db;
    const late = await task("nuraaly", "Cursed", "2026-11-02");
    await enqueue(db, { userId: t.userIds.nuraaly, kind: "task_reminder", taskId: late.id, scheduledFor: FIXED_NOW, dedupeKey: "cursed" });
    await db
      .update(notificationsOutbox)
      .set({ status: "sending", attempts: MAX_ATTEMPTS - 1, claimedAt: new Date(Date.now() - STALE_CLAIM_MS - 1000) })
      .where(eq(notificationsOutbox.dedupeKey, "cursed"));
    const { sent, registry } = recorder();
    expect((await dispatch(db, FIXED_NOW, { registry })).failed).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it("Telegram calls carry a 10 second timeout", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      signals.push(init.signal);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
    await new TelegramApi("1:fake").sendMessage({ chat_id: 1, text: "x" });
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    // A hung request comes back as a retryable error, not a hang.
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      return new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("timed out"))));
    });
    const res = await new TelegramApi("1:fake").call("sendMessage", {}, 20);
    expect(res).toMatchObject({ ok: false });
    expect(res.description).toMatch(/network/);
  });
});

describe("#3 urgent priority vs budget", () => {
  it("urgent-priority task pushes have their own cap of 2/day and do not use the normal budget", async () => {
    const db = t.handle.db;
    for (let i = 1; i <= 4; i++) await task("nuraaly", `Urgent ${i}`, "2026-11-01", { priority: "urgent" });
    for (let i = 1; i <= 4; i++) await task("nuraaly", `Normal ${i}`, "2026-11-01");
    await planTick(db, FIXED_NOW);
    const { sent, registry } = recorder();
    await dispatch(db, FIXED_NOW, { registry });
    const chases = (await outbox(t.userIds.nuraaly)).filter((r) => r.kind === "overdue_chase");
    const urgent = chases.filter((r) => r.priority === "urgent");
    const normal = chases.filter((r) => r.priority !== "urgent");
    expect(urgent.filter((r) => r.status === "sent")).toHaveLength(URGENT_TASK_PUSHES_PER_DAY);
    expect(urgent.filter((r) => r.status === "parked").map((r) => r.lastError)).toEqual(["urgent_cap_full", "urgent_cap_full"]);
    expect(normal.filter((r) => r.status === "sent")).toHaveLength(3);
    expect(normal.filter((r) => r.status === "parked")).toHaveLength(1);
    expect(sent.filter((s) => s.message.title.startsWith("Overdue"))).toHaveLength(5);
  });

  it("only an explicit `urgent` notification bypasses the budget", async () => {
    const db = t.handle.db;
    await updateMyPreferences(t.ctx("nuraaly"), { ...PREFS, maxOtherPerDay: 0 });
    const a = await task("nuraaly", "Explicit urgent", "2026-11-02");
    const b = await task("nuraaly", "High priority", "2026-11-02", { priority: "high" });
    await enqueue(db, { userId: t.userIds.nuraaly, kind: "urgent", taskId: a.id, scheduledFor: FIXED_NOW, dedupeKey: "u", priority: "urgent" });
    await enqueue(db, { userId: t.userIds.nuraaly, kind: "task_reminder", taskId: b.id, scheduledFor: FIXED_NOW, dedupeKey: "h", priority: "high" });
    const { sent, registry } = recorder();
    await dispatch(db, FIXED_NOW, { registry });
    const rows = await outbox(t.userIds.nuraaly);
    expect(rows.find((r) => r.dedupeKey === "u")?.status).toBe("sent");
    expect(rows.find((r) => r.dedupeKey === "h")?.status).toBe("parked");
    expect(sent.map((s) => s.message.title)).toEqual(["Urgent"]);
  });
});

describe("#4 unlinked founder while Telegram is configured", () => {
  it("holds items as not_linked: nothing sent, no budget used, parked items not bundled; they flow after linking", async () => {
    const db = t.handle.db;
    process.env.TELEGRAM_BOT_TOKEN = "123456:TEST-TOKEN";
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }));
    });
    // An older parked item that must not be "bundled" into a summary nobody received.
    const old = await task("talant", "Old parked", "2026-11-05");
    await db.insert(notificationsOutbox).values({
      userId: t.userIds.talant,
      kind: "task_reminder",
      taskId: old.id,
      dedupeKey: "old-parked",
      status: "parked",
      parkedAt: at("2026-11-01T06:00:00Z"),
      scheduledFor: at("2026-11-01T04:00:00Z"),
    });
    for (let i = 1; i <= 4; i++) await task("talant", `T late ${i}`, "2026-11-01");
    await planTick(db, FIXED_NOW);
    const report = await dispatch(db, FIXED_NOW);
    expect(calls).toHaveLength(0);
    expect(report.sent).toBe(0);
    expect(report.notLinked).toBeGreaterThanOrEqual(5);
    const rows = await outbox(t.userIds.talant);
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(0);
    expect(rows.find((r) => r.dedupeKey === "old-parked")).toMatchObject({ status: "parked", bundledIntoId: null });
    // Held items are not retried on every tick.
    expect((await dispatch(db, at("2026-11-02T06:10:00Z"))).notLinked).toBe(0);

    await link("talant", 2002);
    const after = await dispatch(db, at("2026-11-02T06:20:00Z"));
    expect(after.sent).toBe(4); // morning summary + 3 chases (budget 3)
    expect(after.parked).toBe(1);
    const morning = calls.find((c) => String(c.text).includes("Good morning"))!;
    expect(String(morning.text)).toContain("Old parked");
    expect(calls.every((c) => c.chat_id === "2002")).toBe(true);
  });

  it("an unlink takes effect for the very next item of the same run", async () => {
    const db = t.handle.db;
    await link("nuraaly", 1001);
    const a = await task("nuraaly", "First", "2026-11-02");
    const b = await task("nuraaly", "Second", "2026-11-02");
    await enqueue(db, { userId: t.userIds.nuraaly, kind: "task_reminder", taskId: a.id, scheduledFor: FIXED_NOW, dedupeKey: "1" });
    await enqueue(db, { userId: t.userIds.nuraaly, kind: "task_reminder", taskId: b.id, scheduledFor: at("2026-11-02T06:00:01Z"), dedupeKey: "2" });
    const { sent, registry } = recorder({
      chatRequired: true,
      onSend: () => unlinkMyTelegram(t.ctx("nuraaly")),
    });
    const report = await dispatch(db, at("2026-11-02T06:01:00Z"), { registry });
    expect(sent).toHaveLength(1);
    expect(report.notLinked).toBe(1);
  });

  it("without a token everyone gets the dev inbox (no not_linked)", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("must not call the network");
    });
    await task("talant", "Dev only", "2026-11-01");
    await planTick(t.handle.db, FIXED_NOW);
    const report = await dispatch(t.handle.db, FIXED_NOW, { registry: createChannelRegistry({ telegramToken: null }) });
    expect(report.notLinked).toBe(0);
    expect(report.sent).toBeGreaterThan(0);
  });
});

describe("#5 one bad item does not stop the run", () => {
  it("records the error on that item (retry with backoff) and sends the rest", async () => {
    const db = t.handle.db;
    const a = await task("nuraaly", "Explodes", "2026-11-02");
    const b = await task("talant", "Fine", "2026-11-02");
    await enqueue(db, { userId: t.userIds.nuraaly, kind: "task_reminder", taskId: a.id, scheduledFor: FIXED_NOW, dedupeKey: "boom", priority: "high" });
    await enqueue(db, { userId: t.userIds.talant, kind: "task_reminder", taskId: b.id, scheduledFor: FIXED_NOW, dedupeKey: "fine" });
    const { sent, registry } = recorder({
      onSend: (r) => {
        if (r.userId === t.userIds.nuraaly) throw new Error("kaboom");
      },
    });
    const report = await dispatch(db, FIXED_NOW, { registry });
    expect(report).toMatchObject({ sent: 1, retrying: 1 });
    expect(sent.map((s) => s.userId)).toEqual([t.userIds.talant]);
    const [row] = await db.select().from(notificationsOutbox).where(eq(notificationsOutbox.dedupeKey, "boom"));
    expect(row).toMatchObject({ status: "pending", attempts: 1, lastError: "internal: kaboom", claimedAt: null });
    expect(row!.nextAttemptAt!.getTime()).toBe(FIXED_NOW.getTime() + 60_000);
  });

  it("the database rejects malformed preferences", async () => {
    const db = t.handle.db;
    const bad = [
      { quietStart: "25:00" },
      { quietEnd: "8:00" },
      { morningSummaryTime: "" },
      { eveningCheckTime: "19:00:00" },
      { maxOtherPerDay: 11 },
      { maxOtherPerDay: -1 },
    ];
    for (const patch of bad) {
      await expect(db.insert(notificationPreferences).values({ userId: t.userIds.nuraaly, ...patch })).rejects.toThrow();
    }
    await db.insert(notificationPreferences).values({ userId: t.userIds.nuraaly, quietStart: "13:00", quietEnd: "15:00" });
  });
});

describe("#6 evening check inside quiet hours", () => {
  it("is rejected with a clear message on the evening time field", async () => {
    const ctx = t.ctx("nuraaly");
    await expect(updateMyPreferences(ctx, { ...PREFS, eveningCheckTime: "22:00" })).rejects.toMatchObject({
      issues: [expect.objectContaining({ path: ["eveningCheckTime"], message: expect.stringContaining("quiet hours (21:00–08:00)") })],
    });
    await expect(updateMyPreferences(ctx, { ...PREFS, quietStart: "13:00", quietEnd: "15:00", eveningCheckTime: "14:30" })).rejects.toThrow(
      /quiet hours/,
    );
    // Fine when the evening check is off, or outside the window.
    await updateMyPreferences(ctx, { ...PREFS, eveningCheckEnabled: false, eveningCheckTime: "22:00" });
    await updateMyPreferences(ctx, { ...PREFS, quietStart: "13:00", quietEnd: "15:00", eveningCheckTime: "15:00" });
  });
});

describe("#7 parked items are re-checked at bundle time", () => {
  it("drops a parked item whose deadline was moved, and re-renders the others from today's state", async () => {
    const db = t.handle.db;
    for (let i = 1; i <= 4; i++) await task("nuraaly", `Parked ${i}`, "2026-11-01");
    await planTick(db, FIXED_NOW);
    const { registry } = recorder();
    await dispatch(db, FIXED_NOW, { registry });
    const parked = (await outbox(t.userIds.nuraaly)).filter((r) => r.status === "parked");
    expect(parked).toHaveLength(1);
    const parkedTask = await getTask(t.ctx("nuraaly"), parked[0]!.taskId!);

    // Deadline moved in the app (not via a button): the evening check must not list it.
    await changeTaskDeadline(t.ctx("nuraaly"), parkedTask.id, "2026-11-10");
    const evening = recorder();
    await dispatch(db, EVENING, { registry: evening.registry });
    const check = evening.sent.find((s) => s.message.title === "Evening check");
    expect(text(check?.message ?? "")).not.toContain("Parked reminders");
    expect((await outbox(t.userIds.nuraaly)).find((r) => r.id === parked[0]!.id)).toMatchObject({
      status: "cancelled",
      lastError: "no_longer_relevant",
    });
  });

  it("a parked line shows the current overdue days on the next morning", async () => {
    const db = t.handle.db;
    await updateMyPreferences(t.ctx("nuraaly"), { ...PREFS, eveningCheckEnabled: false, maxOtherPerDay: 0 });
    await task("nuraaly", "Ages", "2026-11-01");
    await planTick(db, FIXED_NOW);
    await dispatch(db, FIXED_NOW, { registry: recorder().registry });
    const next = recorder();
    const morning = at("2026-11-03T02:30:00Z");
    await planTick(db, morning);
    await dispatch(db, morning, { registry: next.registry });
    const summary = text(next.sent.find((s) => s.message.title.startsWith("Good morning"))!.message);
    expect(summary).toContain("Overdue: Ages — Kiwi Go · 2d overdue");
    expect(summary).not.toContain("1d overdue");
  });

  it("Done / Snooze / Move also cancel parked items for that task", async () => {
    const db = t.handle.db;
    await updateMyPreferences(t.ctx("nuraaly"), { ...PREFS, maxOtherPerDay: 0 });
    const late = await task("nuraaly", "Parked then done", "2026-11-01");
    await planTick(db, FIXED_NOW);
    await dispatch(db, FIXED_NOW, { registry: recorder().registry });
    expect((await outbox(t.userIds.nuraaly)).find((r) => r.taskId === late.id)?.status).toBe("parked");
    await link("nuraaly", 111);
    const cb = await mintActionTokens(db, {
      userId: t.userIds.nuraaly,
      outboxId: null,
      now: FIXED_NOW,
      actions: [{ action: "done", taskId: late.id, label: "Done" }],
    });
    await handleTelegramUpdate(db, press(111, cb[`done:${late.id}`]!), FIXED_NOW);
    expect((await outbox(t.userIds.nuraaly)).find((r) => r.taskId === late.id)).toMatchObject({
      status: "cancelled",
      lastError: "task_closed",
    });
  });
});

function press(chatId: number, data: string, type: "private" | "group" = "private", fromId = chatId): TelegramUpdate {
  return {
    update_id: 9,
    callback_query: {
      id: "cb",
      from: { id: fromId },
      data,
      message: { message_id: 10, chat: { id: chatId, type }, text: "Reminder" },
    },
  };
}

describe("Telegram buttons: groups and old buttons", () => {
  it("buttons pressed in a group chat do nothing", async () => {
    const db = t.handle.db;
    await link("nuraaly", 111);
    const late = await task("nuraaly", "Group press", "2026-11-01");
    const cb = await mintActionTokens(db, {
      userId: t.userIds.nuraaly,
      outboxId: null,
      now: FIXED_NOW,
      actions: [{ action: "done", taskId: late.id, label: "Done" }],
    });
    const res = await handleTelegramUpdate(db, press(-500, cb[`done:${late.id}`]!, "group", 111), FIXED_NOW);
    expect(res).toEqual([{ method: "answerCallbackQuery", params: { callback_query_id: "cb", text: "This button does not work here." } }]);
    expect((await getTask(t.ctx("nuraaly"), late.id)).status).toBe("todo");
    // The token was not consumed: it still works from the founder's private chat.
    await handleTelegramUpdate(db, press(111, cb[`done:${late.id}`]!), FIXED_NOW);
    expect((await getTask(t.ctx("nuraaly"), late.id)).status).toBe("done");
  });

  it("old buttons stop working after unlink, also when the chat is relinked to the other founder", async () => {
    const db = t.handle.db;
    await link("nuraaly", 111);
    const late = await task("nuraaly", "Old button", "2026-11-01", { visibility: "private", companyId: null });
    const cb = await mintActionTokens(db, {
      userId: t.userIds.nuraaly,
      outboxId: null,
      now: FIXED_NOW,
      actions: [{ action: "done", taskId: late.id, label: "Done" }],
    });
    await unlinkMyTelegram(t.ctx("nuraaly"));
    const unlinked = await handleTelegramUpdate(db, press(111, cb[`done:${late.id}`]!), FIXED_NOW);
    expect(String(unlinked[0]!.params.text)).toContain("not linked");

    await link("talant", 111);
    const relinked = await handleTelegramUpdate(db, press(111, cb[`done:${late.id}`]!), FIXED_NOW);
    expect(relinked).toHaveLength(1);
    expect(String(relinked[0]!.params.text)).toMatch(/expired|already used/);
    expect((await getTask(t.ctx("nuraaly"), late.id)).status).toBe("todo");
  });
});

describe("#8 webhook responses", () => {
  const SECRET = "webhook-secret-value-for-tests";
  const post = (body: unknown) =>
    webhook(
      new Request("http://x/api/telegram/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": SECRET, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const help: TelegramUpdate = {
    update_id: 1,
    message: { message_id: 1, chat: { id: 4242, type: "private" }, from: { id: 4242 }, text: "/help" },
  };
  const g = globalThis as unknown as { __foundersDb?: Promise<DbHandle> };

  beforeEach(() => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    g.__foundersDb = Promise.resolve(t.handle);
  });
  afterEach(() => {
    g.__foundersDb = undefined;
  });

  it("returns bot replies only with dev tools on and no token", async () => {
    const devBody = await (await post(help)).json();
    expect(devBody.actions).toHaveLength(1);

    // Production build without DEV_TOOLS: never in the response.
    vi.stubEnv("NODE_ENV", "production");
    expect(await (await post(help)).json()).toEqual({ ok: true });

    // Dev tools on but a real token: replies go to Telegram (stubbed), not into the response.
    vi.stubEnv("DEV_TOOLS", "1");
    process.env.TELEGRAM_BOT_TOKEN = "123456:TEST-TOKEN";
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ ok: true, result: {} }));
    });
    expect(await (await post(help)).json()).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    vi.unstubAllEnvs();
    expect(await (await post(help)).json()).toEqual({ ok: true });
  });
});

describe("#9 dev tick", () => {
  it("plans and delivers only for the given founder, into the dev inbox, even with a token", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:TEST-TOKEN";
    vi.stubGlobal("fetch", () => {
      throw new Error("must not call the network");
    });
    await link("nuraaly", 1001);
    await link("talant", 2002);
    await task("talant", "Talant's", "2026-11-01");
    await runTick(t.handle.db, FIXED_NOW, { registry: createDevRegistry(), userIds: [t.userIds.nuraaly] });
    expect(await outbox(t.userIds.talant)).toHaveLength(0);
    const mine = await outbox(t.userIds.nuraaly);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.filter((r) => r.status === "sent").every((r) => r.channel === "dev")).toBe(true);
  });
});

describe("enum values exist in the database", () => {
  it("has the sending and not_linked statuses", async () => {
    const res = await t.handle.db.execute(sql`select unnest(enum_range(null::outbox_status))::text as v`);
    const rows = ((res as unknown as { rows?: { v: string }[] }).rows ?? (res as unknown as { v: string }[])).map((r) => r.v);
    expect(rows).toEqual(expect.arrayContaining(["sending", "not_linked"]));
  });
});
