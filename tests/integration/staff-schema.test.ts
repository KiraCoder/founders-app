import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  appSettings,
  notificationActionTokens,
  notificationsOutbox,
  people,
  taskComments,
  taskDeadlineRequests,
  tasks,
  telegramLinkCodes,
  telegramLinks,
} from "@/server/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

/** Migration 0028: a recipient is a founder OR a person, never both, never neither. */
let t: TestDb;
let taskId: string;
beforeAll(async () => {
  t = await createTestDb();
  const [row] = await t.handle.db
    .insert(tasks)
    .values({ title: "Schema task", ownerUserId: t.userIds.nuraaly, companyId: t.companyIds["kiwi-go"], visibility: "shared" })
    .returning({ id: tasks.id });
  taskId = row!.id;
});
afterAll(async () => {
  await t.handle.close();
});

const fails = async (p: Promise<unknown>) => {
  await expect(p).rejects.toThrow();
};

describe("0028 staff on Telegram schema", () => {
  it("people get bot switches with safe defaults (off, Russian, no overrides)", async () => {
    const [p] = await t.handle.db.select().from(people).where(eq(people.id, t.personIds.elmurat!));
    expect(p!.botEnabled).toBe(false);
    expect(p!.botPausedUntil).toBeNull();
    expect(p!.lang).toBe("ru");
    expect(p!.staffChase).toBeNull();
  });

  it("outbox rows need exactly one of user_id / person_id", async () => {
    const db = t.handle.db;
    const base = { kind: "staff_chase", scheduledFor: new Date() };
    await fails(db.insert(notificationsOutbox).values({ ...base, dedupeKey: "neither" }));
    await fails(
      db.insert(notificationsOutbox).values({ ...base, dedupeKey: "both", userId: t.userIds.nuraaly, personId: t.personIds.elmurat }),
    );
    await db.insert(notificationsOutbox).values({ ...base, dedupeKey: "p1", personId: t.personIds.elmurat });
    // Dedupe per recipient: the same key twice for one person is refused, for another one it is fine.
    await fails(db.insert(notificationsOutbox).values({ ...base, dedupeKey: "p1", personId: t.personIds.elmurat }));
    await db.insert(notificationsOutbox).values({ ...base, dedupeKey: "p1", personId: t.personIds.edil });
    await db.insert(notificationsOutbox).values({ ...base, dedupeKey: "p1", userId: t.userIds.nuraaly });
  });

  it("links, codes and button tokens need exactly one owner; one link per person and per chat", async () => {
    const db = t.handle.db;
    await fails(db.insert(telegramLinks).values({ chatId: "1", telegramUserId: "1" }));
    await fails(
      db.insert(telegramLinks).values({ chatId: "2", telegramUserId: "2", userId: t.userIds.nuraaly, personId: t.personIds.edil }),
    );
    await db.insert(telegramLinks).values({ chatId: "3", telegramUserId: "3", personId: t.personIds.edil });
    await fails(db.insert(telegramLinks).values({ chatId: "4", telegramUserId: "4", personId: t.personIds.edil }));
    await fails(db.insert(telegramLinks).values({ chatId: "3", telegramUserId: "3", personId: t.personIds.elmurat }));

    const exp = new Date(Date.now() + 60_000);
    await fails(db.insert(telegramLinkCodes).values({ codeHash: "h0", expiresAt: exp }));
    await db.insert(telegramLinkCodes).values({ codeHash: "h1", expiresAt: exp, personId: t.personIds.edil });

    await fails(db.insert(notificationActionTokens).values({ tokenHash: "t0", action: "staff_done", taskId, expiresAt: exp }));
    await db
      .insert(notificationActionTokens)
      .values({ tokenHash: "t1", action: "staff_done", taskId, expiresAt: exp, personId: t.personIds.edil });
  });

  it("task comments have exactly one author, a known source and non-empty text", async () => {
    const db = t.handle.db;
    await fails(db.insert(taskComments).values({ taskId, text: "x" }));
    await fails(
      db.insert(taskComments).values({ taskId, text: "x", authorUserId: t.userIds.nuraaly, authorPersonId: t.personIds.edil }),
    );
    await fails(db.insert(taskComments).values({ taskId, text: "", authorUserId: t.userIds.nuraaly }));
    await fails(db.insert(taskComments).values({ taskId, text: "x", source: "email", authorUserId: t.userIds.nuraaly }));
    await db.insert(taskComments).values({ taskId, text: "Ok", source: "telegram", authorPersonId: t.personIds.edil });
  });

  it("one pending deadline request per task", async () => {
    const db = t.handle.db;
    await db.insert(taskDeadlineRequests).values({ taskId, personId: t.personIds.edil!, proposedDueDate: "2026-11-10" });
    await fails(db.insert(taskDeadlineRequests).values({ taskId, personId: t.personIds.edil!, proposedDueDate: "2026-11-11" }));
    await db
      .insert(taskDeadlineRequests)
      .values({ taskId, personId: t.personIds.edil!, proposedDueDate: "2026-11-12", status: "declined" });
  });

  it("the global staff defaults row exists and new tables have RLS", async () => {
    const [row] = await t.handle.db.select().from(appSettings).where(eq(appSettings.key, "staff_notification_defaults"));
    expect(row!.value).toMatchObject({ quietStart: "21:00", quietEnd: "08:00", chaseEveryMinutes: 120, maxPerDay: 12, escalateAfterChases: 3 });
    const res = await t.handle.db.execute(
      sql`select relname, relrowsecurity from pg_class where relname in ('app_settings', 'task_comments', 'task_deadline_requests')`,
    );
    const rows = (res as unknown as { rows: { relrowsecurity: boolean }[] }).rows ?? (res as unknown as { relrowsecurity: boolean }[]);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });
});
