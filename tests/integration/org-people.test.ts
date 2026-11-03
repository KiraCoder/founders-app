/**
 * People on the org board: "+ New person" (create, link to the company, assign — one step,
 * founders only, logged, undoable without deleting the person), names on the board, a
 * person's org positions, and the Org Structure Expert on real people.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/db";
import { orgChangeLog, people, personCompanies } from "@/server/db/schema";
import {
  applyVysotskyTemplate,
  createPersonAndAssign,
  getOrgChart,
  orgExpertForCompany,
  orgPeopleOptions,
  orgPositionsForPeople,
  orgPositionsForPerson,
  setArchived,
  undoLastChange,
  updateDepartment,
  updateDivision,
  updateFunction,
  type OrgChartView,
} from "@/server/services/org";
import { getPerson, markPersonLeft } from "@/server/services/people";
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

const chartOf = async (companyId: string, unitId: string | null = null) => (await getOrgChart(nuraaly, { companyId, companyUnitId: unitId }))!;
const dept = (c: OrgChartView, n: number) => c.divisions.flatMap((d) => d.departments).find((d) => d.number === n)!;
const peopleCount = async () => (await t.handle.db.select({ id: people.id }).from(people)).length;
const findPerson = async (fullName: string) => (await t.handle.db.select().from(people).where(eq(people.fullName, fullName)))[0];

describe("+ New person: create, link and assign in one step", () => {
  it("makes a new person head of a department: person + company link (role = department name) + assignment + one log row", async () => {
    const c = await chartOf(kiwi);
    const d1 = dept(c, 1);
    const { personId } = await createPersonAndAssign(nuraaly, {
      target: "department",
      targetId: d1.id,
      fullName: "Тест Курьеров",
      shortName: "Тест",
      phone: "+996 555 12 34 56",
      telegramHandle: "@test_kurierov",
      role: d1.name,
    });
    const person = await getPerson(nuraaly, personId);
    expect(person).toMatchObject({ fullName: "Тест Курьеров", shortName: "Тест", phone: "+996 555 12 34 56", telegramHandle: "test_kurierov" });
    expect(person.roles).toEqual([expect.objectContaining({ companyId: kiwi, role: "Найм и ввод в должность", isActive: true, unitName: null })]);
    const after = await chartOf(kiwi);
    expect(dept(after, 1)).toMatchObject({ headPersonId: personId, headName: "Тест", headFullName: "Тест Курьеров" });
    expect(after.history[0]).toMatchObject({ action: "update", summary: "Added new person Тест Курьеров as head of 1 Найм и ввод в должность", actorName: "Nuraaly" });
    expect((await orgPeopleOptions(nuraaly, kiwi)).map((p) => p.id)).toContain(personId);
  });

  it("assigns a function's responsible person and a division head; names (full and short) are on the chart", async () => {
    const c = await chartOf(kiwi);
    const fn = dept(c, 2).functions[0]!;
    const { personId } = await createPersonAndAssign(t.ctx("talant"), { target: "function", targetId: fn.id, fullName: "Айгуль Маршрутова", role: fn.text });
    const div = c.divisions.find((d) => d.number === 2)!;
    const head = await createPersonAndAssign(nuraaly, { target: "division", targetId: div.id, fullName: "Бакыт Продажин", shortName: "Бакыт", role: "Коммерческий директор" });
    const after = await chartOf(kiwi);
    expect(dept(after, 2).functions[0]).toMatchObject({ responsiblePersonId: personId, responsibleName: "Айгуль Маршрутова", responsibleFullName: "Айгуль Маршрутова" });
    expect(after.divisions.find((d) => d.number === 2)).toMatchObject({ headPersonId: head.personId, headName: "Бакыт", headFullName: "Бакыт Продажин" });
    const link = await t.handle.db.select().from(personCompanies).where(eq(personCompanies.personId, personId));
    expect(link).toEqual([expect.objectContaining({ companyId: kiwi, role: fn.text })]);
  });

  it("undo takes back the assignment only: the person and their company link stay", async () => {
    const c = await chartOf(kiwi);
    const d3 = dept(c, 3);
    const before = d3.headPersonId;
    const { personId } = await createPersonAndAssign(nuraaly, { target: "department", targetId: d3.id, fullName: "Отменённый Руководитель", role: d3.name });
    expect(await undoLastChange(nuraaly, c.id)).toBe("Added new person Отменённый Руководитель as head of 3 Инспекции и статистики");
    expect(dept(await chartOf(kiwi), 3).headPersonId).toBe(before);
    expect(await findPerson("Отменённый Руководитель")).toMatchObject({ id: personId, leftAt: null });
    expect(await t.handle.db.select().from(personCompanies).where(and(eq(personCompanies.personId, personId), eq(personCompanies.companyId, kiwi)))).toHaveLength(1);
    expect(await orgPositionsForPerson(nuraaly, personId)).toEqual([]);
  });

  it("a unit's chart links the person to that unit", async () => {
    const units = await t.handle.db.query.companyUnits.findMany();
    const hbk = units.find((u) => u.slug === "hbk")!;
    const style = t.companyIds["alura-style"]!;
    const c = await applyVysotskyTemplate(nuraaly, { companyId: style, companyUnitId: hbk.id });
    const { personId } = await createPersonAndAssign(nuraaly, { target: "department", targetId: dept(c, 11).id, fullName: "Швея Старшая", role: "Производство" });
    expect((await getPerson(nuraaly, personId)).roles[0]).toMatchObject({ companyId: style, unitName: hbk.name });
    expect(dept(await chartOf(style, hbk.id), 11).headPersonId).toBe(personId);
  });

  it("founders only; forged / other-company ids are not found; bad input, archived targets or a stale version create nobody", async () => {
    const c = await chartOf(kiwi);
    const d4 = dept(c, 4);
    const n = await peopleCount();
    const staff: ServiceContext = { ...nuraaly, user: { ...nuraaly.user, role: "staff" } };
    await expect(createPersonAndAssign(staff, { target: "department", targetId: d4.id, fullName: "Нельзя", role: "x" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      createPersonAndAssign(nuraaly, { target: "department", targetId: "00000000-0000-4000-8000-000000000000", fullName: "Никто", role: "x" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(createPersonAndAssign(nuraaly, { target: "department", targetId: d4.id, fullName: "  ", role: "x" })).rejects.toMatchObject({ code: "validation" });
    await expect(createPersonAndAssign(nuraaly, { target: "department", targetId: d4.id, fullName: "Без роли", role: "" })).rejects.toMatchObject({ code: "validation" });
    await expect(createPersonAndAssign(nuraaly, { target: "function", targetId: d4.functions[0]!.id, fullName: "Плохой телефон", phone: "abc", role: "x" })).rejects.toMatchObject({
      code: "validation",
    });
    await expect(
      createPersonAndAssign(nuraaly, { target: "department", targetId: d4.id, fullName: "Старая версия", role: "x" }, { expectedVersion: String(Number(c.version) - 1) }),
    ).rejects.toMatchObject({ code: "conflict" });
    // Archived department: refused inside the transaction, so the person is not created either.
    await setArchived(nuraaly, "department", d4.id, true);
    await expect(createPersonAndAssign(nuraaly, { target: "department", targetId: d4.id, fullName: "В архив", role: "x" })).rejects.toMatchObject({ code: "validation" });
    await setArchived(nuraaly, "department", d4.id, false);
    expect(await peopleCount()).toBe(n);
    // Company isolation: the person is linked to the TARGET's company (Jobutify), never to Kiwi Go.
    const job = await applyVysotskyTemplate(nuraaly, { companyId: t.companyIds["jobutify"]!, companyUnitId: null });
    const { personId } = await createPersonAndAssign(nuraaly, { target: "department", targetId: dept(job, 1).id, fullName: "Джоб Рекрутер", role: "HR" });
    const links = await t.handle.db.select().from(personCompanies).where(eq(personCompanies.personId, personId));
    expect(links.map((l) => l.companyId)).toEqual([t.companyIds["jobutify"]]);
    await expect(updateDepartment(nuraaly, dept(c, 5).id, { headPersonId: personId })).rejects.toMatchObject({ code: "validation" });
    expect(await t.handle.db.select().from(orgChangeLog).where(eq(orgChangeLog.summary, "Added new person Нельзя as head of 4 Маркетинг"))).toHaveLength(0);
  });
});

describe("a person's org positions (People pages)", () => {
  it("lists division head, department head and functions with company and division", async () => {
    const c = await chartOf(kiwi);
    const tk = (await findPerson("Тест Курьеров"))!;
    await updateFunction(nuraaly, dept(c, 1).functions[0]!.id, { responsiblePersonId: tk.id });
    await updateDivision(nuraaly, c.divisions.find((d) => d.number === 1)!.id, { headPersonId: tk.id });
    const positions = await orgPositionsForPerson(nuraaly, tk.id);
    expect(positions).toEqual([
      expect.objectContaining({ kind: "division_head", companyName: "Kiwi Go", companySlug: "kiwi-go", division: "1 Персонал", department: null, function: null }),
      expect.objectContaining({ kind: "department_head", division: "1 Персонал", department: "1 Найм и ввод в должность", function: null }),
      expect.objectContaining({ kind: "function", division: "1 Персонал", department: "1 Найм и ввод в должность", function: dept(c, 1).functions[0]!.text }),
    ]);
    const many = await orgPositionsForPeople(nuraaly, [tk.id, t.personIds["edil"]!]);
    expect(many[tk.id]).toHaveLength(3);
    expect(many[t.personIds["edil"]!]).toBeUndefined();
    // A staff account cannot see company data at all.
    const staff: ServiceContext = { ...nuraaly, user: { ...nuraaly.user, role: "staff" } };
    expect(await orgPositionsForPerson(staff, tk.id)).toEqual([]);
  });
});

describe("Org Structure Expert on real people", () => {
  it("re-evaluates after an assignment and counts departments per real person", async () => {
    const companyId = t.companyIds["marketing"]!;
    const c = await applyVysotskyTemplate(nuraaly, { companyId, companyUnitId: null });
    const findings = async () => (await orgExpertForCompany(nuraaly, companyId)).find((r) => r.chartId === c.id)!.findings;
    const noHead = async () => (await findings()).find((f) => f.rule === "department_no_head")?.count ?? 0;
    expect(await noHead()).toBe(21);
    const { personId } = await createPersonAndAssign(nuraaly, { target: "department", targetId: dept(c, 1).id, fullName: "Мульти Руководитель", shortName: "Мульти", role: "Руководитель" });
    expect(await noHead()).toBe(20);
    for (const n of [2, 3, 4]) await updateDepartment(nuraaly, dept(c, n).id, { headPersonId: personId });
    expect((await findings()).find((f) => f.rule === "head_overloaded")).toBeUndefined();
    await updateDepartment(nuraaly, dept(c, 5).id, { headPersonId: personId });
    expect((await findings()).find((f) => f.rule === "head_overloaded")).toMatchObject({ text: "Мульти (5) heads more than 4 departments", items: ["Мульти (5)"] });
    // Someone who left is not a real head any more: their departments count as without a head.
    await markPersonLeft(nuraaly, personId);
    expect((await findings()).find((f) => f.rule === "head_overloaded")).toBeUndefined();
    expect(await noHead()).toBe(21);
  });
});
