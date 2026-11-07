import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { taskEvents } from "@/server/db/schema";
import { visibleEventsWhere } from "@/server/services/access";
import type { ServiceContext } from "@/server/services/context";
import { ServiceError } from "@/server/services/errors";
import { createTask, deleteTask, listTaskEvents, updateTask } from "@/server/services/tasks";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.handle.close();
});

/** Every audit row the user may read (the same filter any event reader must use). */
async function visibleEvents(ctx: ServiceContext) {
  return ctx.db.select().from(taskEvents).where(visibleEventsWhere(ctx));
}

async function code(p: Promise<unknown>) {
  return p.then(
    () => null,
    (e: unknown) => (e instanceof ServiceError ? e.code : e),
  );
}

describe("audit log (task_events) follows the task's visibility", () => {
  it("events carry the task's visibility and owner", async () => {
    const task = await createTask(t.ctx("nuraaly"), { title: "Private with history", visibility: "private" });
    await updateTask(t.ctx("nuraaly"), task.id, { dueDate: "2026-12-01" });
    const rows = await t.handle.db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.visibility === "private" && r.ownerUserId === t.userIds.nuraaly)).toBe(true);

    expect(await listTaskEvents(t.ctx("nuraaly"), task.id)).toHaveLength(2);
    expect(await code(listTaskEvents(t.ctx("talant"), task.id))).toBe("not_found");
    const talantSees = (await visibleEvents(t.ctx("talant"))).map((e) => e.taskId);
    expect(talantSees).not.toContain(task.id);
  });

  it("Talant cannot see events of Nuraaly's deleted private todo", async () => {
    const task = await createTask(t.ctx("nuraaly"), {
      title: "Secret deleted todo",
      visibility: "private",
      companyId: t.companyIds["kiwi-go"],
    });
    await updateTask(t.ctx("nuraaly"), task.id, { title: "Secret deleted todo v2" });
    await deleteTask(t.ctx("nuraaly"), task.id);

    // After delete, task_id is NULL on all its events; the snapshot columns remain.
    const orphaned = await t.handle.db
      .select()
      .from(taskEvents)
      .where(and(isNull(taskEvents.taskId), eq(taskEvents.ownerUserId, t.userIds.nuraaly)));
    const titles = (rows: typeof orphaned) =>
      rows.flatMap((r) => [r.oldValue, r.newValue]).map((v) => JSON.stringify(v ?? null));
    expect(titles(orphaned).some((s) => s.includes("Secret deleted todo"))).toBe(true);
    expect(orphaned.every((r) => r.visibility === "private")).toBe(true);

    const talant = await visibleEvents(t.ctx("talant"));
    expect(titles(talant).some((s) => s.includes("Secret deleted todo"))).toBe(false);
    const nuraaly = await visibleEvents(t.ctx("nuraaly"));
    expect(titles(nuraaly).some((s) => s.includes("Secret deleted todo"))).toBe(true);
  });

  it("history of a shared task turned private is hidden from the other founder", async () => {
    const n = t.ctx("nuraaly");
    const task = await createTask(n, { title: "Was shared", visibility: "shared", companyId: t.companyIds["jobutify"] });
    await updateTask(n, task.id, { dueDate: "2026-11-20" });
    // While shared, Talant sees the history.
    expect((await listTaskEvents(t.ctx("talant"), task.id)).length).toBe(2);

    await updateTask(n, task.id, { visibility: "private" });
    expect(await code(listTaskEvents(t.ctx("talant"), task.id))).toBe("not_found");
    const talantRows = await t.ctx("talant").db
      .select()
      .from(taskEvents)
      .where(and(eq(taskEvents.taskId, task.id), visibleEventsWhere(t.ctx("talant"))));
    expect(talantRows).toEqual([]);
    // The owner still sees everything, including the older "shared" events.
    expect((await listTaskEvents(n, task.id)).map((e) => e.kind)).toEqual([
      "created",
      "deadline_changed",
      "updated",
    ]);

    // ... and after deleting it, still nothing for Talant.
    await deleteTask(n, task.id);
    const ids = (await visibleEvents(t.ctx("talant"))).map((e) => e.id);
    const deletedSnapshot = (
      await t.handle.db.select().from(taskEvents).where(eq(taskEvents.kind, "deleted"))
    ).find((r) => (r.oldValue as { title?: string }).title === "Was shared")!;
    expect(deletedSnapshot.visibility).toBe("private");
    expect(ids).not.toContain(deletedSnapshot.id);
  });

  it("a private todo made shared exposes its history to the other founder", async () => {
    const task = await createTask(t.ctx("talant"), { title: "Now shared", visibility: "private" });
    await updateTask(t.ctx("talant"), task.id, { visibility: "shared", companyId: t.companyIds["kiwi-go"] });
    expect((await listTaskEvents(t.ctx("nuraaly"), task.id)).length).toBeGreaterThanOrEqual(2);
  });
});
