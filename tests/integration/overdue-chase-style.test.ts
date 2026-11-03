/**
 * Overdue chase style (Settings → Notifications): "separate" (one push per task), "grouped"
 * (the default since the founders chose it: one 10:00 push listing every task due a chase,
 * buttons per task, counts as one push) and "summary_only" (no chase pushes). Never talks to
 * Telegram.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
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
import type { ChannelRegistry } from "@/server/notifications/channels";
import { dispatch } from "@/server/notifications/dispatcher";
import { consumeLinkCode, createLinkCode } from "@/server/notifications/linking";
import { MAX_GROUPED_CHASE_TASKS } from "@/server/notifications/messages";
import { enqueue, scheduleTaskReminder } from "@/server/notifications/outbox";
import { planTick } from "@/server/notifications/planner";
import { DEFAULT_PREFERENCES, loadPreferences } from "@/server/notifications/preferences";
import { renderTelegram, TELEGRAM_MAX_TEXT } from "@/server/notifications/render-telegram";
import { handleTelegramUpdate } from "@/server/notifications/telegram-bot";
import { taskTouchKey, type ActionCallbacks, type NeutralMessage, type NotificationChannel } from "@/server/notifications/types";
import { snoozeTaskReminder, updateMyPreferences } from "@/server/services/notifications";
import { createTask, getTask } from "@/server/services/tasks";
import { createTestDb, FIXED_NOW, type TestDb } from "../helpers/db";

/** Bishkek wall time on 2 Nov 2026 (FIXED_NOW is 12:00 that day). */
const nov2 = (hm: string) => new Date(`2026-11-02T${hm}:00+06:00`);
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

interface Sent {
  userId: string;
  message: NeutralMessage;
  callbacks: ActionCallbacks;
}

function recorder(opts: { chatRequired?: boolean; fail?: () => boolean } = {}) {
  const sent: Sent[] = [];
  const channel: NotificationChannel = {
    name: "telegram",
    async send(recipient, message, callbacks) {
      if (opts.fail?.()) return { ok: false, error: "boom" };
      sent.push({ userId: recipient.userId, message, callbacks: callbacks ?? {} });
      return { ok: true, providerMessageId: String(sent.length) };
    },
  };
  const registry: ChannelRegistry = {
    get: () => channel,
    resolve: (r) => (opts.chatRequired && !r.telegramChatId ? null : channel),
  };
  return { sent, registry };
}

async function link(who: "nuraaly" | "talant", chatId: number) {
  const { code } = await createLinkCode(t.handle.db, t.userIds[who], FIXED_NOW);
  const res = await consumeLinkCode(t.handle.db, code, { chatId: String(chatId), telegramUserId: String(chatId) }, FIXED_NOW);
  expect(res.ok).toBe(true);
}

async function task(title: string, dueDate: string, extra: Record<string, unknown> = {}) {
  return createTask(t.ctx("nuraaly", nov2("07:00")), { title, companyId: t.companyIds["kiwi-go"], dueDate, ...extra });
}

/** Four overdue tasks on a chase day on 2 Nov (1, 3, 7, 14 days) and one that is not (2 days). */
async function overdueSet() {
  return [
    await task("Chase A (1 day)", "2026-11-01", { priority: "high" }),
    await task("Chase B (3 days)", "2026-10-30"),
    await task("Chase C (7 days)", "2026-10-26"),
    await task("Chase D (14 days)", "2026-10-19"),
    await task("Not today (2 days)", "2026-10-31"),
  ];
}

async function setStyle(style: "separate" | "grouped" | "summary_only", extra: Partial<typeof PREFS> = {}) {
  await updateMyPreferences(t.ctx("nuraaly"), { ...PREFS, ...extra, overdueChaseStyle: style });
}

async function tick(hm: string, registry: ChannelRegistry) {
  const now = nov2(hm);
  await planTick(t.handle.db, now);
  await dispatch(t.handle.db, now, { registry });
}

async function runTimes(times: string[], registry: ChannelRegistry) {
  for (const hm of times) await tick(hm, registry);
}

/** The morning summary of 3 Nov (08:30 Bishkek). */
async function dispatchSummaryNextDay(registry: ChannelRegistry) {
  const now = new Date("2026-11-03T08:30:00+06:00");
  await planTick(t.handle.db, now);
  await dispatch(t.handle.db, now, { registry });
}

const nuraalyPushes = (sent: Sent[]) =>
  sent.filter((s) => s.userId === t.userIds.nuraaly && !s.message.title.startsWith("Good morning") && s.message.title !== "Evening check");

async function outboxFor(userId: string): Promise<OutboxItem[]> {
  return t.handle.db.select().from(notificationsOutbox).where(eq(notificationsOutbox.userId, userId));
}

describe("preference", () => {
  it("defaults to grouped (also for a new saved row) and keeps the saved style when a save leaves it out", async () => {
    expect(DEFAULT_PREFERENCES.overdueChaseStyle).toBe("grouped");
    expect((await loadPreferences(t.handle.db, t.userIds.nuraaly)).overdueChaseStyle).toBe("grouped");
    await updateMyPreferences(t.ctx("nuraaly"), PREFS);
    expect((await loadPreferences(t.handle.db, t.userIds.nuraaly)).overdueChaseStyle).toBe("grouped");
    await t.handle.db.insert(notificationPreferences).values({ userId: t.userIds.talant });
    expect((await loadPreferences(t.handle.db, t.userIds.talant)).overdueChaseStyle).toBe("grouped");
    await setStyle("separate");
    await updateMyPreferences(t.ctx("nuraaly"), { ...PREFS, maxOtherPerDay: 2 });
    const p = await loadPreferences(t.handle.db, t.userIds.nuraaly);
    expect(p.overdueChaseStyle).toBe("separate");
    expect(p.maxOtherPerDay).toBe(2);
    await expect(updateMyPreferences(t.ctx("nuraaly"), { ...PREFS, overdueChaseStyle: "loud" as never })).rejects.toBeTruthy();
    // The DB refuses an unknown value too.
    await expect(
      t.handle.db.update(notificationPreferences).set({ overdueChaseStyle: "loud" }).where(eq(notificationPreferences.userId, t.userIds.nuraaly)),
    ).rejects.toBeTruthy();
  });
});

describe("default (nothing saved): grouped", () => {
  it("sends one grouped 10:00 push for a founder who never saved preferences", async () => {
    await overdueSet();
    const { sent, registry } = recorder();
    await runTimes(["08:30", "10:00", "10:30"], registry);
    const pushes = nuraalyPushes(sent);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.message.title).toBe("4 tasks need a new deadline");
  });
});

describe("separate (the old default, still a choice)", () => {
  it("one push per task on chase days, within the budget; the rest is parked", async () => {
    await overdueSet();
    await setStyle("separate");
    const { sent, registry } = recorder();
    await runTimes(["08:30", "10:00", "10:30"], registry);
    const pushes = nuraalyPushes(sent);
    expect(pushes).toHaveLength(3);
    expect(pushes.every((p) => p.message.title.startsWith("Overdue"))).toBe(true);
    const rows = (await outboxFor(t.userIds.nuraaly)).filter((r) => r.kind === "overdue_chase");
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(3);
    expect(rows.filter((r) => r.status === "parked")).toHaveLength(1);
  });
});

describe("grouped", () => {
  it("sends ONE 10:00 push listing every task due a chase, with Done / +1 day / +3 days per task", async () => {
    const [a, b, c, d, notToday] = await overdueSet();
    await setStyle("grouped");
    const { sent, registry } = recorder();
    await runTimes(["08:30", "09:30", "10:00", "10:30", "11:00"], registry);
    const pushes = nuraalyPushes(sent);
    expect(pushes).toHaveLength(1);
    const push = pushes[0]!;
    expect(push.message.title).toBe("4 tasks need a new deadline");
    const text = JSON.stringify(push.message.lines);
    for (const x of [a, b, c, d]) expect(text).toContain(x!.title);
    expect(text).not.toContain(notToday!.title);
    expect(push.message.lines[0]!.text).toMatch(/^1\. Chase A \(1 day\)/); // high priority first

    // Button tokens: three per task, one keyboard row per task.
    const rendered = renderTelegram(push.message, push.callbacks);
    const kb = rendered.reply_markup!.inline_keyboard;
    expect(kb).toHaveLength(4);
    expect(kb.map((r) => r.map((btn) => btn.text))).toEqual([1, 2, 3, 4].map((i) => [`${i} · Done`, `${i} · +1 day`, `${i} · +3 days`]));
    const [leader] = (await outboxFor(t.userIds.nuraaly)).filter((r) => r.kind === "overdue_chase" && r.message);
    const tokens = await t.handle.db.select().from(notificationActionTokens).where(eq(notificationActionTokens.outboxId, leader!.id));
    expect(tokens).toHaveLength(12);
    for (const x of [a, b, c, d]) {
      expect(tokens.filter((tk) => tk.taskId === x!.id).map((tk) => tk.action).sort()).toEqual(["done", "move_1d", "move_3d"]);
    }

    // Every listed task's row is sent (the day's touch), bundled into the leader.
    const rows = (await outboxFor(t.userIds.nuraaly)).filter((r) => r.kind === "overdue_chase");
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.status === "sent")).toBe(true);
    expect(rows.filter((r) => r.bundledIntoId === leader!.id)).toHaveLength(3);
    expect((leader!.payload as { groupedTaskIds: string[] }).groupedTaskIds.sort()).toEqual([a, b, c, d].map((x) => x!.id).sort());
  });

  it("a button acts on its own task and leaves the other tasks' rows", async () => {
    const [, b] = await overdueSet();
    await setStyle("grouped");
    await link("nuraaly", 111);
    const { sent, registry } = recorder();
    await runTimes(["10:00"], registry);
    const push = nuraalyPushes(sent)[0]!;
    const rendered = renderTelegram(push.message, push.callbacks);
    // Order: high priority first (A), then the longest overdue: D, C, B → B is number 4.
    expect(push.message.lines.slice(0, 4).map((l) => l.text.slice(0, 10))).toEqual(["1. Chase A", "2. Chase D", "3. Chase C", "4. Chase B"]);
    const bMove = rendered.reply_markup!.inline_keyboard[3]!.find((btn) => btn.text === "4 · +1 day")!;
    const res = await handleTelegramUpdate(
      t.handle.db,
      {
        update_id: 1,
        callback_query: {
          id: "cb",
          from: { id: 111 },
          data: bMove.callback_data,
          message: { message_id: 5, chat: { id: 111, type: "private" }, text: rendered.text, reply_markup: rendered.reply_markup },
        },
      },
      nov2("10:05"),
    );
    expect((await getTask(t.ctx("nuraaly", nov2("10:05")), b!.id)).dueDate).toBe("2026-11-03");
    const edit = res.find((r) => r.method === "editMessageText")!;
    const kb = (edit.params.reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard;
    expect(kb.map((r) => r.map((btn) => btn.text))).toEqual([1, 2, 3].map((i) => [`${i} · Done`, `${i} · +1 day`, `${i} · +3 days`]));
    // B's own row is the day's touch (sent); the others stay sent too.
    const rows = (await outboxFor(t.userIds.nuraaly)).filter((r) => r.kind === "overdue_chase");
    expect(rows.every((r) => r.status === "sent")).toBe(true);
  });

  it("counts as one push against the budget", async () => {
    await overdueSet();
    await task("Due today 1", "2026-11-02");
    await task("Due today 2", "2026-11-02");
    await setStyle("grouped", { maxOtherPerDay: 2 });
    const { sent, registry } = recorder();
    await runTimes(["08:30", "10:00", "12:00", "12:30"], registry);
    const pushes = nuraalyPushes(sent);
    // 1 grouped push + 1 due-today nudge = the budget of 2; the second nudge is parked.
    expect(pushes.map((p) => p.message.title)).toEqual(["4 tasks need a new deadline", "Due today"]);
    const due = (await outboxFor(t.userIds.nuraaly)).filter((r) => r.kind === "task_due_today");
    expect(due.map((r) => r.status).sort()).toEqual(["parked", "sent"]);
    expect(due.find((r) => r.status === "parked")!.lastError).toBe("daily_budget_full");
  });

  it("is parked like any push when the budget is already full", async () => {
    await overdueSet();
    await setStyle("grouped", { maxOtherPerDay: 0 });
    const { sent, registry } = recorder();
    await runTimes(["10:00", "10:30"], registry);
    expect(nuraalyPushes(sent)).toHaveLength(0);
    const rows = (await outboxFor(t.userIds.nuraaly)).filter((r) => r.kind === "overdue_chase");
    expect(rows.every((r) => r.status === "parked" && r.lastError === "daily_budget_full")).toBe(true);
  });

  it("is the day's touch for each task listed: a snooze reminder that day is cancelled", async () => {
    const [a, b] = await overdueSet();
    await setStyle("grouped");
    const { sent, registry } = recorder();
    // B was snoozed yesterday at 09:00: its reminder fires today 09:00 and takes B's touch.
    await snoozeTaskReminder(t.ctx("nuraaly", new Date("2026-11-01T09:00:00+06:00")), b!.id);
    await runTimes(["08:30", "09:00", "10:00"], registry);
    const pushes = nuraalyPushes(sent);
    expect(pushes.map((p) => p.message.title)).toEqual(["Reminder", "3 tasks need a new deadline"]);
    expect(JSON.stringify(pushes[1]!.message.lines)).not.toContain(b!.title);

    // A legacy-keyed reminder for A later today is cancelled; the per-day key is not revived.
    await enqueue(t.handle.db, { userId: t.userIds.nuraaly, kind: "task_reminder", taskId: a!.id, dedupeKey: `snooze:${a!.id}:x`, scheduledFor: nov2("15:00") });
    const revived = await scheduleTaskReminder(t.handle.db, {
      userId: t.userIds.nuraaly,
      taskId: a!.id,
      scheduledFor: nov2("16:00"),
      dedupeKey: taskTouchKey(a!.id, "2026-11-02"),
    });
    expect(revived.created).toBe(false);
    await runTimes(["15:00", "16:00"], registry);
    expect(nuraalyPushes(sent)).toHaveLength(2);
    const legacy = (await outboxFor(t.userIds.nuraaly)).find((r) => r.dedupeKey === `snooze:${a!.id}:x`)!;
    expect(legacy.status).toBe("cancelled");
    expect(legacy.lastError).toBe("already_pushed_today");
  });

  it("waits for the end of quiet hours and then goes out once", async () => {
    await overdueSet();
    await setStyle("grouped", { quietStart: "21:00", quietEnd: "11:00", eveningCheckTime: "19:00" });
    const { sent, registry } = recorder();
    await runTimes(["10:00", "10:30", "11:00", "11:30"], registry);
    const pushes = nuraalyPushes(sent);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.message.title).toBe("4 tasks need a new deadline");
  });

  it("is held while not linked and goes out as one push once linked", async () => {
    await overdueSet();
    await setStyle("grouped");
    const { sent, registry } = recorder({ chatRequired: true });
    await runTimes(["10:00"], registry);
    expect(sent).toHaveLength(0);
    const rows = (await outboxFor(t.userIds.nuraaly)).filter((r) => r.kind === "overdue_chase");
    expect(rows.every((r) => r.status === "not_linked")).toBe(true);
    await link("nuraaly", 111);
    await runTimes(["10:30", "11:00"], registry);
    const pushes = nuraalyPushes(sent);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.message.title).toBe("4 tasks need a new deadline");
  });

  it("a failed send retries all tasks together", async () => {
    await overdueSet();
    await setStyle("grouped");
    let fail = true;
    const { sent, registry } = recorder({ fail: () => fail });
    await runTimes(["10:00"], registry);
    const rows = (await outboxFor(t.userIds.nuraaly)).filter((r) => r.kind === "overdue_chase");
    expect(rows.every((r) => r.status === "pending" && r.nextAttemptAt)).toBe(true);
    fail = false;
    await runTimes(["10:30"], registry);
    expect(nuraalyPushes(sent)).toHaveLength(1);
    expect(nuraalyPushes(sent)[0]!.message.title).toBe("4 tasks need a new deadline");
  });

  it("fits Telegram's 4096 characters: tasks that do not fit are '+N more', not touched; the footer stays", async () => {
    // 12 tasks one day overdue; "&" renders as "&amp;", so each line is ~1.5k characters.
    const made = [];
    for (let i = 0; i < 12; i++) made.push(await task(`${String(i).padStart(2, "0")} ${"&".repeat(290)}`, "2026-11-01"));
    await setStyle("grouped");
    const { sent, registry } = recorder();
    await runTimes(["10:00"], registry);
    const push = nuraalyPushes(sent)[0]!;
    expect(push.message.title).toBe("12 tasks need a new deadline");
    const rendered = renderTelegram(push.message, push.callbacks);
    expect(rendered.text.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT);
    const listedLines = push.message.lines.filter((l) => /^\d+\. /.test(l.text));
    expect(listedLines.length).toBeGreaterThan(0);
    expect(listedLines.length).toBeLessThan(MAX_GROUPED_CHASE_TASKS);
    expect(rendered.reply_markup!.inline_keyboard).toHaveLength(listedLines.length);
    // Budgeted, not cut: "+N more" and the footer survive, no "…".
    expect(push.message.lines.at(-2)!.text).toBe(`+${12 - listedLines.length} more — open the app`);
    expect(push.message.lines.at(-1)!.text).toBe("Done closes a task; +1 day / +3 days moves its deadline.");
    expect(push.message.lines.some((l) => l.text === "…")).toBe(false);
    const rows = (await outboxFor(t.userIds.nuraaly)).filter((r) => r.kind === "overdue_chase");
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(listedLines.length);
    expect(rows.filter((r) => r.status === "cancelled" && r.lastError === "grouped_not_listed")).toHaveLength(12 - listedLines.length);
  });

  it("lists at most MAX_GROUPED_CHASE_TASKS tasks, then +N more", async () => {
    for (let i = 0; i < 12; i++) await task(`Short ${i}`, "2026-11-01");
    await setStyle("grouped");
    const { sent, registry } = recorder();
    await runTimes(["10:00"], registry);
    const push = nuraalyPushes(sent)[0]!;
    expect(push.message.lines.filter((l) => /^\d+\. /.test(l.text))).toHaveLength(MAX_GROUPED_CHASE_TASKS);
    expect(push.message.lines.some((l) => l.text === "+2 more — open the app")).toBe(true);
    expect(renderTelegram(push.message, push.callbacks).reply_markup!.inline_keyboard).toHaveLength(MAX_GROUPED_CHASE_TASKS);
  });
});

describe("grouped: the leader row is not always listed", () => {
  /**
   * Plans 10:00, then makes `leaderTaskId`'s chase row the oldest so claimNext picks it first
   * (a low task and a normal task both map to outbox priority "normal"), then dispatches.
   */
  async function dispatchWithLeader(leaderTaskId: string, registry: ChannelRegistry) {
    await planTick(t.handle.db, nov2("10:00"));
    await t.handle.db
      .update(notificationsOutbox)
      .set({ createdAt: new Date("2026-11-01T00:00:00Z") })
      .where(and(eq(notificationsOutbox.taskId, leaderTaskId), eq(notificationsOutbox.kind, "overdue_chase")));
    await dispatch(t.handle.db, nov2("10:00"), { registry });
  }

  async function expectLeaderUntouched(leaderTaskId: string, listedCount: number, registry: ChannelRegistry, sent: Sent[]) {
    const rows = (await outboxFor(t.userIds.nuraaly)).filter((r) => r.kind === "overdue_chase");
    const leader = rows.find((r) => r.taskId === leaderTaskId)!;
    expect(leader.status).toBe("cancelled");
    expect(leader.lastError).toBe("grouped_not_listed");
    // The first listed row carries the message, its buttons and the one budget slot.
    const carriers = rows.filter((r) => r.status === "sent" && !r.bundledIntoId);
    expect(carriers).toHaveLength(1);
    const carrier = carriers[0]!;
    expect(carrier.message).toBeTruthy();
    const ids = (carrier.payload as { groupedTaskIds: string[] }).groupedTaskIds;
    expect(ids).toHaveLength(listedCount);
    expect(ids).not.toContain(leaderTaskId);
    expect(rows.filter((r) => r.status === "sent" && r.bundledIntoId === carrier.id)).toHaveLength(listedCount - 1);
    const tokens = await t.handle.db.select().from(notificationActionTokens).where(eq(notificationActionTokens.outboxId, carrier.id));
    expect(tokens).toHaveLength(listedCount * 3);
    expect(tokens.some((tk) => tk.taskId === leaderTaskId)).toBe(false);

    // Not touched today: a reminder for it later today still goes out.
    await enqueue(t.handle.db, { userId: t.userIds.nuraaly, kind: "task_reminder", taskId: leaderTaskId, dedupeKey: `snooze:${leaderTaskId}:x`, scheduledFor: nov2("15:00") });
    await dispatch(t.handle.db, nov2("15:00"), { registry });
    const reminder = (await outboxFor(t.userIds.nuraaly)).find((r) => r.dedupeKey === `snooze:${leaderTaskId}:x`)!;
    expect(reminder.status).toBe("sent");
    expect(nuraalyPushes(sent).map((p) => p.message.title)).toEqual([expect.stringMatching(/tasks need a new deadline$/), "Reminder"]);
  }

  it("cut by Telegram's limit: the leader is cancelled (not touched), the first listed row carries the push", async () => {
    // The reviewer's repro: one low task 14 days overdue + 5 normal tasks 1 day overdue, 290×"&".
    const low = await task("Low and old", "2026-10-19", { priority: "low" });
    for (let i = 0; i < 5; i++) await task(`${i} ${"&".repeat(290)}`, "2026-11-01");
    await setStyle("grouped");
    const { sent, registry } = recorder();
    await dispatchWithLeader(low!.id, registry);
    const push = nuraalyPushes(sent)[0]!;
    expect(push.message.title).toBe("6 tasks need a new deadline");
    const listedLines = push.message.lines.filter((l) => /^\d+\. /.test(l.text));
    expect(JSON.stringify(push.message.lines)).not.toContain("Low and old");
    await expectLeaderUntouched(low!.id, listedLines.length, registry, sent);
  });

  it("past the 10-task cap: the leader is cancelled (not touched), the first listed row carries the push", async () => {
    const low = await task("Low and old", "2026-10-19", { priority: "low" });
    for (let i = 0; i < MAX_GROUPED_CHASE_TASKS; i++) await task(`Short ${i}`, "2026-11-01");
    await setStyle("grouped");
    const { sent, registry } = recorder();
    await dispatchWithLeader(low!.id, registry);
    const push = nuraalyPushes(sent)[0]!;
    expect(push.message.title).toBe(`${MAX_GROUPED_CHASE_TASKS + 1} tasks need a new deadline`);
    expect(push.message.lines.some((l) => l.text === "+1 more — open the app")).toBe(true);
    expect(JSON.stringify(push.message.lines)).not.toContain("Low and old");
    await expectLeaderUntouched(low!.id, MAX_GROUPED_CHASE_TASKS, registry, sent);
  });
});

describe("grouped: at most one grouped push per founder per day", () => {
  it("a chase row claimed after today's grouped push is parked for the next summary", async () => {
    await overdueSet();
    await setStyle("grouped");
    const { sent, registry } = recorder();
    await runTimes(["08:30", "10:00"], registry);
    expect(nuraalyPushes(sent)).toHaveLength(1);
    // A later chase row the same day (e.g. a run that claimed it on its own).
    const late = await task("Late chase", "2026-11-01");
    await enqueue(t.handle.db, { userId: t.userIds.nuraaly, kind: "overdue_chase", taskId: late!.id, dedupeKey: `late:${late!.id}`, scheduledFor: nov2("10:00") });
    await dispatch(t.handle.db, nov2("10:30"), { registry });
    expect(nuraalyPushes(sent)).toHaveLength(1);
    const row = (await outboxFor(t.userIds.nuraaly)).find((r) => r.taskId === late!.id && r.kind === "overdue_chase")!;
    expect(row.status).toBe("parked");
    expect(row.lastError).toBe("grouped_already_sent");
    // Next morning's summary lists it as a parked line.
    await dispatchSummaryNextDay(registry);
    const summary = sent.filter((x) => x.userId === t.userIds.nuraaly && x.message.title.startsWith("Good morning")).at(-1)!;
    expect(JSON.stringify(summary.message.lines)).toContain("Late chase");
  });

  it("another run mid-send (its leader marked for today): this run's chase rows are parked, nothing sent", async () => {
    const [a] = await overdueSet();
    await setStyle("grouped");
    await planTick(t.handle.db, nov2("10:00"));
    // Simulate run 1: it claimed A's row and marked it as today's grouped leader.
    await t.handle.db
      .update(notificationsOutbox)
      .set({ status: "sending", claimedAt: new Date(), payload: { groupedChaseDay: "2026-11-02" } })
      .where(and(eq(notificationsOutbox.taskId, a!.id), eq(notificationsOutbox.kind, "overdue_chase")));
    const { sent, registry } = recorder();
    const report = await dispatch(t.handle.db, nov2("10:00"), { registry, userIds: [t.userIds.nuraaly] });
    expect(report.parked).toBe(3);
    expect(nuraalyPushes(sent)).toHaveLength(0);
    const rows = (await outboxFor(t.userIds.nuraaly)).filter((r) => r.kind === "overdue_chase" && r.taskId !== a!.id);
    expect(rows.every((r) => r.status === "parked" && r.lastError === "grouped_already_sent")).toBe(true);
  });

  it("two overlapping dispatch runs send ONE grouped push", async () => {
    await overdueSet();
    await setStyle("grouped");
    await planTick(t.handle.db, nov2("10:00"));
    const { sent, registry } = recorder();
    await Promise.all([dispatch(t.handle.db, nov2("10:00"), { registry }), dispatch(t.handle.db, nov2("10:00"), { registry })]);
    expect(nuraalyPushes(sent)).toHaveLength(1);
    const rows = (await outboxFor(t.userIds.nuraaly)).filter((r) => r.kind === "overdue_chase");
    expect(rows).toHaveLength(4);
    // Every task is either in the one push (sent) or parked for the next summary; none twice.
    expect(rows.every((r) => r.status === "sent" || (r.status === "parked" && r.lastError === "grouped_already_sent"))).toBe(true);
    const listed = (nuraalyPushes(sent)[0]!.message.lines.filter((l) => /^\d+\. /.test(l.text))).length;
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(listed);
  });
});

describe("summary_only", () => {
  it("queues no chase pushes; overdue tasks are in the morning summary; urgent items still push", async () => {
    const [a, , , , other] = await overdueSet();
    await setStyle("summary_only");
    // A chase queued before the switch is cancelled at send time.
    await enqueue(t.handle.db, {
      userId: t.userIds.nuraaly,
      kind: "overdue_chase",
      taskId: a!.id,
      dedupeKey: "chase:legacy",
      scheduledFor: nov2("09:00"),
    });
    await enqueue(t.handle.db, { userId: t.userIds.nuraaly, kind: "urgent", taskId: other!.id, dedupeKey: "urgent:1", scheduledFor: nov2("10:00"), priority: "urgent" });
    const { sent, registry } = recorder();
    await runTimes(["08:30", "09:00", "10:00", "10:30"], registry);
    const summary = sent.find((s) => s.userId === t.userIds.nuraaly && s.message.title.startsWith("Good morning"))!;
    expect(JSON.stringify(summary.message.lines)).toContain("Chase D (14 days)");
    expect(nuraalyPushes(sent).map((p) => p.message.title)).toEqual(["Urgent"]);
    const rows = await t.handle.db
      .select()
      .from(notificationsOutbox)
      .where(and(eq(notificationsOutbox.userId, t.userIds.nuraaly), eq(notificationsOutbox.kind, "overdue_chase")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("cancelled");
    expect(rows[0]!.lastError).toBe("chase_summary_only");
  });
});
