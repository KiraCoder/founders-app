import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { mintActionTokens } from "@/server/notifications/action-tokens";
import type { ChannelRegistry } from "@/server/notifications/channels";
import { DevChannel } from "@/server/notifications/channels";
import { BACKOFF_MINUTES, dispatch, MAX_ATTEMPTS } from "@/server/notifications/dispatcher";
import { consumeLinkCode, createLinkCode } from "@/server/notifications/linking";
import { enqueue } from "@/server/notifications/outbox";
import { planTick } from "@/server/notifications/planner";
import { handleTelegramUpdate } from "@/server/notifications/telegram-bot";
import type { TelegramUpdate } from "@/server/notifications/telegram-api";
import type { NeutralMessage, NotificationChannel } from "@/server/notifications/types";
import { updateMyPreferences } from "@/server/services/notifications";
import { createTask, getTask, listTaskEvents } from "@/server/services/tasks";
import { createTestDb, FIXED_NOW, type TestDb } from "../helpers/db";

const at = (utc: string) => new Date(utc);
/** 19:00 Bishkek on the fixed day. */
const EVENING = at("2026-11-02T13:00:00Z");
/** 22:00 Bishkek. */
const NIGHT = at("2026-11-02T16:00:00Z");

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
  delete process.env.TELEGRAM_BOT_TOKEN;
});

/** Records every message instead of sending it. */
function recordingRegistry(fail?: () => string | null) {
  const sent: { userId: string; message: NeutralMessage }[] = [];
  const channel: NotificationChannel = {
    name: "dev",
    async send(recipient, message) {
      const err = fail?.();
      if (err) return { ok: false, error: err };
      sent.push({ userId: recipient.userId, message });
      return { ok: true, providerMessageId: "rec" };
    },
  };
  const registry: ChannelRegistry = { get: () => channel, resolve: () => channel };
  return { sent, registry };
}

async function outbox(userId?: string): Promise<OutboxItem[]> {
  const q = t.handle.db.select().from(notificationsOutbox);
  return userId ? q.where(eq(notificationsOutbox.userId, userId)) : q;
}

const text = (m: unknown) => JSON.stringify(m);

async function overdueTask(who: "nuraaly" | "talant", title: string, dueDate = "2026-11-01", extra = {}) {
  return createTask(t.ctx(who), { title, companyId: t.companyIds["kiwi-go"], dueDate, ...extra });
}

describe("daily budget (anti-spam)", () => {
  it("parks overflow instead of sending it and lists it in the next summary", async () => {
    const db = t.handle.db;
    for (let i = 1; i <= 5; i++) await overdueTask("nuraaly", `Late ${i}`);
    await planTick(db, FIXED_NOW);
    const { sent, registry } = recordingRegistry();
    const report = await dispatch(db, FIXED_NOW, { registry });

    const mine = await outbox(t.userIds.nuraaly);
    const chases = mine.filter((i) => i.kind === "overdue_chase");
    expect(chases).toHaveLength(5);
    expect(chases.filter((c) => c.status === "sent")).toHaveLength(3);
    const parked = chases.filter((c) => c.status === "parked");
    expect(parked).toHaveLength(2);
    expect(report.parked).toBeGreaterThanOrEqual(2);
    // Morning summary has its own slot and was sent too.
    expect(mine.find((i) => i.kind === "morning_summary")?.status).toBe("sent");
    expect(sent.filter((s) => s.userId === t.userIds.nuraaly)).toHaveLength(4);

    // Evening: the parked items appear in the evening check, and are marked as bundled.
    const { sent: evening, registry: r2 } = recordingRegistry();
    await dispatch(db, EVENING, { registry: r2 });
    const check = evening.find((s) => s.userId === t.userIds.nuraaly && s.message.title === "Evening check");
    expect(check).toBeDefined();
    expect(text(check!.message)).toContain("Parked reminders (2)");
    const after = await outbox(t.userIds.nuraaly);
    const checkRow = after.find((i) => i.kind === "evening_check")!;
    expect(after.filter((i) => i.bundledIntoId === checkRow.id)).toHaveLength(2);
  });

  it("respects a custom budget of 0 extra pushes", async () => {
    await updateMyPreferences(t.ctx("talant"), {
      morningSummaryTime: "08:30",
      eveningCheckEnabled: false,
      eveningCheckTime: "19:00",
      quietStart: "21:00",
      quietEnd: "08:00",
      maxOtherPerDay: 0,
      urgentAtNight: false,
    });
    await overdueTask("talant", "T late");
    await planTick(t.handle.db, FIXED_NOW);
    const { registry } = recordingRegistry();
    await dispatch(t.handle.db, FIXED_NOW, { registry });
    const rows = await outbox(t.userIds.talant);
    expect(rows.find((r) => r.kind === "overdue_chase")?.status).toBe("parked");
    expect(rows.find((r) => r.kind === "evening_check")).toBeUndefined();
  });
});

describe("quiet hours", () => {
  it("holds items until quiet hours end, urgent ones too unless 'urgent at night' is on", async () => {
    const db = t.handle.db;
    const task = await overdueTask("nuraaly", "Night task", "2026-11-02");
    await enqueue(db, { userId: t.userIds.nuraaly, kind: "task_reminder", taskId: task.id, scheduledFor: NIGHT, dedupeKey: "n1" });
    await enqueue(db, {
      userId: t.userIds.nuraaly,
      kind: "urgent",
      taskId: task.id,
      scheduledFor: NIGHT,
      dedupeKey: "n2",
      priority: "urgent",
    });
    const { sent, registry } = recordingRegistry();
    const report = await dispatch(db, NIGHT, { registry });
    expect(report.held).toBe(2);
    expect(sent).toHaveLength(0);
    const rows = await outbox(t.userIds.nuraaly);
    for (const r of rows) {
      expect(r.status).toBe("pending");
      expect(r.nextAttemptAt?.toISOString()).toBe("2026-11-03T02:00:00.000Z"); // 08:00 next day
    }
    // Still held a little later the same night.
    expect((await dispatch(db, at("2026-11-02T17:00:00Z"), { registry })).held).toBe(0);
    expect(sent).toHaveLength(0);

    // Enable "urgent at night": the urgent item goes once due again, the normal one keeps waiting.
    await updateMyPreferences(t.ctx("nuraaly"), {
      morningSummaryTime: "08:30",
      eveningCheckEnabled: true,
      eveningCheckTime: "19:00",
      quietStart: "21:00",
      quietEnd: "08:00",
      maxOtherPerDay: 3,
      urgentAtNight: true,
    });
    await db.update(notificationsOutbox).set({ nextAttemptAt: null });
    const r2 = await dispatch(db, NIGHT, { registry });
    expect(r2.sent).toBe(1);
    expect(sent[0]!.message.title).toBe("Urgent");
    expect((await outbox(t.userIds.nuraaly)).find((r) => r.dedupeKey === "n1")?.status).toBe("pending");

    // After quiet hours the normal item is sent.
    const morning = at("2026-11-03T02:05:00Z");
    expect((await dispatch(db, morning, { registry })).sent).toBe(1);
  });
});

describe("dedupe", () => {
  it("never queues the same item twice for a user", async () => {
    const db = t.handle.db;
    await overdueTask("nuraaly", "Dup");
    const first = await planTick(db, FIXED_NOW);
    const second = await planTick(db, at("2026-11-02T06:10:00Z"));
    expect(first.created).toBeGreaterThan(0);
    expect(second.created).toBe(0);
    const again = await enqueue(db, {
      userId: t.userIds.nuraaly,
      kind: "morning_summary",
      scheduledFor: FIXED_NOW,
      dedupeKey: "morning:2026-11-02",
    });
    expect(again.created).toBe(false);
    // Same key for the other founder is a different item.
    const other = await enqueue(db, { userId: t.userIds.talant, kind: "task_reminder", scheduledFor: FIXED_NOW, dedupeKey: "x" });
    const mine = await enqueue(db, { userId: t.userIds.nuraaly, kind: "task_reminder", scheduledFor: FIXED_NOW, dedupeKey: "x" });
    expect(other.created && mine.created).toBe(true);
  });

  it("refuses recipients that are not founders (people never get messages)", async () => {
    await expect(
      enqueue(t.handle.db, {
        userId: t.personIds.edil!,
        kind: "task_reminder",
        scheduledFor: FIXED_NOW,
        dedupeKey: "edil",
      }),
    ).rejects.toThrow(/founders/);
  });
});

describe("overdue chase cadence over days", () => {
  it("chases on day 1, 3, 7 and 14 only, once per day", async () => {
    const db = t.handle.db;
    const task = await overdueTask("nuraaly", "Cadence", "2026-11-01");
    const chaseDays: string[] = [];
    for (let d = 2; d <= 16; d++) {
      const day = `2026-11-${String(d).padStart(2, "0")}`;
      for (const hour of ["03", "06", "11"]) await planTick(db, at(`${day}T${hour}:00:00Z`));
    }
    const rows = (await outbox(t.userIds.nuraaly)).filter((r) => r.kind === "overdue_chase" && r.taskId === task.id);
    for (const r of rows) chaseDays.push(r.dedupeKey!.split(":")[2]!);
    expect(chaseDays.sort()).toEqual(["2026-11-02", "2026-11-04", "2026-11-08", "2026-11-15"]);
  });
});

describe("privacy between founders", () => {
  it("Talant's morning summary never includes Nuraaly's private todos, and vice versa", async () => {
    const db = t.handle.db;
    await createTask(t.ctx("nuraaly"), { title: "N-secret todo", visibility: "private", dueDate: "2026-11-02" });
    await createTask(t.ctx("nuraaly"), { title: "N-secret overdue", visibility: "private", dueDate: "2026-11-01" });
    await createTask(t.ctx("talant"), { title: "T-secret todo", visibility: "private", dueDate: "2026-11-02" });
    await createTask(t.ctx("talant"), { title: "T-secret undated", visibility: "private" });
    await planTick(db, FIXED_NOW);
    const { sent, registry } = recordingRegistry();
    await dispatch(db, FIXED_NOW, { registry });

    const summaryOf = (userId: string) =>
      text(sent.find((s) => s.userId === userId && s.message.title.startsWith("Good morning"))!.message);
    const n = summaryOf(t.userIds.nuraaly);
    const tal = summaryOf(t.userIds.talant);
    expect(n).toContain("N-secret todo");
    expect(n).toContain("N-secret overdue");
    expect(n).not.toContain("T-secret");
    expect(tal).toContain("T-secret todo");
    expect(tal).toContain("T-secret undated");
    expect(tal).not.toContain("N-secret");
    // No push of any kind to Talant mentions Nuraaly's private tasks.
    expect(text(sent.filter((s) => s.userId === t.userIds.talant))).not.toContain("N-secret");
  });

  it("a queued item pointing at the other founder's private task is cancelled, not sent", async () => {
    const db = t.handle.db;
    const secret = await createTask(t.ctx("talant"), { title: "T private", visibility: "private", dueDate: "2026-11-02" });
    await enqueue(db, {
      userId: t.userIds.nuraaly,
      kind: "task_due_today",
      taskId: secret.id,
      scheduledFor: FIXED_NOW,
      dedupeKey: "forged",
    });
    const { sent, registry } = recordingRegistry();
    await dispatch(db, FIXED_NOW, { registry });
    expect(text(sent)).not.toContain("T private");
    expect((await outbox(t.userIds.nuraaly)).find((r) => r.dedupeKey === "forged")).toMatchObject({
      status: "cancelled",
      lastError: "task_gone",
    });
  });
});

describe("channel selection", () => {
  it("sends to Telegram only for linked founders; with a token, unlinked ones are held until they link", async () => {
    const db = t.handle.db;
    process.env.TELEGRAM_BOT_TOKEN = "123456:TEST-TOKEN";
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }));
    });
    const { code } = await createLinkCode(db, t.userIds.nuraaly, FIXED_NOW);
    expect((await consumeLinkCode(db, code, { chatId: "1001", telegramUserId: "1001" }, FIXED_NOW)).ok).toBe(true);

    await planTick(db, FIXED_NOW);
    await dispatch(db, FIXED_NOW);

    const nMorning = (await outbox(t.userIds.nuraaly)).find((r) => r.kind === "morning_summary")!;
    const tMorning = (await outbox(t.userIds.talant)).find((r) => r.kind === "morning_summary")!;
    expect(nMorning).toMatchObject({ status: "sent", channel: "telegram", providerMessageId: "42" });
    // Talant has no chat: nothing is "delivered" to the dev inbox, nothing counts as sent.
    expect(tMorning).toMatchObject({ status: "not_linked", sentAt: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/bot123456:TEST-TOKEN\/sendMessage$/);
    expect(calls[0]!.body).toMatchObject({ chat_id: "1001", parse_mode: "HTML" });
    expect(String(calls[0]!.body.text)).toContain("Good morning, Nuraaly");

    // Talant links later the same morning: the held summary is still valid and flows.
    const tc = await createLinkCode(db, t.userIds.talant, FIXED_NOW);
    await consumeLinkCode(db, tc.code, { chatId: "2002", telegramUserId: "2002" }, FIXED_NOW);
    await dispatch(db, at("2026-11-02T06:10:00Z"));
    expect((await outbox(t.userIds.talant)).find((r) => r.kind === "morning_summary")).toMatchObject({
      status: "sent",
      channel: "telegram",
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toMatchObject({ chat_id: "2002" });
  });

  it("uses the dev channel automatically when no token is set", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("must not call the network");
    });
    const { code } = await createLinkCode(t.handle.db, t.userIds.nuraaly, FIXED_NOW);
    await consumeLinkCode(t.handle.db, code, { chatId: "1001", telegramUserId: "1001" }, FIXED_NOW);
    await planTick(t.handle.db, FIXED_NOW);
    await dispatch(t.handle.db, FIXED_NOW);
    const rows = (await outbox()).filter((r) => r.status === "sent");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.channel === "dev")).toBe(true);
  });
});

describe("retries", () => {
  it("retries channel errors with backoff, then gives up after max attempts", async () => {
    const db = t.handle.db;
    const task = await overdueTask("nuraaly", "Flaky", "2026-11-02");
    await enqueue(db, { userId: t.userIds.nuraaly, kind: "task_reminder", taskId: task.id, scheduledFor: FIXED_NOW, dedupeKey: "flaky" });
    const { registry } = recordingRegistry(() => "boom");
    let now = FIXED_NOW;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const r = await dispatch(db, now, { registry });
      const [row] = await db.select().from(notificationsOutbox).where(eq(notificationsOutbox.dedupeKey, "flaky"));
      expect(row!.attempts).toBe(attempt);
      if (attempt < MAX_ATTEMPTS) {
        expect(r.retrying).toBe(1);
        expect(row!.status).toBe("pending");
        const wait = BACKOFF_MINUTES[attempt - 1]! * 60_000;
        expect(row!.nextAttemptAt!.getTime() - now.getTime()).toBe(wait);
        // Not retried before the backoff.
        expect((await dispatch(db, new Date(now.getTime() + wait - 1000), { registry })).retrying).toBe(0);
        now = new Date(now.getTime() + wait);
      } else {
        expect(row).toMatchObject({ status: "failed", lastError: "boom" });
      }
    }
  });
});

describe("Telegram linking", () => {
  const chat = { chatId: "5005", telegramUserId: "5005", username: "nur" };

  it("codes expire after 15 minutes and work only once", async () => {
    const db = t.handle.db;
    const { code } = await createLinkCode(db, t.userIds.nuraaly, FIXED_NOW);
    expect(await consumeLinkCode(db, code, chat, new Date(FIXED_NOW.getTime() + 16 * 60_000))).toEqual({
      ok: false,
      reason: "invalid",
    });

    const fresh = await createLinkCode(db, t.userIds.nuraaly, FIXED_NOW);
    const ok = await consumeLinkCode(db, fresh.code.toLowerCase().replace("-", " "), chat, FIXED_NOW);
    expect(ok).toMatchObject({ ok: true, userId: t.userIds.nuraaly });
    expect((await consumeLinkCode(db, fresh.code, { ...chat, chatId: "6006" }, FIXED_NOW)).ok).toBe(false);

    // Only a hash is stored.
    const rows = await db.select().from(telegramLinkCodes);
    expect(text(rows)).not.toContain(fresh.code);
  });

  it("a new code invalidates the previous one", async () => {
    const db = t.handle.db;
    const first = await createLinkCode(db, t.userIds.talant, FIXED_NOW);
    await createLinkCode(db, t.userIds.talant, FIXED_NOW);
    expect((await consumeLinkCode(db, first.code, chat, FIXED_NOW)).ok).toBe(false);
  });

  it("/start CODE links the chat; unlinked chats only get a polite reply", async () => {
    const db = t.handle.db;
    const msg = (text: string, chatId = 777): TelegramUpdate => ({
      update_id: 1,
      message: { message_id: 1, chat: { id: chatId, type: "private" }, from: { id: chatId, first_name: "X" }, text },
    });
    const notLinked = await handleTelegramUpdate(db, msg("/today"), FIXED_NOW);
    expect(notLinked).toHaveLength(1);
    expect(String(notLinked[0]!.params.text)).toContain("not linked");

    const { code } = await createLinkCode(db, t.userIds.talant, FIXED_NOW);
    const linked = await handleTelegramUpdate(db, msg(`/start ${code}`), FIXED_NOW);
    expect(String(linked[0]!.params.text)).toContain("Linked to Talant");

    await createTask(t.ctx("talant"), { title: "T today <b>", visibility: "private", dueDate: "2026-11-02" });
    await createTask(t.ctx("nuraaly"), { title: "N hidden", visibility: "private", dueDate: "2026-11-02" });
    const today = await handleTelegramUpdate(db, msg("/today"), FIXED_NOW);
    expect(String(today[0]!.params.text)).toContain("T today &lt;b&gt;");
    expect(String(today[0]!.params.text)).not.toContain("N hidden");
    const tasksReply = await handleTelegramUpdate(db, msg("/tasks"), FIXED_NOW);
    expect(String(tasksReply[0]!.params.text)).toContain("Your open tasks");

    // Another chat sending a used code gets nothing linked.
    const reuse = await handleTelegramUpdate(db, msg(`/start ${code}`, 888), FIXED_NOW);
    expect(String(reuse[0]!.params.text)).toContain("Code not accepted");
    expect(await db.select().from(telegramLinks)).toHaveLength(1);
  });
});

describe("Telegram buttons", () => {
  async function linkChat(who: "nuraaly" | "talant", chatId: number) {
    const { code } = await createLinkCode(t.handle.db, t.userIds[who], FIXED_NOW);
    await consumeLinkCode(t.handle.db, code, { chatId: String(chatId), telegramUserId: String(chatId) }, FIXED_NOW);
  }
  const press = (chatId: number, data: string): TelegramUpdate => ({
    update_id: 2,
    callback_query: {
      id: "cb1",
      from: { id: chatId },
      data,
      message: { message_id: 10, chat: { id: chatId, type: "private" }, text: "Overdue 1 day\nTask" },
    },
  });

  it("Done and Move deadline act through the tasks service (audited)", async () => {
    const db = t.handle.db;
    await linkChat("nuraaly", 111);
    const task = await overdueTask("nuraaly", "Button task", "2026-11-01");
    const cb = await mintActionTokens(db, {
      userId: t.userIds.nuraaly,
      outboxId: null,
      now: FIXED_NOW,
      actions: [
        { action: "move_3d", taskId: task.id, label: "+3" },
        { action: "done", taskId: task.id, label: "Done" },
      ],
    });
    const move = await handleTelegramUpdate(db, press(111, cb[`move_3d:${task.id}`]!), FIXED_NOW);
    expect(move[0]!.params.text).toContain("Deadline moved");
    expect(move[1]!.method).toBe("editMessageText");
    expect((await getTask(t.ctx("nuraaly"), task.id)).dueDate).toBe("2026-11-05"); // from today, not from the old date
    const events = await listTaskEvents(t.ctx("nuraaly"), task.id);
    expect(events.find((e) => e.kind === "deadline_changed")).toMatchObject({
      oldValue: "2026-11-01",
      newValue: "2026-11-05",
      actorUserId: t.userIds.nuraaly,
    });

    await handleTelegramUpdate(db, press(111, cb[`done:${task.id}`]!), FIXED_NOW);
    expect((await getTask(t.ctx("nuraaly"), task.id)).status).toBe("done");

    // Replaying a used button does nothing.
    const replay = await handleTelegramUpdate(db, press(111, cb[`done:${task.id}`]!), FIXED_NOW);
    expect(replay).toHaveLength(1);
    expect(replay[0]!.params.text).toMatch(/expired|already used/);
  });

  it("Snooze 1 day moves only the reminder, not the deadline", async () => {
    const db = t.handle.db;
    await linkChat("nuraaly", 111);
    const task = await overdueTask("nuraaly", "Snooze me", "2026-11-01");
    await planTick(db, FIXED_NOW);
    const cb = await mintActionTokens(db, {
      userId: t.userIds.nuraaly,
      outboxId: null,
      now: FIXED_NOW,
      actions: [{ action: "snooze_1d", taskId: task.id, label: "Snooze" }],
    });
    await handleTelegramUpdate(db, press(111, cb[`snooze_1d:${task.id}`]!), FIXED_NOW);
    expect((await getTask(t.ctx("nuraaly"), task.id)).dueDate).toBe("2026-11-01");
    const rows = (await outbox(t.userIds.nuraaly)).filter((r) => r.taskId === task.id);
    expect(rows.find((r) => r.kind === "overdue_chase")?.status).toBe("cancelled");
    const reminder = rows.find((r) => r.kind === "task_reminder")!;
    expect(reminder.scheduledFor.toISOString()).toBe("2026-11-03T06:00:00.000Z");
    const [snooze] = await db.select().from(reminderSnoozes).where(and(eq(reminderSnoozes.taskId, task.id)));
    expect(snooze).toBeDefined();
  });

  it("a forged callback for the other founder's private task does nothing", async () => {
    const db = t.handle.db;
    await linkChat("nuraaly", 111);
    await linkChat("talant", 222);
    const secret = await createTask(t.ctx("talant"), { title: "T private", visibility: "private", dueDate: "2026-11-01" });
    // A real token, but minted for Talant.
    const talantCb = await mintActionTokens(db, {
      userId: t.userIds.talant,
      outboxId: null,
      now: FIXED_NOW,
      actions: [{ action: "done", taskId: secret.id, label: "Done" }],
    });
    // A token for Nuraaly that (somehow) points at Talant's private task.
    const forgedCb = await mintActionTokens(db, {
      userId: t.userIds.nuraaly,
      outboxId: null,
      now: FIXED_NOW,
      actions: [{ action: "done", taskId: secret.id, label: "Done" }],
    });

    for (const data of [talantCb[`done:${secret.id}`]!, `a:${secret.id}`, `done:${secret.id}`, forgedCb[`done:${secret.id}`]!]) {
      const res = await handleTelegramUpdate(db, press(111, data), FIXED_NOW);
      expect(res).toHaveLength(1);
      expect(res[0]!.method).toBe("answerCallbackQuery");
    }
    // A chat pretending to be Nuraaly's but sent by a different Telegram user.
    const spoof = press(111, talantCb[`done:${secret.id}`]!);
    spoof.callback_query!.from.id = 999;
    expect((await handleTelegramUpdate(db, spoof, FIXED_NOW))[0]!.params.text).toContain("not linked");

    const still = await getTask(t.ctx("talant"), secret.id);
    expect(still.status).toBe("todo");
    expect((await listTaskEvents(t.ctx("talant"), secret.id)).map((e) => e.kind)).toEqual(["created"]);
    // Talant's real token still works for Talant (it was never consumed by the forgery).
    await handleTelegramUpdate(db, press(222, talantCb[`done:${secret.id}`]!), FIXED_NOW);
    expect((await getTask(t.ctx("talant"), secret.id)).status).toBe("done");
  });
});

describe("dev channel", () => {
  it("delivers without leaving the server", async () => {
    expect((await new DevChannel().send({ userId: t.userIds.nuraaly })).ok).toBe(true);
  });
});
