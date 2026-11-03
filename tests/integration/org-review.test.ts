/**
 * C3b independent review fixes (docs/reviews/C3b-review.md): archived department on a task,
 * duplicate department numbers, archive vs move under the chart lock, composite foreign keys,
 * optimistic concurrency (chart version) and undo of head changes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/db";
import { orgChangeLog, orgDepartments, orgFunctions } from "@/server/db/schema";
import {
  applyVysotskyTemplate,
  createDepartment,
  createFunction,
  getOrgChart,
  getOrgChartVersion,
  moveFunction,
  setArchived,
  undoLastChange,
  updateDepartment,
  updateDivision,
  updateFunction,
  type OrgChartView,
  type OrgWriteOpts,
} from "@/server/services/org";
import { createTask, getTask, updateTask } from "@/server/services/tasks";
import type { ServiceContext } from "@/server/services/context";

let t: TestDb;
let nuraaly: ServiceContext;
let kiwi: string;

beforeAll(async () => {
  t = await createTestDb();
  nuraaly = t.ctx("nuraaly");
  kiwi = t.companyIds["kiwi-go"]!;
});
afterAll(async () => {
  await t.handle.close();
});

const chartOf = async (companyId: string) => (await getOrgChart(nuraaly, { companyId, companyUnitId: null }))!;
const dept = (c: OrgChartView, n: number) => c.divisions.flatMap((d) => d.departments).find((d) => d.number === n)!;

async function liveSortsOk(chartId: string) {
  const fns = await t.handle.db.select().from(orgFunctions).where(and(eq(orgFunctions.chartId, chartId), isNull(orgFunctions.archivedAt)));
  const byDept = new Map<string, number[]>();
  for (const f of fns) byDept.set(f.departmentId, [...(byDept.get(f.departmentId) ?? []), f.sort]);
  for (const sorts of byDept.values()) expect([...sorts].sort((a, b) => a - b)).toEqual(sorts.map((_, i) => i));
}

describe("#1 a task keeps its link to an archived department", () => {
  it("editing the task with the same (archived) department id keeps it; only a real change is checked", async () => {
    const c = await chartOf(kiwi);
    const d8 = dept(c, 8);
    const task = await createTask(nuraaly, { title: "Выплаты курьерам", companyId: kiwi, orgDepartmentId: d8.id });
    await setArchived(nuraaly, "department", d8.id, true);
    // The task form now sends the archived department back (it is listed as "(archived)").
    const edited = await updateTask(nuraaly, task.id, { title: "Выплаты курьерам — неделя 45", orgDepartmentId: d8.id });
    expect(edited.orgDepartment).toMatchObject({ id: d8.id, number: 8 });
    expect((await getTask(nuraaly, task.id)).orgDepartment?.id).toBe(d8.id);
    // Picking an archived department anew is still refused.
    const other = await createTask(nuraaly, { title: "x", companyId: kiwi });
    await expect(updateTask(nuraaly, other.id, { orgDepartmentId: d8.id })).rejects.toMatchObject({ code: "validation" });
    await setArchived(nuraaly, "department", d8.id, false);
  });
});

describe("#2 department numbers are unique among live departments of a chart", () => {
  it("refuses a number used by another live department, also on restore and on undo", async () => {
    const companyId = t.companyIds["marketing"]!;
    const c = await applyVysotskyTemplate(nuraaly, { companyId, companyUnitId: null });
    await expect(updateDepartment(nuraaly, dept(c, 5).id, { number: 4 })).rejects.toMatchObject({ code: "validation", message: expect.stringContaining("4 Маркетинг") });
    // Archived departments keep their number; restoring after it was taken is refused.
    await setArchived(nuraaly, "department", dept(c, 6).id, true);
    await updateDepartment(nuraaly, dept(c, 5).id, { number: 6 });
    await expect(setArchived(nuraaly, "department", dept(c, 6).id, false)).rejects.toMatchObject({ code: "validation" });
    // Undo of the renumbering is fine (6 → 5 is free), then the restore works.
    expect(await undoLastChange(nuraaly, c.id)).toMatch(/^Edited 5 Продажи: number/);
    await setArchived(nuraaly, "department", dept(c, 6).id, false);
    const after = await chartOf(companyId);
    expect(after.divisions.find((d) => d.number === 2)!.departments.map((d) => d.number)).toEqual([4, 5, 6]);
    // The database enforces it too (partial unique index, 0020).
    await expect(t.handle.db.update(orgDepartments).set({ number: 4 }).where(eq(orgDepartments.id, dept(after, 5).id))).rejects.toThrow();
  });

  it("a new department takes the next number; past 99 the lowest free one; none free → refused", async () => {
    const companyId = t.companyIds["upsell-group"]!;
    const c = await applyVysotskyTemplate(nuraaly, { companyId, companyUnitId: null });
    const div = c.divisions[0]!;
    const a = await createDepartment(nuraaly, { divisionId: div.id, name: "Аналитика" });
    expect(dept(await chartOf(companyId), 22).id).toBe(a);
    await updateDepartment(nuraaly, a, { number: 99 });
    const b = await createDepartment(nuraaly, { divisionId: div.id, name: "Ещё" });
    expect(dept(await chartOf(companyId), 22).id).toBe(b);
    // Fill every number 23–98 (directly), then nothing is left.
    await t.handle.db.insert(orgDepartments).values(
      Array.from({ length: 76 }, (_, i) => ({ chartId: c.id, companyId, divisionId: div.id, number: 23 + i, name: `D${23 + i}`, sort: 10 + i })),
    );
    await expect(createDepartment(nuraaly, { divisionId: div.id, name: "Лишний" })).rejects.toMatchObject({ code: "validation", message: expect.stringContaining("99") });
    const numbers = (await t.handle.db.select({ n: orgDepartments.number }).from(orgDepartments).where(and(eq(orgDepartments.chartId, c.id), isNull(orgDepartments.archivedAt)))).map((r) => r.n);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

describe("#4 archive and move at the same time", () => {
  it("never leaves an archived function in a live order (re-checked under the chart lock)", async () => {
    const c = await chartOf(kiwi);
    for (let i = 0; i < 4; i++) {
      const fid = await createFunction(nuraaly, { departmentId: dept(c, 21).id, text: `Гонка ${i}` });
      const [archive, move] = await Promise.allSettled([
        setArchived(t.ctx("talant"), "function", fid, true),
        moveFunction(nuraaly, { functionId: fid, departmentId: dept(c, 20).id, index: 0 }),
      ]);
      expect(archive.status).toBe("fulfilled");
      if (move.status === "rejected") expect(move.reason).toMatchObject({ code: "validation" });
      const [row] = await t.handle.db.select().from(orgFunctions).where(eq(orgFunctions.id, fid));
      expect(row!.archivedAt).not.toBeNull();
      await liveSortsOk(c.id);
    }
  });

  it("refuses editing a function or department that is archived", async () => {
    const c = await chartOf(kiwi);
    const fid = await createFunction(nuraaly, { departmentId: dept(c, 19).id, text: "Временная" });
    await setArchived(nuraaly, "function", fid, true);
    await expect(updateFunction(nuraaly, fid, { text: "x" })).rejects.toMatchObject({ code: "validation" });
    await expect(moveFunction(nuraaly, { functionId: fid, departmentId: dept(c, 20).id, index: 0 })).rejects.toMatchObject({ code: "validation" });
  });
});

describe("#5 the database keeps org rows inside their chart and company", () => {
  it("refuses a function pointing at another chart's department or a row with another company", async () => {
    const kiwiC = await chartOf(kiwi);
    const other = await applyVysotskyTemplate(nuraaly, { companyId: t.companyIds["asqa-zou-holding"]!, companyUnitId: null });
    await expect(
      t.handle.db.insert(orgFunctions).values({ chartId: kiwiC.id, companyId: kiwi, departmentId: dept(other, 1).id, text: "чужой отдел" }),
    ).rejects.toThrow();
    await expect(
      t.handle.db.insert(orgFunctions).values({ chartId: kiwiC.id, companyId: t.companyIds["jobutify"]!, departmentId: dept(kiwiC, 1).id, text: "чужая компания" }),
    ).rejects.toThrow();
    await expect(t.handle.db.update(orgDepartments).set({ divisionId: other.divisions[0]!.id }).where(eq(orgDepartments.id, dept(kiwiC, 1).id))).rejects.toThrow();
  });
});

describe("#6 optimistic concurrency: the chart version", () => {
  it("refuses a change made from a stale copy and reports the new version after a write", async () => {
    const c = await chartOf(kiwi);
    expect(await getOrgChartVersion(nuraaly, c.id)).toBe(c.version);
    const opts: OrgWriteOpts = { expectedVersion: c.version, result: {} };
    await updateDepartment(nuraaly, dept(c, 4).id, { statistic: "Новые отправители" }, opts);
    expect(opts.result!.version).toBe((await chartOf(kiwi)).version);
    expect(Number(opts.result!.version)).toBeGreaterThan(Number(c.version));
    // Talant's board still shows the old version: his move is refused, nothing changes.
    const before = (await chartOf(kiwi)).divisions;
    const fn = dept(c, 5).functions[0]!;
    await expect(moveFunction(t.ctx("talant"), { functionId: fn.id, departmentId: dept(c, 6).id, index: 0 }, { expectedVersion: c.version })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(undoLastChange(t.ctx("talant"), c.id, { expectedVersion: c.version })).rejects.toMatchObject({ code: "conflict" });
    expect((await chartOf(kiwi)).divisions).toEqual(before);
    // With the current version it works.
    const fresh = await chartOf(kiwi);
    await moveFunction(t.ctx("talant"), { functionId: fn.id, departmentId: dept(c, 6).id, index: 0 }, { expectedVersion: fresh.version });
    expect(dept(await chartOf(kiwi), 6).functions[0]!.id).toBe(fn.id);
    await undoLastChange(nuraaly, c.id);
  });
});

describe("undo of head changes", () => {
  it("division and department heads go back to who they were", async () => {
    const c = await chartOf(kiwi);
    const elmurat = t.personIds["elmurat"]!;
    const div = c.divisions.find((d) => d.number === 1)!;
    await updateDivision(nuraaly, div.id, { headPersonId: elmurat });
    await updateDepartment(nuraaly, dept(c, 2).id, { headPersonId: elmurat });
    let now = await chartOf(kiwi);
    expect([now.divisions.find((d) => d.number === 1)!.headName, dept(now, 2).headName]).toEqual(["Elmurat", "Elmurat"]);
    expect(await undoLastChange(nuraaly, c.id)).toMatch(/^Edited 2 .*: head$/);
    now = await chartOf(kiwi);
    expect(dept(now, 2).headPersonId).toBeNull();
    expect(now.divisions.find((d) => d.number === 1)!.headPersonId).toBe(elmurat);
    expect(await undoLastChange(nuraaly, c.id)).toBe("Edited division 1 Персонал: head");
    expect((await chartOf(kiwi)).divisions.find((d) => d.number === 1)!.headPersonId).toBeNull();
    const undos = await t.handle.db.select().from(orgChangeLog).where(and(eq(orgChangeLog.chartId, c.id), eq(orgChangeLog.action, "undo")));
    expect(undos.some((u) => u.summary === "Undid: Edited division 1 Персонал: head")).toBe(true);
  });
});
