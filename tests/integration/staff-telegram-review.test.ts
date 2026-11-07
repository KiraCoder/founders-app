/**
 * Fixes from the independent review of staff on Telegram (docs/reviews/staff-telegram-review.md),
 * items A–H. In-memory PGlite, no real Telegram.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
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
} from "@/server/db/schema";
import type { ChannelRegistry } from "@/server/notifications/channels";
import { dispatch } from "@/server/notifications/dispatcher";
import { planTick } from "@/server/notifications/planner";
import { handleTelegramUpdate } from "@/server/notifications/telegram-bot";
import type { TelegramUpdate } from "@/server/notifications/telegram-api";
import { runStaffDevTick, runTick } from "@/server/notifications/tick";
import { actionKey, type ActionCallbacks, type NeutralMessage, type NotificationChannel } from "@/server/notifications/types";
import { applyTaskAction } from "@/server/services/notifications";
import { createPersonInvite, setPersonBotEnabled, updateStaffDefaults } from "@/server/services/staff";
import { personContext, personHelp, personRequestDeadline } from "@/server/services/staff-tasks";
import { decideDeadlineRequest } from "@/server/services/task-comments";
import { createTask, getTask } from "@/server/services/tasks";
import { DEFAULT_STAFF_SETTINGS } from "@/lib/staff-schemas";
import { createTestDb, type TestDb } from "../helpers/db";

const local = (day: string, hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), h! - 6, m!));
};
const D = "2026-11-02";
const TZ = "Asia/Bishkek";
const EDIL_CHAT = 6_000_001;

let t: TestDb;
let edil: string;

beforeAll(async () => {
  t = await createTestDb();
  edil = t.personIds.edil!;
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
  const registry: ChannelRegistry = { get: () => channel, resolve: (r) => (!r.personId || r.telegramChatId ? channel : null) };
  return { sent, registry };
}
const msgUpdate = (chatId: number, text: string): TelegramUpdate => ({
  update_id: Math.floor(Math.random() * 1e9),
  message: { message_id: 1, chat: { id: chatId, type: "private" }, from: { id: chatId, first_name: "X" }, text },
});
const press = (chatId: number, data: string): TelegramUpdate => ({
  update_id: Math.floor(Math.random() * 1e9),
  callback_query: { id: "cq", from: { id: chatId }, data, message: { message_id: 77, chat: { id: chatId, type: "private" }, text: "msg" } },
});

async function onTelegram(at: Date) {
  const invite = await createPersonInvite(t.ctx("nuraaly", at), edil);
  await handleTelegramUpdate(t.handle.db, msgUpdate(EDIL_CHAT, `/start ${invite.code}`), at);
  await setPersonBotEnabled(t.ctx("nuraaly", at), edil, true);
}
const edilTask = (title: string, dueDate: string | null, at: Date) =>
  createTask(t.ctx("nuraaly", at), {
    title,
    visibility: "shared",
    companyId: t.companyIds.jobutify,
    assigneePersonId: edil,
    status: "todo",
    priority: "normal",
    dueDate,
  });
async function tick(at: Date, reg = recorder()) {
  await planTick(t.handle.db, at, { timeZone: TZ });
  await dispatch(t.handle.db, at, { registry: reg.registry, timeZone: TZ });
  return reg;
}
const toEdil = (r: { sent: Sent[] }) => r.sent.filter((s) => s.personId === edil);
const staffUpdates = () =>
  t.handle.db
    .select()
    .from(notificationsOutbox)
    .where(and(eq(notificationsOutbox.userId, t.userIds.nuraaly), eq(notificationsOutbox.kind, "staff_update")));
const pctx = (at: Date) => personContext(t.handle.db, { id: edil, fullName: "Edil", shortName: null }, at, TZ);

describe("A. grouped staff chase", () => {
  it("8 overdue tasks → 1 message per slot with buttons per task, and chasing goes on all day", async () => {
    await updateStaffDefaults(t.ctx("nuraaly"), { ...DEFAULT_STAFF_SETTINGS, escalateAfterChases: 0 });
    await onTelegram(local("2026-11-01", "10:00"));
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push((await edilTask(`Overdue ${i + 1}`, "2026-10-30", local("2026-11-01", "10:00"))).id);
    await tick(local("2026-11-01", "10:05")); // the 8 new-task messages, yesterday
    for (const hm of ["09:00", "11:00", "13:00", "15:00", "17:00", "19:00"]) {
      const r = toEdil(await tick(local(D, hm)));
      expect(r, `slot ${hm}`).toHaveLength(1);
      expect(r[0]!.message.title).toContain("8 задач");
      expect(r[0]!.message.actions).toHaveLength(24);
      expect(Object.keys(r[0]!.callbacks)).toHaveLength(24);
      // Same slot again: nothing.
      expect(toEdil(await tick(local(D, hm.replace(":00", ":40"))))).toHaveLength(0);
    }
    const rows = await t.handle.db
      .select()
      .from(notificationsOutbox)
      .where(and(eq(notificationsOutbox.personId, edil), eq(notificationsOutbox.kind, "staff_chase")));
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(6);
    expect(rows.some((r) => r.lastError === "daily_cap_full")).toBe(false);
    // A per-task button of the grouped message works: "3 · Готово" closes task 3 only.
    const last = toEdil(await tick(local("2026-11-03", "09:00")))[0]!;
    const third = last.message.actions!.find((a) => a.label === "3 · Готово")!;
    await handleTelegramUpdate(t.handle.db, press(EDIL_CHAT, last.callbacks[actionKey(third)]!), local("2026-11-03", "09:05"));
    expect((await getTask(t.ctx("nuraaly"), third.taskId!)).status).toBe("done");
    const next = toEdil(await tick(local("2026-11-03", "11:00")))[0]!;
    expect(next.message.title).toContain("7 задач");
  });

  it("no burst on switch-on: no chase in the slot the person was switched on; one grouped chase in the next", async () => {
    for (let i = 0; i < 8; i++) await edilTask(`Old ${i + 1}`, "2026-10-25", local("2026-10-20", "10:00"));
    // Assigned long ago (rows get the wall clock by default).
    await t.handle.db.update(tasks).set({ createdAt: local("2026-10-20", "10:00") });
    await t.handle.db.delete(taskEvents);
    await onTelegram(local(D, "09:05"));
    expect(toEdil(await tick(local(D, "09:10")))).toHaveLength(0);
    expect(toEdil(await tick(local(D, "10:30")))).toHaveLength(0);
    const r = toEdil(await tick(local(D, "11:00")));
    expect(r).toHaveLength(1);
    expect(r[0]!.message.title).toContain("8 задач");
  });

  it("a single due task keeps the single-task reminder, and a text reply to it becomes its comment", async () => {
    await onTelegram(local("2026-11-01", "10:00"));
    const task = await edilTask("Один акт", D, local("2026-11-01", "10:00"));
    await tick(local("2026-11-01", "10:05"));
    const r = toEdil(await tick(local(D, "09:00")));
    expect(r.map((s) => s.message.title)).toEqual(["Напоминание: Один акт"]);
    const [row] = await t.handle.db
      .select()
      .from(notificationsOutbox)
      .where(and(eq(notificationsOutbox.personId, edil), eq(notificationsOutbox.kind, "staff_chase")));
    expect(row!.taskId).toBe(task.id);
  });
});

describe("B. founder actions never cancel a staff_update", () => {
  it("Snooze / +1 day / Done by the founder keep a pending help push", async () => {
    await onTelegram(local(D, "08:30"));
    const task = await edilTask("Help task", D, local(D, "08:40"));
    await personHelp(pctx(local(D, "09:00")), task.id);
    const pending = () => staffUpdates().then((rows) => rows.filter((r) => r.status === "pending"));
    expect(await pending()).toHaveLength(1);
    await applyTaskAction(t.ctx("nuraaly", local(D, "09:01")), "snooze_1d", task.id);
    await applyTaskAction(t.ctx("nuraaly", local(D, "09:02")), "move_1d", task.id);
    expect(await pending()).toHaveLength(1);
    await personRequestDeadline(pctx(local(D, "09:03")), task.id, 3);
    await applyTaskAction(t.ctx("nuraaly", local(D, "09:04")), "done", task.id);
    expect(await pending()).toHaveLength(2);
  });
});

describe("C. dev tools", () => {
  it("the founders' dev tick never plans or sends staff messages", async () => {
    await onTelegram(local("2026-11-01", "10:00"));
    await edilTask("Due", D, local("2026-11-01", "10:00"));
    const reg = recorder();
    await runTick(t.handle.db, local(D, "09:00"), { registry: reg.registry, userIds: [t.userIds.nuraaly], staff: false });
    expect(toEdil(reg)).toHaveLength(0);
    const rows = await t.handle.db.select().from(notificationsOutbox).where(eq(notificationsOutbox.personId, edil));
    expect(rows).toHaveLength(0);
  });

  it("the staff dev tick is refused with a bot token, and otherwise sends only staff rows at the real time", async () => {
    await onTelegram(local("2026-11-01", "10:00"));
    await edilTask("Due", D, local("2026-11-01", "10:00"));
    const reg = recorder();
    await expect(runStaffDevTick(t.handle.db, local(D, "09:00"), { registry: reg.registry, telegramConfigured: true })).rejects.toThrow(
      /real tick only/,
    );
    expect(await t.handle.db.select().from(notificationsOutbox).where(eq(notificationsOutbox.personId, edil))).toHaveLength(0);
    // Founders' rows waiting are left alone.
    await planTick(t.handle.db, local(D, "09:00"), { timeZone: TZ, staff: false });
    await runStaffDevTick(t.handle.db, local(D, "09:00"), { registry: reg.registry, telegramConfigured: false });
    expect(reg.sent.length).toBeGreaterThan(0);
    expect(reg.sent.every((s) => s.personId === edil)).toBe(true);
  });
});

describe("D. deciding a deadline request", () => {
  it("founders only, and the status change + deadline move are one transaction", async () => {
    await onTelegram(local(D, "08:30"));
    const task = await edilTask("Move", "2026-11-05", local(D, "08:40"));
    await personRequestDeadline(pctx(local(D, "09:00")), task.id, 1);
    const [req] = await t.handle.db.select().from(taskDeadlineRequests);
    const staffCtx = { ...t.ctx("nuraaly"), user: { ...t.founders.nuraaly, role: "staff" as const } };
    await expect(decideDeadlineRequest(staffCtx, req!.id, true)).rejects.toThrow(/Only the founders/);

    // The deadline move fails → the request stays pending, the deadline unchanged.
    await t.handle.db.execute(sql`
      create or replace function e2e_fail_due() returns trigger language plpgsql as $$
      begin if new.due_date = '2030-01-01' then raise exception 'boom'; end if; return new; end $$`);
    await t.handle.db.execute(sql`create trigger e2e_fail_due before update on tasks for each row execute function e2e_fail_due()`);
    try {
      await t.handle.db.update(taskDeadlineRequests).set({ proposedDueDate: "2030-01-01" }).where(eq(taskDeadlineRequests.id, req!.id));
      await expect(decideDeadlineRequest(t.ctx("nuraaly", local(D, "10:00")), req!.id, true)).rejects.toThrow();
      const [after] = await t.handle.db.select().from(taskDeadlineRequests).where(eq(taskDeadlineRequests.id, req!.id));
      expect(after!.status).toBe("pending");
      expect((await getTask(t.ctx("nuraaly"), task.id)).dueDate).toBe("2026-11-05");
    } finally {
      await t.handle.db.execute(sql`drop trigger e2e_fail_due on tasks`);
    }
    const ok = await decideDeadlineRequest(t.ctx("nuraaly", local(D, "10:05")), req!.id, true);
    expect(ok.status).toBe("approved");
    expect((await getTask(t.ctx("nuraaly"), task.id)).dueDate).toBe("2030-01-01");
  });
});

describe("E. re-escalation after an answer", () => {
  it("going quiet again for N chases escalates again", async () => {
    await onTelegram(local("2026-11-01", "10:00"));
    const task = await edilTask("Ответить", D, local("2026-11-01", "10:00"));
    await tick(local("2026-11-01", "10:05"));
    for (const hm of ["09:00", "11:00", "13:00", "15:00"]) await tick(local(D, hm));
    const esc = async () => (await staffUpdates()).filter((r) => r.dedupeKey!.startsWith("esc:"));
    expect(await esc()).toHaveLength(1);
    // Edil answers by pressing Принято on the new-task message.
    const [tok] = await t.handle.db.select().from(notificationActionTokens).where(
      and(eq(notificationActionTokens.personId, edil), eq(notificationActionTokens.action, "staff_accept")),
    );
    void tok;
    const { mintActionTokens } = await import("@/server/notifications/action-tokens");
    const cbs = await mintActionTokens(t.handle.db, {
      personId: edil,
      outboxId: null,
      actions: [{ action: "staff_accept", taskId: task.id, label: "Принято" }],
      now: local(D, "15:10"),
    });
    await handleTelegramUpdate(t.handle.db, press(EDIL_CHAT, cbs[actionKey({ action: "staff_accept", taskId: task.id })]!), local(D, "15:10"));
    // Chased again: 17:00, 19:00, next day 09:00 → silent for 3 → escalated again at 11:00.
    for (const [day, hm] of [[D, "17:00"], [D, "19:00"], ["2026-11-03", "09:00"]] as const) {
      expect(toEdil(await tick(local(day, hm)))).toHaveLength(1);
    }
    expect(await esc()).toHaveLength(1);
    await tick(local("2026-11-03", "11:00"));
    expect(await esc()).toHaveLength(2);
  });
});

describe("F. a team update about a task is not the founder's push for it", () => {
  it("a sent help push does not cancel the founder's due-today nudge for that task", async () => {
    await saveSeparate();
    await onTelegram(local(D, "08:30"));
    const task = await edilTask("Nudge me", D, local(D, "08:40"));
    await personHelp(pctx(local(D, "10:00")), task.id);
    const r = await tick(local(D, "10:05"));
    expect(r.sent.some((s) => s.to === t.userIds.nuraaly && s.message.title === "Help needed")).toBe(true);
    const noon = await tick(local(D, "12:00"));
    const nudge = noon.sent.find((s) => s.to === t.userIds.nuraaly && JSON.stringify(s.message).includes("Nudge me"));
    expect(nudge).toBeDefined();
  });
});

describe("G. decided deadline requests leave the summary", () => {
  it("a parked deadline-request line is dropped once the request is decided", async () => {
    await onTelegram(local(D, "08:30"));
    const task = await edilTask("Parked move", "2026-11-05", local(D, "08:40"));
    await personRequestDeadline(pctx(local(D, "09:00")), task.id, 1);
    await t.handle.db
      .update(notificationsOutbox)
      .set({ status: "parked", parkedAt: local(D, "09:00"), lastError: "daily_budget_full" })
      .where(and(eq(notificationsOutbox.userId, t.userIds.nuraaly), eq(notificationsOutbox.kind, "staff_update")));
    const [req] = await t.handle.db.select().from(taskDeadlineRequests);
    await decideDeadlineRequest(t.ctx("nuraaly", local(D, "10:00")), req!.id, false);
    const r = await tick(local("2026-11-03", "08:30"));
    const summary = r.sent.find((s) => s.to === t.userIds.nuraaly && s.message.title.startsWith("Good morning"))!;
    expect(JSON.stringify(summary.message)).not.toContain("asks to move");
    const [row] = await staffUpdates();
    expect(row).toMatchObject({ status: "cancelled", lastError: "no_longer_relevant" });
  });
});

describe("H. /stop cancels everything waiting", () => {
  it("pending, held, not_linked and parked rows of the person are cancelled", async () => {
    await onTelegram(local(D, "08:30"));
    const task = await edilTask("Stop", D, local(D, "08:40"));
    const base = { personId: edil, kind: "staff_info", taskId: task.id, payload: { text: "x" }, scheduledFor: local(D, "09:00") };
    await t.handle.db.insert(notificationsOutbox).values([
      { ...base, dedupeKey: "h1", status: "pending" },
      { ...base, dedupeKey: "h2", status: "pending", nextAttemptAt: local("2026-11-03", "08:00"), lastError: "quiet_hours" },
      { ...base, dedupeKey: "h3", status: "not_linked" },
      { ...base, dedupeKey: "h4", status: "parked", parkedAt: local(D, "09:00") },
    ]);
    await handleTelegramUpdate(t.handle.db, msgUpdate(EDIL_CHAT, "/stop"), local(D, "09:30"));
    const rows = await t.handle.db.select().from(notificationsOutbox).where(eq(notificationsOutbox.personId, edil));
    expect(rows.filter((r) => r.dedupeKey!.startsWith("h")).map((r) => r.status)).toEqual(["cancelled", "cancelled", "cancelled", "cancelled"]);
  });
});

async function saveSeparate() {
  const { saveChaseStyle } = await import("../helpers/db");
  await saveChaseStyle(t.handle.db, [t.userIds.nuraaly, t.userIds.talant], "separate");
}
