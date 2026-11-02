import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { taskEvents } from "@/server/db/schema";
import { ServiceError } from "@/server/services/errors";
import {
  changeTaskDeadline,
  changeTaskStatus,
  createTask,
  deleteTask,
  getTask,
  getTodaySummary,
  listTaskEvents,
  listTasks,
  updateTask,
} from "@/server/services/tasks";
import { createProject } from "@/server/services/projects";
import { search } from "@/server/services/search";
import { createTestDb, FIXED_NOW, type TestDb } from "../helpers/db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.handle.close();
});

async function expectServiceError(p: Promise<unknown>, code: ServiceError["code"]) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ServiceError);
  expect((err as ServiceError).code).toBe(code);
}

describe("visibility isolation between founders", () => {
  it("a private todo is visible only to its owner", async () => {
    const mine = await createTask(t.ctx("nuraaly"), { title: "Nuraaly secret todo", visibility: "private" });

    expect((await listTasks(t.ctx("nuraaly"), { view: "my" })).map((x) => x.id)).toContain(mine.id);

    const talant = t.ctx("talant");
    for (const view of [undefined, "my", "assigned", "company", "overdue"] as const) {
      const ids = (await listTasks(talant, { view, status: "any" })).map((x) => x.id);
      expect(ids).not.toContain(mine.id);
    }
    await expectServiceError(getTask(talant, mine.id), "not_found");
    await expectServiceError(updateTask(talant, mine.id, { title: "hacked" }), "not_found");
    await expectServiceError(changeTaskDeadline(talant, mine.id, "2030-01-01"), "not_found");
    await expectServiceError(deleteTask(talant, mine.id), "not_found");
    await expectServiceError(listTaskEvents(talant, mine.id), "not_found");
    expect((await search(talant, "secret todo")).tasks).toHaveLength(0);
    expect((await search(t.ctx("nuraaly"), "secret todo")).tasks).toHaveLength(1);
    expect((await getTodaySummary(talant)).personal.map((x) => x.id)).not.toContain(mine.id);
  });

  it("shared company tasks are visible to both founders", async () => {
    const shared = await createTask(t.ctx("talant"), {
      title: "Shared Kiwi task",
      visibility: "shared",
      companyId: t.companyIds["kiwi-go"],
    });
    expect((await getTask(t.ctx("nuraaly"), shared.id)).title).toBe("Shared Kiwi task");
    expect((await listTasks(t.ctx("nuraaly"), { view: "company" })).map((x) => x.id)).toContain(shared.id);
  });

  it("a personal todo cannot be assigned to the other founder or a person", async () => {
    await expectServiceError(
      createTask(t.ctx("nuraaly"), { title: "x", visibility: "private", assigneeUserId: t.userIds.talant }),
      "validation",
    );
    await expectServiceError(
      createTask(t.ctx("nuraaly"), {
        title: "x",
        visibility: "private",
        companyId: t.companyIds["jobutify"],
        assigneePersonId: t.personIds.edil,
      }),
      "validation",
    );
  });

  it("only the creator can make a shared task private", async () => {
    const shared = await createTask(t.ctx("nuraaly"), {
      title: "Owned by Nuraaly",
      companyId: t.companyIds["jobutify"],
    });
    await expectServiceError(updateTask(t.ctx("talant"), shared.id, { visibility: "private" }), "forbidden");
    const priv = await updateTask(t.ctx("nuraaly"), shared.id, { visibility: "private" });
    expect(priv.visibility).toBe("private");
    await expectServiceError(getTask(t.ctx("talant"), shared.id), "not_found");
  });
});

describe("company isolation", () => {
  it("filters by company return only that company's tasks", async () => {
    await createTask(t.ctx("nuraaly"), { title: "Alura task", companyId: t.companyIds["alura-style"] });
    await createTask(t.ctx("nuraaly"), { title: "Upsell task", companyId: t.companyIds["upsell-group"] });
    const alura = await listTasks(t.ctx("nuraaly"), { companyId: t.companyIds["alura-style"], status: "any" });
    expect(alura.length).toBeGreaterThan(0);
    expect(alura.every((x) => x.company?.id === t.companyIds["alura-style"])).toBe(true);
  });

  it("rejects a project from another company", async () => {
    const project = await createProject(t.ctx("nuraaly"), { companyId: t.companyIds["kiwi-go"]!, name: "Kiwi P" });
    await expectServiceError(
      createTask(t.ctx("nuraaly"), { title: "x", companyId: t.companyIds["jobutify"], projectId: project.id }),
      "validation",
    );
    const inherited = await createTask(t.ctx("nuraaly"), { title: "inherits", projectId: project.id });
    expect(inherited.company?.id).toBe(t.companyIds["kiwi-go"]);
  });

  it("rejects assigning a person who does not work for the company", async () => {
    // Edil is linked to Jobutify only.
    await expectServiceError(
      createTask(t.ctx("nuraaly"), {
        title: "x",
        companyId: t.companyIds["kiwi-go"],
        assigneePersonId: t.personIds.edil,
      }),
      "validation",
    );
    const ok = await createTask(t.ctx("nuraaly"), {
      title: "Ask Edil",
      companyId: t.companyIds["jobutify"],
      assigneePersonId: t.personIds.edil,
    });
    expect(ok.assignee).toMatchObject({ kind: "person", name: "Edil" });
  });

  it("rejects an unknown company", async () => {
    await expectServiceError(
      createTask(t.ctx("nuraaly"), { title: "x", companyId: "4b0c6c7e-0000-4000-8000-000000000000" }),
      "not_found",
    );
  });
});

describe("validation", () => {
  it("requires a title and a company for shared tasks", async () => {
    await expect(createTask(t.ctx("nuraaly"), { title: "  " })).rejects.toThrow();
    await expectServiceError(createTask(t.ctx("nuraaly"), { title: "no company", visibility: "shared" }), "validation");
  });
  it("rejects invalid dates, enums and unknown fields", async () => {
    await expect(
      createTask(t.ctx("nuraaly"), { title: "x", visibility: "private", dueDate: "2026-02-30" }),
    ).rejects.toThrow();
    await expect(
      createTask(t.ctx("nuraaly"), { title: "x", visibility: "private", status: "nope" as never }),
    ).rejects.toThrow();
    await expect(
      createTask(t.ctx("nuraaly"), { title: "x", visibility: "private", ownerUserId: t.userIds.talant } as never),
    ).rejects.toThrow();
  });
});

describe("overdue and deadline changes", () => {
  it("overdue uses Bishkek today and stays until deadline moves or task closes", async () => {
    const ctx = t.ctx("nuraaly");
    const task = await createTask(ctx, {
      title: "Late thing",
      companyId: t.companyIds["kiwi-go"],
      dueDate: "2026-11-01",
    });
    expect(task.isOverdue).toBe(true);
    expect((await listTasks(ctx, { view: "overdue" })).map((x) => x.id)).toContain(task.id);
    expect((await getTodaySummary(ctx)).overdue.map((x) => x.id)).toContain(task.id);

    // Weeks later it is still overdue.
    const later = t.ctx("nuraaly", new Date("2026-12-15T06:00:00Z"));
    expect((await getTask(later, task.id)).isOverdue).toBe(true);

    // Changing the deadline clears it and is logged.
    const moved = await changeTaskDeadline(ctx, task.id, "2026-11-05");
    expect(moved.isOverdue).toBe(false);
    const events = await listTaskEvents(ctx, task.id);
    const dl = events.find((e) => e.kind === "deadline_changed");
    expect(dl).toMatchObject({ field: "dueDate", oldValue: "2026-11-01", newValue: "2026-11-05", actorUserId: t.userIds.nuraaly });

    // Overdue again once the new date passes; closing it clears it.
    const after = t.ctx("nuraaly", new Date("2026-11-06T06:00:00Z"));
    expect((await getTask(after, task.id)).isOverdue).toBe(true);
    const done = await changeTaskStatus(after, task.id, "done");
    expect(done.isOverdue).toBe(false);
    expect(done.completedAt).not.toBeNull();
  });

  it("a task due today becomes overdue at Bishkek midnight, not UTC midnight", async () => {
    const task = await createTask(t.ctx("talant"), { title: "Due 2 Nov", visibility: "private", dueDate: "2026-11-02" });
    const before = t.ctx("talant", new Date("2026-11-02T17:59:00Z")); // 23:59 Bishkek
    const after = t.ctx("talant", new Date("2026-11-02T18:01:00Z")); // 00:01 Bishkek, 3 Nov
    expect((await getTask(before, task.id)).isOverdue).toBe(false);
    expect((await getTask(after, task.id)).isOverdue).toBe(true);
  });

  it("logs every change kind in task_events", async () => {
    const ctx = t.ctx("talant");
    const task = await createTask(ctx, { title: "Audit me", companyId: t.companyIds["alura-brand"] });
    await updateTask(ctx, task.id, { title: "Audited", priority: "urgent", assigneeUserId: t.userIds.nuraaly });
    await changeTaskStatus(ctx, task.id, "in_progress");
    const kinds = (await listTaskEvents(ctx, task.id)).map((e) => `${e.kind}:${e.field ?? ""}`);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "created:",
        "updated:title",
        "updated:priority",
        "assignee_changed:assigneeUserId",
        "status_changed:status",
      ]),
    );
  });

  it("delete keeps an audit snapshot", async () => {
    const ctx = t.ctx("talant");
    const task = await createTask(ctx, { title: "Delete me", visibility: "private" });
    await deleteTask(ctx, task.id);
    await expectServiceError(getTask(ctx, task.id), "not_found");
    const rows = await t.handle.db.select().from(taskEvents).where(eq(taskEvents.kind, "deleted"));
    expect(rows.some((r) => (r.oldValue as { title?: string }).title === "Delete me" && r.taskId === null)).toBe(true);
  });
});

describe("today summary", () => {
  it("groups my tasks into overdue / today / this week / personal", async () => {
    const ctx = t.ctx("talant", FIXED_NOW);
    const today = await createTask(ctx, { title: "T today", visibility: "private", dueDate: "2026-11-02" });
    const week = await createTask(ctx, { title: "T week", companyId: t.companyIds["kiwi-go"], dueDate: "2026-11-06" });
    const forNuraaly = await createTask(ctx, {
      title: "Assigned to Nuraaly",
      companyId: t.companyIds["kiwi-go"],
      assigneeUserId: t.userIds.nuraaly,
      dueDate: "2026-11-02",
    });
    const s = await getTodaySummary(ctx);
    expect(s.today).toBe("2026-11-02");
    expect(s.dueToday.map((x) => x.id)).toContain(today.id);
    expect(s.thisWeek.map((x) => x.id)).toContain(week.id);
    expect(s.personal.map((x) => x.id)).toContain(today.id);
    expect(s.dueToday.map((x) => x.id)).not.toContain(forNuraaly.id);
    expect((await getTodaySummary(t.ctx("nuraaly"))).dueToday.map((x) => x.id)).toContain(forNuraaly.id);
  });
});
