/**
 * Routines review fixes: a parked founder routine line in the evening check (no invalid
 * timestamp), founder routine defaults (the ask + one reminder) that never starve task pushes, and
 * escalation of an open run whose person became unreachable mid-run (/stop).
 * In-memory PGlite, no real Telegram.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { DEFAULT_STAFF_SETTINGS } from "@/lib/staff-schemas";
import { FOUNDER_ROUTINE_CHASE } from "@/lib/routines";
import {
  notificationActionTokens,
  notificationPreferences,
  notificationsOutbox,
  people,
  routineRuns,
  routines,
  taskEvents,
  tasks,
  telegramLinkCodes,
  telegramLinks,
} from "@/server/db/schema";
import type { ChannelRegistry } from "@/server/notifications/channels";
import { dispatch } from "@/server/notifications/dispatcher";
import { enqueue } from "@/server/notifications/outbox";
import { planTick } from "@/server/notifications/planner";
import { handleTelegramUpdate } from "@/server/notifications/telegram-bot";
import type { TelegramUpdate } from "@/server/notifications/telegram-api";
import type { NeutralMessage, NotificationChannel } from "@/server/notifications/types";
import { updateMyPreferences } from "@/server/services/notifications";
import { createRoutine, listRoutines, runRoutineNow } from "@/server/services/routines";
import { createPersonInvite, setPersonBotEnabled, updateStaffDefaults } from "@/server/services/staff";
import { createTask } from "@/server/services/tasks";
import { createTestDb, type TestDb } from "../helpers/db";

const local = (day: string, hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), h! - 6, m!));
};
const MON = "2026-11-02";
const TUE = "2026-11-03";
const TZ = "Asia/Bishkek";
const ELMURAT_CHAT = 7_100_002;
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
let elmurat: string;

beforeAll(async () => {
  t = await createTestDb();
  elmurat = t.personIds.elmurat!;
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
  await db.delete(notificationPreferences);
  await db.delete(taskEvents);
  await db.delete(tasks);
  await db.update(people).set({ botEnabled: false, botEnabledAt: null, botPausedUntil: null, staffChase: null });
  await updateStaffDefaults(t.ctx("nuraaly"), { ...DEFAULT_STAFF_SETTINGS });
  for (const who of ["nuraaly", "talant"] as const) await updateMyPreferences(t.ctx(who), PREFS);
});

interface Sent {
  to: string;
  personId: string | null;
  message: NeutralMessage;
}
function recorder() {
  const sent: Sent[] = [];
  const channel: NotificationChannel = {
    name: "telegram",
    async send(recipient, message) {
      sent.push({ to: recipient.userId, personId: recipient.personId ?? null, message });
      return { ok: true, providerMessageId: String(sent.length) };
    },
  };
  const registry: ChannelRegistry = { get: () => channel, resolve: (r) => (!r.personId || r.telegramChatId ? channel : null) };
  return { sent, registry };
}
async function tick(at: Date, reg = recorder()) {
  await planTick(t.handle.db, at, { timeZone: TZ });
  await dispatch(t.handle.db, at, { registry: reg.registry, timeZone: TZ });
  return reg;
}
const msgUpdate = (chatId: number, text: string): TelegramUpdate => ({
  update_id: Math.floor(Math.random() * 1e9),
  message: { message_id: 1, chat: { id: chatId, type: "private" }, from: { id: chatId, first_name: "X" }, text },
});
const runs = (routineId: string) => t.handle.db.select().from(routineRuns).where(eq(routineRuns.routineId, routineId));
const routineRows = (userId: string) =>
  t.handle.db
    .select()
    .from(notificationsOutbox)
    .where(and(eq(notificationsOutbox.userId, userId), eq(notificationsOutbox.kind, "routine_reminder")));
const founderRoutine = (who: "nuraaly" | "talant", time: string, chase: Record<string, string> = {}) =>
  createRoutine(t.ctx("nuraaly", local(MON, "08:00")), {
    title: "Review cash",
    assignee: `user:${t.userIds[who]}`,
    scheduleKind: "weekly",
    days: [1, 2, 3, 4, 5, 6, 7],
    time,
    confirmation: "button",
    items: "",
    chase,
  });

describe("founder routine parked → summary", () => {
  it("a routine ask parked by daily_budget_full is listed in the evening check, which still goes out", async () => {
    await updateMyPreferences(t.ctx("talant"), { ...PREFS, maxOtherPerDay: 0 });
    const r = await founderRoutine("talant", "11:00");
    await tick(local(MON, "11:00"));
    const [parked] = await routineRows(t.userIds.talant);
    expect(parked).toMatchObject({ status: "parked", lastError: "daily_budget_full" });

    const evening = await tick(local(MON, "19:00"));
    const check = evening.sent.filter((s) => s.to === t.userIds.talant && JSON.stringify(s.message).includes("Routine still open: Review cash"));
    expect(check).toHaveLength(1);
    const [eveningRow] = await t.handle.db
      .select()
      .from(notificationsOutbox)
      .where(and(eq(notificationsOutbox.userId, t.userIds.talant), like(notificationsOutbox.dedupeKey, "evening:%")));
    expect(eveningRow).toMatchObject({ status: "sent", attempts: 1, lastError: null });
    const [after] = await routineRows(t.userIds.talant);
    expect(after!.bundledIntoId).toBe(eveningRow!.id);
    expect((await runs(r.id))[0]!.status).toBe("open");
  });
});

describe("founder routine defaults and budget", () => {
  it("defaults: the ask and at most one reminder, no escalation (still customizable per routine)", async () => {
    const r = await founderRoutine("talant", "10:00");
    const [view] = await listRoutines(t.ctx("nuraaly"), { userId: t.userIds.talant });
    expect(view!.chase).toMatchObject({ ...FOUNDER_ROUTINE_CHASE, chaseUntil: DEFAULT_STAFF_SETTINGS.workEnd });
    expect(view!.defaults.maxPerDay).toBe(2);
    const custom = await founderRoutine("nuraaly", "10:00", { maxPerDay: "4", chaseEveryMinutes: "60" });
    const [cv] = (await listRoutines(t.ctx("nuraaly"), { userId: t.userIds.nuraaly })).filter((v) => v.routine.id === custom.id);
    expect(cv!.chase).toMatchObject({ maxPerDay: 4, chaseEveryMinutes: 60, escalateAfterChases: 0 });

    for (const hm of ["10:00", "11:00", "12:00", "13:00", "14:00", "16:00", "18:00", "19:30"]) await tick(local(MON, hm));
    const mine = (await routineRows(t.userIds.talant)).filter((x) => x.status === "sent");
    expect(mine.map((x) => (x.payload as { slot: number }).slot).sort()).toEqual([0, 1]);
    expect((await runs(r.id))[0]).toMatchObject({ status: "open", chaseCount: 1 });
    // No escalation by default: the other founder hears nothing.
    const esc = await t.handle.db.select().from(notificationsOutbox).where(like(notificationsOutbox.dedupeKey, "routine-esc:%"));
    expect(esc).toHaveLength(0);
  });

  it("routine messages do not use the founder's daily budget: task pushes the same day still go out; over budget a routine message is folded", async () => {
    const r = await founderRoutine("talant", "10:00");
    await tick(local(MON, "10:00"));
    await tick(local(MON, "13:00"));
    expect((await routineRows(t.userIds.talant)).filter((x) => x.status === "sent")).toHaveLength(2);

    const ids: string[] = [];
    for (const title of ["Nudge A", "Nudge B", "Nudge C", "Nudge D"]) {
      const task = await createTask(t.ctx("talant"), { title, companyId: t.companyIds["kiwi-go"], dueDate: "2026-11-20" });
      ids.push(task.id);
      await enqueue(t.handle.db, { userId: t.userIds.talant, kind: "task_reminder", taskId: task.id, scheduledFor: local(MON, "13:30"), dedupeKey: `nudge:${title}` });
    }
    const reg = await tick(local(MON, "13:30"));
    const nudges = await t.handle.db.select().from(notificationsOutbox).where(and(eq(notificationsOutbox.userId, t.userIds.talant), eq(notificationsOutbox.kind, "task_reminder")));
    // The budget (3) is the task pushes' own: three go out, the fourth is parked.
    expect(nudges.filter((n) => n.status === "sent")).toHaveLength(3);
    expect(nudges.filter((n) => n.status === "parked")).toHaveLength(1);
    expect(reg.sent.filter((s) => s.to === t.userIds.talant && s.message.title !== "Routine: Review cash")).toHaveLength(3);

    // Budget full: a routine message is parked (listed in the next summary), not sent.
    await runRoutineNow(t.ctx("talant", local(MON, "14:00")), r.id);
    await dispatch(t.handle.db, local(MON, "14:00"), { registry: recorder().registry, timeZone: TZ });
    const now = (await routineRows(t.userIds.talant)).find((x) => x.dedupeKey?.includes(":now"));
    expect(now).toMatchObject({ status: "parked", lastError: "daily_budget_full" });
    const evening = await tick(local(MON, "19:00"));
    expect(evening.sent.some((s) => s.to === t.userIds.talant && JSON.stringify(s.message).includes("Routine still open: Review cash"))).toBe(true);
  });
});

describe("a person unreachable mid-run", () => {
  async function onTelegram(chat: number) {
    const at = local(MON, "08:00");
    const inv = await createPersonInvite(t.ctx("nuraaly", at), elmurat);
    await handleTelegramUpdate(t.handle.db, msgUpdate(chat, `/start ${inv.code}`), at);
    await setPersonBotEnabled(t.ctx("nuraaly", at), elmurat, true);
  }

  it("asked at 15:00, /stop at 15:10: no more reminders, but the founders still get the 19:00 escalation (with why)", async () => {
    await onTelegram(ELMURAT_CHAT);
    const r = await createRoutine(t.ctx("nuraaly", local(MON, "08:00")), {
      title: "1C записи",
      description: "",
      companyId: "",
      assignee: `person:${elmurat}`,
      scheduleKind: "weekly",
      days: [1, 2, 3, 4, 5, 6],
      time: "15:00",
      confirmation: "checklist",
      items: "Kiwi Go\nJobutify",
      chase: { chaseEveryMinutes: "120", chaseUntil: "19:00", escalateAt: "19:00" },
    });
    const ask = await tick(local(MON, "15:00"));
    expect(ask.sent.filter((s) => s.personId === elmurat)).toHaveLength(1);
    await handleTelegramUpdate(t.handle.db, msgUpdate(ELMURAT_CHAT, "/stop"), local(MON, "15:10"));

    const at17 = await tick(local(MON, "17:00"));
    expect(at17.sent.filter((s) => s.personId === elmurat)).toHaveLength(0);
    const at19 = await tick(local(MON, "19:00"));
    const esc = at19.sent.filter((s) => s.message.title === "Routine not done");
    expect(esc.map((s) => s.to).sort()).toEqual([t.userIds.nuraaly, t.userIds.talant].sort());
    expect(esc[0]!.message.lines[0]!.text).toBe(
      'Elmurat hasn\'t finished "1C записи" today — missing: Kiwi Go, Jobutify — stopped the bot (/stop), so no more reminders',
    );
    const [run] = await runs(r.id);
    expect(run!.status).toBe("escalated");
    expect(await t.handle.db.select().from(notificationsOutbox).where(eq(notificationsOutbox.dedupeKey, `routine-esc:${run!.id}`))).toHaveLength(2);

    // Still unreachable the next day: Monday's run is closed as missed, no run is opened on Tuesday.
    await tick(local(TUE, "09:00"));
    await tick(local(TUE, "15:00"));
    await tick(local(TUE, "19:00"));
    expect((await runs(r.id)).map((x) => [x.runDate, x.status])).toEqual([[MON, "missed"]]);
  });
});
