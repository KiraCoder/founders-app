/**
 * Tasks + Routines lists (one area): "My tasks" (personal + assigned to me + mine without an
 * assignee), the filter bar's quick filters / search / due range / sort and the status tab
 * counts; checklists editable after creation (task: reorder; routine: the page's checklist card
 * with the same effect on today's run as the edit dialog).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { readListFilters } from "@/lib/list-filters";
import { notificationsOutbox, routineRuns } from "@/server/db/schema";
import { addTaskComment } from "@/server/services/task-comments";
import { addChecklistItem, listChecklist, moveChecklistItem } from "@/server/services/task-checklist";
import { countTasksByStatus, createTask, listTasks, updateTask } from "@/server/services/tasks";
import { createRoutine, getRoutine, runRoutineNow, updateRoutineChecklist } from "@/server/services/routines";
import { filterPeople } from "@/components/tasks/filter-people";
import { getTaskFormOptions } from "@/server/services/options";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.handle.close();
});

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("My tasks and the filter bar", () => {
  it("mine = personal todos + assigned to me + mine without assignee; chips narrow it; the other founder's are out", async () => {
    const n = t.ctx("nuraaly");
    const tl = t.ctx("talant");
    const kiwi = t.companyIds["kiwi-go"]!;
    const personal = await createTask(n, { title: "Mine personal", visibility: "private" });
    const assigned = await createTask(tl, { title: "Talant gives Nuraaly", visibility: "shared", companyId: kiwi, assigneeUserId: t.userIds.nuraaly });
    const unassigned = await createTask(n, { title: "Mine shared nobody", visibility: "shared", companyId: kiwi });
    const toPerson = await createTask(n, { title: "Mine for Elmurat", visibility: "shared", assigneePersonId: t.personIds.elmurat, companyId: kiwi });
    const talants = await createTask(tl, { title: "Talant own", visibility: "shared", companyId: kiwi });

    const mine = ids(await listTasks(n, { view: "mine" }));
    expect(mine).toEqual(expect.arrayContaining([personal.id, assigned.id, unassigned.id]));
    expect(mine).not.toContain(toPerson.id); // given to someone else
    expect(mine).not.toContain(talants.id);
    expect(ids(await listTasks(n, { view: "mine", quick: ["personal"] }))).toEqual([personal.id]);
    expect(ids(await listTasks(n, { view: "mine", quick: ["assigned"] }))).toEqual([assigned.id]);
    expect(ids(await listTasks(tl, { view: "mine" }))).not.toContain(personal.id);
  });

  it("quick filters, search (title / person / company), due range, sort and the status counts", async () => {
    const n = t.ctx("nuraaly");
    const jobutify = t.companyIds.jobutify!;
    const late = await createTask(n, { title: "QF late", visibility: "shared", companyId: jobutify, dueDate: "2026-10-30" });
    const soon = await createTask(n, { title: "QF soon", visibility: "shared", companyId: jobutify, dueDate: "2026-11-05", assigneePersonId: t.personIds.edil });
    const done = await createTask(n, { title: "QF done", visibility: "shared", companyId: jobutify, dueDate: "2026-11-01" });
    await updateTask(n, done.id, { status: "done" });
    await addTaskComment(n, soon.id, "Есть вопрос");
    const base = { view: "company" as const, companyId: jobutify, search: "QF" };

    expect(ids(await listTasks(n, { ...base, quick: ["overdue"] }))).toEqual([late.id]);
    expect(ids(await listTasks(n, { ...base, quick: ["week"] }))).toEqual([soon.id]);
    expect(ids(await listTasks(n, { ...base, quick: ["waiting"] }))).toEqual([soon.id]);
    expect(ids(await listTasks(n, { ...base, quick: ["comments"] }))).toEqual([soon.id]);
    expect(ids(await listTasks(n, { ...base, status: "overdue" }))).toEqual([late.id]);
    expect(ids(await listTasks(n, { view: "company", search: "Edil" }))).toContain(soon.id); // the person's name
    expect(ids(await listTasks(n, { view: "company", search: "jobut", status: "any" }))).toEqual(expect.arrayContaining([late.id, soon.id, done.id])); // the company
    expect(ids(await listTasks(n, { ...base, status: "any", dueFrom: "2026-11-01", dueTo: "2026-11-05" })).sort()).toEqual([soon.id, done.id].sort());
    expect((await listTasks(n, { ...base, status: "any", sort: "title" })).map((x) => x.title)).toEqual(["QF done", "QF late", "QF soon"]);
    expect(await countTasksByStatus(n, base)).toMatchObject({ open: 2, overdue: 1, done: 1, any: 3 });
    expect(await countTasksByStatus(n, { ...base, quick: ["waiting"] })).toMatchObject({ open: 1, overdue: 0, done: 0, any: 1 });
  });

  it("the URL params are validated (bad values are dropped) and the person filter knows each person's companies", async () => {
    const f = readListFilters(
      { status: "nope", quick: "overdue,bogus,overdue", company: "x", who: `person:${t.personIds.edil}`, from: "2026-13-01", to: "2026-11-30", sort: "title", search: " a " },
      { statuses: ["overdue"], quick: ["overdue"], sorts: ["title"] },
    );
    expect(f).toMatchObject({ status: "", quick: ["overdue"], company: null, personId: t.personIds.edil, from: null, to: "2026-11-30", sort: "title", search: "a" });
    expect(f.query).toEqual({ quick: "overdue", who: `person:${t.personIds.edil}`, to: "2026-11-30", sort: "title", search: "a" });
    const people = filterPeople(await getTaskFormOptions(t.ctx("nuraaly")));
    expect(people.find((p) => p.value === `person:${t.personIds.edil}`)!.companyIds).toEqual([t.companyIds.jobutify]);
    expect(people.filter((p) => p.companyIds === null)).toHaveLength(2); // the founders
  });
});

describe("checklists after creation", () => {
  it("task: items move up / down (positions rewritten), the edge is a no-op", async () => {
    const n = t.ctx("nuraaly");
    const task = await createTask(n, { title: "Reorder me", visibility: "private" });
    const a = (await addChecklistItem(n, task.id, { title: "A" })).item;
    await addChecklistItem(n, task.id, { title: "B" });
    const c = (await addChecklistItem(n, task.id, { title: "C" })).item;
    await moveChecklistItem(n, c.id, "up");
    expect((await listChecklist(n, task.id)).map((i) => i.title)).toEqual(["A", "C", "B"]);
    await moveChecklistItem(n, a.id, "up");
    await moveChecklistItem(n, a.id, "down");
    expect((await listChecklist(n, task.id)).map((i) => i.title)).toEqual(["C", "A", "B"]);
    await expect(moveChecklistItem(t.ctx("talant"), a.id, "down")).rejects.toThrow(/not found/i);
  });

  it("routine: the page's checklist card saves only the items; today's open run gets them and the person one updated message", async () => {
    const n = t.ctx("nuraaly");
    const r = await createRoutine(n, {
      title: "Card checklist",
      assignee: `person:${t.personIds.elmurat}`,
      companyId: "",
      scheduleKind: "weekly",
      days: [1, 2, 3, 4, 5, 6, 7],
      times: ["10:00"],
      confirmation: "button",
      items: "",
    });
    // A "Done" button routine becomes a checklist routine; other fields stay.
    const first = await updateRoutineChecklist(n, r.id, JSON.stringify([{ label: "Kiwi Go" }]));
    expect(first).toMatchObject({ confirmation: "checklist", title: "Card checklist", times: r.times, assigneePersonId: t.personIds.elmurat, todayEffect: null });
    await runRoutineNow(n, r.id);
    const before = await t.handle.db.select().from(notificationsOutbox).where(eq(notificationsOutbox.kind, "staff_routine"));
    const view = await getRoutine(n, r.id);
    const res = await updateRoutineChecklist(n, r.id, [{ key: view.routine.items[0]!.key, label: "Kiwi Go" }, { label: "Jobutify" }]);
    expect(res.todayEffect).toBe("open_run_updated");
    const [run] = await t.handle.db.select().from(routineRuns).where(eq(routineRuns.routineId, r.id));
    expect(run!.items.map((i) => i.label)).toEqual(["Kiwi Go", "Jobutify"]);
    const after = await t.handle.db.select().from(notificationsOutbox).where(eq(notificationsOutbox.kind, "staff_routine"));
    expect(after.length).toBe(before.length + 1);
    await expect(updateRoutineChecklist(n, r.id, [])).rejects.toThrow(/at least one item/i);
  });
});
