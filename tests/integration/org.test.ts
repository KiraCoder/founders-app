import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, isNull } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/db";
import { seed } from "@/server/db/seed";
import { metricDefinitions, orgChangeLog, orgCharts, orgDepartments, orgFunctions, people, personCompanies } from "@/server/db/schema";
import {
  applyVysotskyTemplate,
  createDepartment,
  createFunction,
  getOrgChart,
  moveDepartment,
  moveFunction,
  orgDepartmentOptionsByCompany,
  orgPeopleOptions,
  setArchived,
  undoLastChange,
  updateDepartment,
  updateDivision,
  updateFunction,
  type OrgChartView,
} from "@/server/services/org";
import { createTask, updateTask } from "@/server/services/tasks";
import type { ServiceContext } from "@/server/services/context";

let t: TestDb;
let kiwi: string;
let jobutify: string;
let nuraaly: ServiceContext;

beforeAll(async () => {
  t = await createTestDb();
  kiwi = t.companyIds["kiwi-go"]!;
  jobutify = t.companyIds["jobutify"]!;
  nuraaly = t.ctx("nuraaly");
});
afterAll(async () => {
  await t.handle.close();
});

const kiwiChart = async (ctx = nuraaly) => (await getOrgChart(ctx, { companyId: kiwi, companyUnitId: null }))!;
const dept = (c: OrgChartView, n: number) => c.divisions.flatMap((d) => d.departments).find((d) => d.number === n)!;
const fnTexts = (c: OrgChartView, n: number) => dept(c, n).functions.map((f) => f.text);

/** Sort integrity: live rows of every list are 0, 1, 2, … with no gaps or duplicates. */
async function assertSortIntegrity(chartId: string) {
  const depts = await t.handle.db.select().from(orgDepartments).where(and(eq(orgDepartments.chartId, chartId), isNull(orgDepartments.archivedAt)));
  const byDiv = new Map<string, number[]>();
  for (const d of depts) byDiv.set(d.divisionId, [...(byDiv.get(d.divisionId) ?? []), d.sort]);
  for (const sorts of byDiv.values()) expect([...sorts].sort((a, b) => a - b)).toEqual(sorts.map((_, i) => i));
  const fns = await t.handle.db.select().from(orgFunctions).where(and(eq(orgFunctions.chartId, chartId), isNull(orgFunctions.archivedAt)));
  const byDept = new Map<string, number[]>();
  for (const f of fns) byDept.set(f.departmentId, [...(byDept.get(f.departmentId) ?? []), f.sort]);
  for (const sorts of byDept.values()) expect([...sorts].sort((a, b) => a - b)).toEqual(sorts.map((_, i) => i));
}

describe("Kiwi Go seed (from the old cockpit)", () => {
  it("has 7 divisions in the order 7, 1 … 6 with the exact Russian texts", async () => {
    const c = await kiwiChart();
    expect(c.divisions.map((d) => d.number)).toEqual([7, 1, 2, 3, 4, 5, 6]);
    const d7 = c.divisions[0]!;
    expect(d7).toMatchObject({
      name: "Административное",
      headTitle: "Генеральный директор",
      reportsTo: "Генеральный директор",
      ckp: "Скоординированная, растущая и прибыльная компания, работающая по планам учредителей.",
    });
    expect(c.divisions[1]).toMatchObject({ name: "Персонал", headTitle: "Директор по персоналу", reportsTo: "Генеральный директор" });
    expect(c.divisions[2]).toMatchObject({ name: "Коммерческое", reportsTo: "Коммерческий директор", ckp: "Выручка от доставки по плану продаж." });
    expect(c.divisions[3]!.ckp).toBe("Сохранённые и учтённые деньги компании и клиентов. Деньги COD — только на отдельном счёте.");
    expect(d7.departments.map((d) => `${d.number} ${d.name}`)).toEqual(["21 Отдел владельца", "20 Официальные вопросы", "19 Офис генерального директора"]);
  });

  it("has departments 1–9 and 19–21 with ЦКП, statistic and every function", async () => {
    const c = await kiwiChart();
    expect(dept(c, 21)).toMatchObject({ ckp: "Планы учредителей, превращённые в утверждённые цели компании.", statistic: "% выполненных целей квартала" });
    expect(fnTexts(c, 21)).toEqual(["Связь с учредителями и Asqa Zou", "Стратегия и решения об открытии новых городов", "Контроль договора с Jobutify (развитие платформы)"]);
    expect(fnTexts(c, 3)).toContain("Расчёт переменной части оплаты → передача в отдел 8");
    expect(fnTexts(c, 5)).toEqual(["Менеджеры по продажам в городах", "Ключевые клиенты: крупные магазины, маркетплейсы", "Межгородская логистика для бизнеса", "Testing"]);
    expect(dept(c, 7)).toMatchObject({ name: "Доходы и COD", statistic: "% COD, сданного в день сбора" });
    expect(fnTexts(c, 8)).toContain("Сдельная оплата курьеров — еженедельно");
    expect(dept(c, 6).name).toBe("Приём заказов и сервис");
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 19, 20, 21]) {
      expect(dept(c, n).ckp, `ЦКП of ${n}`).not.toBe("");
      expect(dept(c, n).statistic, `statistic of ${n}`).not.toBe("");
      expect(dept(c, n).functions.length, `functions of ${n}`).toBeGreaterThanOrEqual(3);
    }
    expect(c.divisions.flatMap((d) => d.departments)).toHaveLength(21);
  });

  it("division 4 keeps only the visible names (уточнить); 5 and 6 are template names with empty departments", async () => {
    const c = await kiwiChart();
    const d4 = c.divisions.find((d) => d.number === 4)!;
    expect(d4.name).toBe("Операции");
    expect(d4.departments.map((d) => d.number)).toEqual([10, 11, 12]);
    for (const d of d4.departments) {
      expect(d.name).toMatch(/\(уточнить\)$/);
      expect(d.ckp).toBe("");
      expect(d.functions).toEqual([]);
    }
    const d5 = c.divisions.find((d) => d.number === 5)!;
    const d6 = c.divisions.find((d) => d.number === 6)!;
    expect([d5.name, d5.nameIsDefault, d6.name, d6.nameIsDefault]).toEqual(["Качество", true, "Расширение", true]);
    expect([...d5.departments, ...d6.departments].map((d) => [d.number, d.name, d.ckp])).toEqual([13, 14, 15, 16, 17, 18].map((n) => [n, "", ""]));
  });

  it("other companies have no chart; re-running the seed neither duplicates nor overwrites edits", async () => {
    expect(await getOrgChart(nuraaly, { companyId: jobutify, companyUnitId: null })).toBeNull();
    const c = await kiwiChart();
    await updateDepartment(nuraaly, dept(c, 9).id, { statistic: "Расхождения инвентаризации, сом" });
    await seed(t.handle.db, { password: "test-password", bcryptRounds: 4, now: t.ctx("nuraaly").now });
    const charts = await t.handle.db.select().from(orgCharts).where(eq(orgCharts.companyId, kiwi));
    expect(charts).toHaveLength(1);
    expect(dept(await kiwiChart(), 9).statistic).toBe("Расхождения инвентаризации, сом");
  });
});

describe("Vysotsky template", () => {
  it("places departments 1–21 in the standard divisions with editable default names", async () => {
    const c = await applyVysotskyTemplate(t.ctx("talant"), { companyId: jobutify, companyUnitId: null });
    expect(c.divisions.map((d) => [d.number, d.name, d.departments.map((x) => x.number)])).toEqual([
      [7, "Административное", [21, 20, 19]],
      [1, "Персонал", [1, 2, 3]],
      [2, "Коммерческое", [4, 5, 6]],
      [3, "Финансы", [7, 8, 9]],
      [4, "Производство", [10, 11, 12]],
      [5, "Качество", [13, 14, 15]],
      [6, "Расширение", [16, 17, 18]],
    ]);
    expect(c.divisions.every((d) => d.nameIsDefault)).toBe(true);
    expect(c.divisions.flatMap((d) => d.departments).every((d) => d.nameIsDefault && d.ckp === "" && d.functions.length === 0)).toBe(true);
    expect(c.history[0]).toMatchObject({ action: "apply_template", actorName: "Talant" });
    await expect(applyVysotskyTemplate(nuraaly, { companyId: jobutify, companyUnitId: null })).rejects.toMatchObject({ code: "conflict" });
  });

  it("a unit of a company can get its own chart; a unit of another company is refused", async () => {
    const units = await t.handle.db.query.companyUnits.findMany();
    const hbk = units.find((u) => u.slug === "hbk")!;
    const style = t.companyIds["alura-style"]!;
    await expect(applyVysotskyTemplate(nuraaly, { companyId: kiwi, companyUnitId: hbk.id })).rejects.toMatchObject({ code: "not_found" });
    const c = await applyVysotskyTemplate(nuraaly, { companyId: style, companyUnitId: hbk.id });
    expect(c.companyUnitId).toBe(hbk.id);
    expect(await getOrgChart(nuraaly, { companyId: style, companyUnitId: null })).toBeNull();
  });

  it("a staff account can neither read nor apply", async () => {
    const staff: ServiceContext = { ...nuraaly, user: { ...nuraaly.user, role: "staff" } };
    await expect(getOrgChart(staff, { companyId: kiwi, companyUnitId: null })).rejects.toMatchObject({ code: "not_found" });
    await expect(applyVysotskyTemplate(staff, { companyId: t.companyIds["marketing"]!, companyUnitId: null })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("editing, moving, archiving", () => {
  it("edits texts (logged with before/after) and clears the default-name mark", async () => {
    const c = await applyVysotskyTemplate(nuraaly, { companyId: t.companyIds["upsell-group"]!, companyUnitId: null });
    const d2 = c.divisions.find((d) => d.number === 2)!;
    await updateDivision(nuraaly, d2.id, { name: "Продажи WB", ckp: "Продажи по плану" });
    await updateDepartment(nuraaly, d2.departments[0]!.id, { ckp: "Новые покупатели", statistic: "Заказы в неделю" });
    const after = (await getOrgChart(nuraaly, { companyId: t.companyIds["upsell-group"]!, companyUnitId: null }))!;
    const nd2 = after.divisions.find((d) => d.number === 2)!;
    expect(nd2).toMatchObject({ name: "Продажи WB", nameIsDefault: false, ckp: "Продажи по плану" });
    expect(nd2.departments[0]).toMatchObject({ ckp: "Новые покупатели", statistic: "Заказы в неделю", nameIsDefault: true });
    const [log] = await t.handle.db.select().from(orgChangeLog).where(and(eq(orgChangeLog.entityId, d2.id), eq(orgChangeLog.action, "update")));
    expect(log).toMatchObject({ entity: "division", actorUserId: t.userIds.nuraaly, before: { name: "Коммерческое", ckp: "", nameIsDefault: true }, after: { name: "Продажи WB", ckp: "Продажи по плану" } });
    expect(log!.summary).toBe("Edited division 2 Коммерческое: name, ЦКП");
  });

  it("moves functions inside and between departments and departments between divisions, keeping sort 0…n", async () => {
    let c = await kiwiChart();
    const testing = dept(c, 5).functions.find((f) => f.text === "Testing")!;
    // Reorder inside department 5: Testing to the top.
    await moveFunction(nuraaly, { functionId: testing.id, departmentId: dept(c, 5).id, index: 0 });
    c = await kiwiChart();
    expect(fnTexts(c, 5)[0]).toBe("Testing");
    // Into department 4 at position 1.
    await moveFunction(nuraaly, { functionId: testing.id, departmentId: dept(c, 4).id, index: 1 });
    c = await kiwiChart();
    expect(fnTexts(c, 4)).toEqual(["Бренд Kiwi Go и контент", "Testing", "Маркетинг приложения для частных отправителей", "Тарифы и аналитика спроса по городам и направлениям"]);
    expect(fnTexts(c, 5)).not.toContain("Testing");
    // An index past the end means "last".
    await moveFunction(nuraaly, { functionId: testing.id, departmentId: dept(c, 6).id, index: 999 });
    c = await kiwiChart();
    expect(fnTexts(c, 6).at(-1)).toBe("Testing");
    // Department 5 into division 1 at the top.
    const d1 = c.divisions.find((d) => d.number === 1)!;
    await moveDepartment(nuraaly, { departmentId: dept(c, 5).id, divisionId: d1.id, index: 0 });
    c = await kiwiChart();
    expect(c.divisions.find((d) => d.number === 1)!.departments.map((d) => d.number)).toEqual([5, 1, 2, 3]);
    expect(c.divisions.find((d) => d.number === 2)!.departments.map((d) => d.number)).toEqual([4, 6]);
    await assertSortIntegrity(c.id);
  });

  it("adds, archives and restores (back in place); nothing is deleted", async () => {
    let c = await kiwiChart();
    const d21 = dept(c, 21);
    const fid = await createFunction(nuraaly, { departmentId: d21.id, text: "Отчёт учредителям раз в месяц" });
    c = await kiwiChart();
    expect(fnTexts(c, 21).at(-1)).toBe("Отчёт учредителям раз в месяц");
    const second = dept(c, 21).functions[1]!;
    await setArchived(nuraaly, "function", second.id, true);
    c = await kiwiChart();
    expect(fnTexts(c, 21)).not.toContain(second.text);
    await setArchived(nuraaly, "function", second.id, false);
    c = await kiwiChart();
    expect(fnTexts(c, 21)[1]).toBe(second.text);
    const newDept = await createDepartment(nuraaly, { divisionId: c.divisions[0]!.id, name: "Аналитика" });
    c = await kiwiChart();
    expect(dept(c, 22)).toMatchObject({ id: newDept, name: "Аналитика" });
    await setArchived(nuraaly, "department", newDept, true);
    c = await kiwiChart();
    expect(c.divisions[0]!.departments.map((d) => d.number)).not.toContain(22);
    const withArchived = (await getOrgChart(nuraaly, { companyId: kiwi, companyUnitId: null }, { includeArchived: true }))!;
    expect(withArchived.divisions[0]!.archivedDepartments.map((d) => d.name)).toEqual(["Аналитика"]);
    expect(await t.handle.db.select().from(orgFunctions).where(eq(orgFunctions.id, fid))).toHaveLength(1);
    await expect(createFunction(nuraaly, { departmentId: newDept, text: "x" })).rejects.toMatchObject({ code: "validation" });
    await assertSortIntegrity(c.id);
  });
});

describe("undo and change log", () => {
  it("undoes the newest change first, one at a time, and logs every undo", async () => {
    const companyId = t.companyIds["marketing"]!;
    let c = await applyVysotskyTemplate(nuraaly, { companyId, companyUnitId: null });
    const scope = { companyId, companyUnitId: null };
    const d4 = c.divisions.find((d) => d.number === 2)!.departments[0]!;
    const d5 = c.divisions.find((d) => d.number === 2)!.departments[1]!;
    const a = await createFunction(nuraaly, { departmentId: d4.id, text: "Контент" });
    await createFunction(nuraaly, { departmentId: d4.id, text: "Реклама" });
    await moveFunction(nuraaly, { functionId: a, departmentId: d5.id, index: 0 });
    await updateFunction(nuraaly, a, { text: "Контент-план" });
    await updateDepartment(nuraaly, d4.id, { name: "Маркетинг и бренд" });
    await setArchived(nuraaly, "department", d4.id, true);
    c = (await getOrgChart(nuraaly, scope))!;
    expect(c.undoAvailable).toBe(6);
    expect(c.undo?.summary).toBe("Archived 4 Маркетинг и бренд");

    expect(await undoLastChange(t.ctx("talant"), c.id)).toBe("Archived 4 Маркетинг и бренд");
    c = (await getOrgChart(nuraaly, scope))!;
    expect(dept(c, 4).name).toBe("Маркетинг и бренд");
    expect(await undoLastChange(nuraaly, c.id)).toMatch(/^Edited 4 Маркетинг: name/);
    c = (await getOrgChart(nuraaly, scope))!;
    expect(dept(c, 4)).toMatchObject({ name: "Маркетинг", nameIsDefault: true });
    await undoLastChange(nuraaly, c.id); // rename back
    expect(fnTexts((await getOrgChart(nuraaly, scope))!, 5)).toEqual(["Контент"]);
    await undoLastChange(nuraaly, c.id); // move back
    c = (await getOrgChart(nuraaly, scope))!;
    expect(fnTexts(c, 4)).toEqual(["Контент", "Реклама"]);
    expect(fnTexts(c, 5)).toEqual([]);
    await undoLastChange(nuraaly, c.id); // create "Реклама" → archived
    await undoLastChange(nuraaly, c.id); // create "Контент" → archived
    c = (await getOrgChart(nuraaly, scope))!;
    expect(fnTexts(c, 4)).toEqual([]);
    expect(c.undo).toBeNull();
    expect(await undoLastChange(nuraaly, c.id)).toBeNull();
    const undos = await t.handle.db.select().from(orgChangeLog).where(and(eq(orgChangeLog.chartId, c.id), eq(orgChangeLog.action, "undo"))).orderBy(asc(orgChangeLog.seq));
    expect(undos).toHaveLength(6);
    expect(undos[0]).toMatchObject({ actorUserId: t.userIds.talant, summary: "Undid: Archived 4 Маркетинг и бренд" });
    expect(c.history[0]).toMatchObject({ action: "undo", actorName: "Nuraaly" });
    expect(c.history.find((h) => h.summary === "Archived 4 Маркетинг и бренд")?.undone).toBe(true);
    await assertSortIntegrity(c.id);
  });

  it("only the last 20 changes can be undone", async () => {
    const companyId = t.companyIds["asqa-zou-holding"]!;
    const c = await applyVysotskyTemplate(nuraaly, { companyId, companyUnitId: null });
    const d = c.divisions[0]!.departments[0]!;
    for (let i = 1; i <= 23; i++) await updateDepartment(nuraaly, d.id, { statistic: `v${i}` });
    let undone = 0;
    while (await undoLastChange(nuraaly, c.id)) undone++;
    expect(undone).toBe(20);
    expect(dept((await getOrgChart(nuraaly, { companyId, companyUnitId: null }))!, d.number).statistic).toBe("v3");
  });
});

describe("company isolation", () => {
  it("refuses moving a function into another company's department and forged ids", async () => {
    const kiwiC = await kiwiChart();
    const job = (await getOrgChart(nuraaly, { companyId: jobutify, companyUnitId: null }))!;
    const fn = dept(kiwiC, 21).functions[0]!;
    await expect(moveFunction(nuraaly, { functionId: fn.id, departmentId: dept(job, 21).id, index: 0 })).rejects.toMatchObject({ code: "not_found" });
    await expect(moveDepartment(nuraaly, { departmentId: dept(kiwiC, 1).id, divisionId: job.divisions[0]!.id, index: 0 })).rejects.toMatchObject({ code: "not_found" });
    await expect(moveFunction(nuraaly, { functionId: fn.id, departmentId: "00000000-0000-4000-8000-000000000000", index: 0 })).rejects.toMatchObject({ code: "not_found" });
    await expect(updateFunction(nuraaly, "not-a-uuid", { text: "x" })).rejects.toMatchObject({ code: "not_found" });
    expect(fnTexts(await kiwiChart(), 21)[0]).toBe(fn.text);
  });

  it("people pickers list only that company's active people; others are refused as head / responsible", async () => {
    const kiwiPeople = await orgPeopleOptions(nuraaly, kiwi);
    const jobPeople = await orgPeopleOptions(nuraaly, jobutify);
    expect(kiwiPeople.map((p) => p.name)).toEqual(["Elmurat", expect.stringMatching(/^Nuraaly/), expect.stringMatching(/^Talant/)]);
    expect(kiwiPeople.map((p) => p.name)).not.toContain("Edil");
    expect(jobPeople.map((p) => p.name)).toContain("Edil");
    const c = await kiwiChart();
    const edil = t.personIds["edil"]!;
    await expect(updateDepartment(nuraaly, dept(c, 1).id, { headPersonId: edil })).rejects.toMatchObject({ code: "validation" });
    await expect(updateDivision(nuraaly, c.divisions[0]!.id, { headPersonId: edil })).rejects.toMatchObject({ code: "validation" });
    await expect(updateFunction(nuraaly, dept(c, 1).functions[0]!.id, { responsiblePersonId: edil })).rejects.toMatchObject({ code: "validation" });
    await updateDepartment(nuraaly, dept(c, 1).id, { headPersonId: t.personIds["elmurat"]! });
    expect(dept(await kiwiChart(), 1).headName).toBe("Elmurat");
    // A person who left (link inactive) is refused too.
    const [p] = await t.handle.db.insert(people).values({ fullName: "Асель Курьерова" }).returning();
    await t.handle.db.insert(personCompanies).values({ personId: p!.id, companyId: kiwi, role: "Courier", isActive: false });
    await expect(updateDepartment(nuraaly, dept(c, 2).id, { headPersonId: p!.id })).rejects.toMatchObject({ code: "validation" });
    expect((await orgPeopleOptions(nuraaly, kiwi)).map((x) => x.id)).not.toContain(p!.id);
  });

  it("a department's linked number must be the company's", async () => {
    const c = await kiwiChart();
    const [jobMetric] = await t.handle.db.select().from(metricDefinitions).where(eq(metricDefinitions.companyId, jobutify)).limit(1);
    const [kiwiMetric] = await t.handle.db.select().from(metricDefinitions).where(eq(metricDefinitions.companyId, kiwi)).limit(1);
    await expect(updateDepartment(nuraaly, dept(c, 7).id, { metricDefinitionId: jobMetric!.id })).rejects.toMatchObject({ code: "validation" });
    await updateDepartment(nuraaly, dept(c, 7).id, { metricDefinitionId: kiwiMetric!.id });
    expect(dept(await kiwiChart(), 7).metricDefinitionId).toBe(kiwiMetric!.id);
  });
});

describe("tasks linked to a department", () => {
  it("accepts a department of the task's company, refuses others, clears it when the company changes", async () => {
    const c = await kiwiChart();
    const job = (await getOrgChart(nuraaly, { companyId: jobutify, companyUnitId: null }))!;
    const task = await createTask(nuraaly, { title: "Нанять 10 курьеров", companyId: kiwi, orgDepartmentId: dept(c, 1).id, dueDate: "2026-10-01" });
    expect(task.orgDepartment).toMatchObject({ number: 1, name: "Найм и ввод в должность" });
    await expect(createTask(nuraaly, { title: "x", companyId: kiwi, orgDepartmentId: dept(job, 1).id })).rejects.toMatchObject({ code: "validation" });
    await expect(createTask(nuraaly, { title: "x", visibility: "private", orgDepartmentId: dept(c, 1).id })).rejects.toMatchObject({ code: "validation" });
    expect((await getOrgChart(nuraaly, { companyId: kiwi, companyUnitId: null }))!.divisions[1]!.departments.find((d) => d.number === 1)).toMatchObject({ openTasks: 1, overdueTasks: 1 });
    const moved = await updateTask(nuraaly, task.id, { companyId: jobutify });
    expect(moved.orgDepartment).toBeNull();
    const options = await orgDepartmentOptionsByCompany(nuraaly);
    expect(options[kiwi]!.map((o) => o.label)).toContain("21 Отдел владельца");
    expect(options[t.companyIds["alura-brand"]!]).toBeUndefined();
  });
});
