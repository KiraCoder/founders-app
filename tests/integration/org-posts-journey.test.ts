/**
 * Org board like the old cockpit: posts on department cards (a person holds it, or it is
 * open — "hiring" + role title; never both) and the journey strip above the board (numbered
 * steps per company, each linked to a department). Founders only, company isolation, logged
 * in the chart's change log, undoable, version-checked.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/db";
import { orgJourneySteps, orgPosts } from "@/server/db/schema";
import {
  applyVysotskyTemplate,
  createPersonAndAssign,
  createPost,
  getOrgChart,
  getOrgChartVersion,
  setArchived,
  setPostArchived,
  undoLastChange,
  updatePost,
  type OrgChartView,
} from "@/server/services/org";
import {
  applyJourneyTemplate,
  createJourneyStep,
  getOrgJourney,
  moveJourneyStep,
  setJourneyStepArchived,
  updateJourneyStep,
} from "@/server/services/org-journey";
import type { ServiceContext } from "@/server/services/context";

let t: TestDb;
let nuraaly: ServiceContext;
let staff: ServiceContext;
let kiwi: string;
let jobutify: string;
let upsell: string;

beforeAll(async () => {
  t = await createTestDb();
  nuraaly = t.ctx("nuraaly");
  staff = { ...nuraaly, user: { ...nuraaly.user, role: "staff" } };
  kiwi = t.companyIds["kiwi-go"]!;
  jobutify = t.companyIds["jobutify"]!;
  upsell = t.companyIds["upsell-group"]!;
  await applyVysotskyTemplate(nuraaly, { companyId: jobutify, companyUnitId: null });
  await applyVysotskyTemplate(nuraaly, { companyId: upsell, companyUnitId: null });
});
afterAll(async () => {
  await t.handle.close();
});

const chartOf = async (companyId: string) => (await getOrgChart(nuraaly, { companyId, companyUnitId: null }))!;
const dept = (c: OrgChartView, n: number) => c.divisions.flatMap((d) => d.departments).find((d) => d.number === n)!;
const postsOf = async (companyId: string, n: number) => dept(await chartOf(companyId), n).posts;
const elmurat = () => t.personIds["elmurat"]!;
const edil = () => t.personIds["edil"]!;

describe("posts", () => {
  it("adds a held post (solid chip: the person's name) and a hiring post (role title), in order, logged", async () => {
    const d5 = dept(await chartOf(kiwi), 5);
    const held = await createPost(nuraaly, { departmentId: d5.id, title: "Менеджер по продажам", personId: elmurat() });
    const open = await createPost(nuraaly, { departmentId: d5.id, title: "Менеджер по продажам", hiring: true, hiringRoleTitle: "Менеджер по продажам (Ош)" });
    const posts = await postsOf(kiwi, 5);
    expect(posts.map((p) => p.id)).toEqual([held, open]);
    expect(posts[0]).toMatchObject({ personId: elmurat(), personName: "Elmurat", hiring: false, hiringRoleTitle: null });
    expect(posts[1]).toMatchObject({ personId: null, hiring: true, hiringRoleTitle: "Менеджер по продажам (Ош)" });
    const c = await chartOf(kiwi);
    expect(c.history[0]).toMatchObject({ action: "create", summary: expect.stringContaining("Added post “Менеджер по продажам” (hiring) to 5 ") });
    expect(c.history[1]!.summary).toContain("(Elmurat)");
  });

  it("person and hiring are exclusive: both at once is refused (schema, service and database); picking one clears the other", async () => {
    const d6 = dept(await chartOf(kiwi), 6);
    await expect(createPost(nuraaly, { departmentId: d6.id, personId: elmurat(), hiring: true, hiringRoleTitle: "X" })).rejects.toMatchObject({ code: "validation" });
    await expect(createPost(nuraaly, { departmentId: d6.id, hiring: true })).rejects.toMatchObject({ code: "validation" });
    const id = await createPost(nuraaly, { departmentId: d6.id, title: "Оператор", hiring: true, hiringRoleTitle: "Оператор приёма" });
    await expect(updatePost(nuraaly, id, { personId: elmurat(), hiring: true })).rejects.toMatchObject({ code: "validation" });
    // Picking a person ends hiring (and drops the role title) …
    await updatePost(nuraaly, id, { personId: elmurat() });
    expect((await postsOf(kiwi, 6)).find((p) => p.id === id)).toMatchObject({ personId: elmurat(), hiring: false, hiringRoleTitle: null });
    // … marking it hiring takes the person off.
    await updatePost(nuraaly, id, { hiring: true, hiringRoleTitle: "Оператор (вечер)" });
    expect((await postsOf(kiwi, 6)).find((p) => p.id === id)).toMatchObject({ personId: null, hiring: true, hiringRoleTitle: "Оператор (вечер)" });
    // The database refuses both too (0027 check).
    await expect(t.handle.db.update(orgPosts).set({ personId: elmurat() }).where(eq(orgPosts.id, id))).rejects.toThrow();
  });

  it("undo takes back a holder change, a removal (back in place) and a new post — one at a time", async () => {
    const d7 = dept(await chartOf(kiwi), 7);
    const a = await createPost(nuraaly, { departmentId: d7.id, title: "Бухгалтер" });
    const b = await createPost(nuraaly, { departmentId: d7.id, title: "Кассир", hiring: true, hiringRoleTitle: "Кассир" });
    await updatePost(nuraaly, b, { personId: elmurat() });
    await setPostArchived(nuraaly, a, true);
    expect((await postsOf(kiwi, 7)).map((p) => p.id)).toEqual([b]);
    const chartId = (await chartOf(kiwi)).id;
    expect(await undoLastChange(nuraaly, chartId)).toMatch(/^Removed post “Бухгалтер”/);
    expect((await postsOf(kiwi, 7)).map((p) => p.id)).toEqual([a, b]);
    expect(await undoLastChange(nuraaly, chartId)).toMatch(/^Elmurat holds post/);
    expect((await postsOf(kiwi, 7)).find((p) => p.id === b)).toMatchObject({ personId: null, hiring: true, hiringRoleTitle: "Кассир" });
    expect(await undoLastChange(nuraaly, chartId)).toMatch(/^Added post “Кассир”/);
    expect((await postsOf(kiwi, 7)).map((p) => p.id)).toEqual([a]);
    const sorts = await t.handle.db.select({ sort: orgPosts.sort }).from(orgPosts).where(and(eq(orgPosts.departmentId, d7.id), isNull(orgPosts.archivedAt)));
    expect(sorts.map((s) => s.sort)).toEqual([0]);
  });

  it("+ New person on a post: creates the person, links them to the company and ends hiring; undo puts the hiring back", async () => {
    const d8 = dept(await chartOf(kiwi), 8);
    const id = await createPost(nuraaly, { departmentId: d8.id, title: "Кассир", hiring: true, hiringRoleTitle: "Кассир COD" });
    const { personId } = await createPersonAndAssign(nuraaly, { target: "post", targetId: id, fullName: "Айдай Кассирова", role: "Кассир COD" });
    expect((await postsOf(kiwi, 8)).find((p) => p.id === id)).toMatchObject({ personId, personFullName: "Айдай Кассирова", hiring: false });
    await undoLastChange(nuraaly, (await chartOf(kiwi)).id);
    expect((await postsOf(kiwi, 8)).find((p) => p.id === id)).toMatchObject({ personId: null, hiring: true, hiringRoleTitle: "Кассир COD" });
  });

  it("company isolation: a person of another company is refused; forged ids are not found", async () => {
    const d1 = dept(await chartOf(kiwi), 1);
    await expect(createPost(nuraaly, { departmentId: d1.id, personId: edil() })).rejects.toMatchObject({ code: "validation" });
    const id = await createPost(nuraaly, { departmentId: d1.id, title: "Рекрутер" });
    await expect(updatePost(nuraaly, id, { personId: edil() })).rejects.toMatchObject({ code: "validation" });
    await expect(updatePost(nuraaly, "00000000-0000-4000-8000-000000000000", { title: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(createPost(nuraaly, { departmentId: "00000000-0000-4000-8000-000000000000", title: "x" })).rejects.toMatchObject({ code: "not_found" });
    // Jobutify's own people are fine on Jobutify's chart (and its posts carry Jobutify's company).
    const jd = dept(await chartOf(jobutify), 5);
    const jp = await createPost(nuraaly, { departmentId: jd.id, personId: edil() });
    const [row] = await t.handle.db.select().from(orgPosts).where(eq(orgPosts.id, jp));
    expect(row).toMatchObject({ companyId: jobutify, chartId: (await chartOf(jobutify)).id });
    // The database keeps a post inside its department's chart / company too.
    await expect(t.handle.db.update(orgPosts).set({ departmentId: d1.id }).where(eq(orgPosts.id, jp))).rejects.toThrow();
  });

  it("founders only; a stale board version is refused with nothing changed; an archived department takes no posts", async () => {
    const c = await chartOf(kiwi);
    const d2 = dept(c, 2);
    await expect(createPost(staff, { departmentId: d2.id, title: "x" })).rejects.toMatchObject({ code: "forbidden" });
    const id = await createPost(nuraaly, { departmentId: d2.id, title: "Диспетчер" }, { expectedVersion: c.version });
    await expect(updatePost(nuraaly, id, { title: "Старший диспетчер" }, { expectedVersion: c.version })).rejects.toMatchObject({ code: "conflict" });
    expect((await postsOf(kiwi, 2)).find((p) => p.id === id)!.title).toBe("Диспетчер");
    const result: { version?: string } = {};
    await updatePost(nuraaly, id, { title: "Старший диспетчер" }, { expectedVersion: await getOrgChartVersion(nuraaly, c.id), result });
    expect(result.version).toBe(await getOrgChartVersion(nuraaly, c.id));
    await expect(updatePost(staff, id, { title: "x" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(setPostArchived(staff, id, true)).rejects.toMatchObject({ code: "forbidden" });
    await setArchived(nuraaly, "department", d2.id, true);
    await expect(createPost(nuraaly, { departmentId: d2.id, title: "y" })).rejects.toMatchObject({ code: "validation" });
    await setArchived(nuraaly, "department", d2.id, false);
    expect((await postsOf(kiwi, 2)).map((p) => p.id)).toContain(id);
  });
});

describe("journey strip", () => {
  it("Upsell Group is offered the Upsell template; applying it adds 01–09 with no departments; once only; undo removes it", async () => {
    const before = await getOrgJourney(nuraaly, upsell);
    expect(before.steps).toEqual([]);
    expect(before.template).toMatchObject({ key: "upsell", label: "Upsell" });
    expect((await getOrgJourney(nuraaly, kiwi)).template).toBeNull();
    const c = await chartOf(upsell);
    await applyJourneyTemplate(nuraaly, c.id, "upsell");
    const j = await getOrgJourney(nuraaly, upsell);
    expect(j.template).toBeNull();
    expect(j.steps.map((s) => `${s.number} ${s.label}`)).toEqual([
      "1 Фабрика найдена",
      "2 Переговоры",
      "3 Образцы",
      "4 Договор",
      "5 Производство",
      "6 Контроль качества",
      "7 Отгрузка",
      "8 Продажи на маркетплейсах",
      "9 Деньги и 5% Upsell",
    ]);
    expect(j.steps.every((s) => s.departmentId === null)).toBe(true);
    await expect(applyJourneyTemplate(nuraaly, c.id, "upsell")).rejects.toMatchObject({ code: "validation" });
    expect(await undoLastChange(nuraaly, c.id)).toBe("Applied the Upsell journey template (9 steps)");
    expect((await getOrgJourney(nuraaly, upsell)).steps).toEqual([]);
    await applyJourneyTemplate(nuraaly, c.id, "upsell");
    expect((await getOrgJourney(nuraaly, upsell)).steps).toHaveLength(9);
  });

  it("adds, renames, reorders (numbers follow) and removes steps; every change is logged and undoable", async () => {
    const c = await chartOf(kiwi);
    const a = await createJourneyStep(nuraaly, c.id, { label: "Заказ принят" });
    const b = await createJourneyStep(nuraaly, c.id, { label: "Курьер назначен" });
    const d = await createJourneyStep(nuraaly, c.id, { label: "Доставлено" });
    const labels = async () => (await getOrgJourney(nuraaly, kiwi)).steps.map((s) => `${s.number} ${s.label}`);
    expect(await labels()).toEqual(["1 Заказ принят", "2 Курьер назначен", "3 Доставлено"]);
    await updateJourneyStep(nuraaly, c.id, a, { label: "Заказ оформлен" });
    await moveJourneyStep(nuraaly, c.id, { stepId: d, index: 0 });
    expect(await labels()).toEqual(["1 Доставлено", "2 Заказ оформлен", "3 Курьер назначен"]);
    await setJourneyStepArchived(nuraaly, c.id, b, true);
    expect(await labels()).toEqual(["1 Доставлено", "2 Заказ оформлен"]);
    const history = (await chartOf(kiwi)).history.slice(0, 3).map((h) => h.summary);
    expect(history).toEqual(["Removed journey step “Курьер назначен”", "Moved journey step “Доставлено” from 3 to 1", "Renamed journey step “Заказ принят” to “Заказ оформлен”"]);
    await undoLastChange(nuraaly, c.id);
    expect(await labels()).toEqual(["1 Доставлено", "2 Заказ оформлен", "3 Курьер назначен"]);
    await undoLastChange(nuraaly, c.id);
    expect(await labels()).toEqual(["1 Заказ оформлен", "2 Курьер назначен", "3 Доставлено"]);
    await undoLastChange(nuraaly, c.id);
    expect(await labels()).toEqual(["1 Заказ принят", "2 Курьер назначен", "3 Доставлено"]);
    const rows = await t.handle.db.select({ sort: orgJourneySteps.sort, number: orgJourneySteps.number }).from(orgJourneySteps).where(and(eq(orgJourneySteps.companyId, kiwi), isNull(orgJourneySteps.archivedAt)));
    expect(rows.map((r) => r.sort).sort()).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.number).sort()).toEqual([1, 2, 3]);
  });

  it("links a step to a department of the company (and unlinks it); another company's department is refused", async () => {
    const c = await chartOf(kiwi);
    const step = (await getOrgJourney(nuraaly, kiwi)).steps[0]!;
    await updateJourneyStep(nuraaly, c.id, step.id, { departmentId: dept(c, 6).id });
    expect((await getOrgJourney(nuraaly, kiwi)).steps[0]).toMatchObject({ departmentId: dept(c, 6).id, departmentLabel: `6 ${dept(c, 6).name}` });
    expect((await chartOf(kiwi)).history[0]!.summary).toBe(`Linked journey step “${step.label}” to 6 ${dept(c, 6).name}`);
    const job = await chartOf(jobutify);
    await expect(updateJourneyStep(nuraaly, c.id, step.id, { departmentId: dept(job, 6).id })).rejects.toMatchObject({ code: "validation" });
    await expect(createJourneyStep(nuraaly, c.id, { label: "x", departmentId: dept(job, 6).id })).rejects.toMatchObject({ code: "validation" });
    await updateJourneyStep(nuraaly, c.id, step.id, { departmentId: null });
    expect((await getOrgJourney(nuraaly, kiwi)).steps[0]!.departmentId).toBeNull();
    await undoLastChange(nuraaly, c.id);
    expect((await getOrgJourney(nuraaly, kiwi)).steps[0]!.departmentId).toBe(dept(c, 6).id);
  });

  it("company isolation, founders only and version checks", async () => {
    const kiwiC = await chartOf(kiwi);
    const job = await chartOf(jobutify);
    const kiwiStep = (await getOrgJourney(nuraaly, kiwi)).steps[0]!;
    // A Kiwi step changed through Jobutify's board is "not found".
    await expect(updateJourneyStep(nuraaly, job.id, kiwiStep.id, { label: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(moveJourneyStep(nuraaly, job.id, { stepId: kiwiStep.id, index: 2 })).rejects.toMatchObject({ code: "not_found" });
    await expect(setJourneyStepArchived(nuraaly, job.id, kiwiStep.id, true)).rejects.toMatchObject({ code: "not_found" });
    // A step added on Jobutify's board belongs to Jobutify.
    await createJourneyStep(nuraaly, job.id, { label: "Лид" });
    expect((await getOrgJourney(nuraaly, jobutify)).steps.map((s) => s.label)).toEqual(["Лид"]);
    expect((await getOrgJourney(nuraaly, kiwi)).steps.map((s) => s.label)).not.toContain("Лид");
    // Founders only.
    await expect(createJourneyStep(staff, kiwiC.id, { label: "x" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(applyJourneyTemplate(staff, (await chartOf(upsell)).id, "upsell")).rejects.toMatchObject({ code: "forbidden" });
    // A staff account cannot see company data at all.
    await expect(getOrgJourney(staff, kiwi)).rejects.toMatchObject({ code: "not_found" });
    // Stale version refused, nothing changed.
    const stale = kiwiC.version;
    await createJourneyStep(nuraaly, kiwiC.id, { label: "Возврат" });
    await expect(updateJourneyStep(nuraaly, kiwiC.id, kiwiStep.id, { label: "Нельзя" }, { expectedVersion: stale })).rejects.toMatchObject({ code: "conflict" });
    expect((await getOrgJourney(nuraaly, kiwi)).steps[0]!.label).toBe(kiwiStep.label);
    // Validation.
    await expect(createJourneyStep(nuraaly, kiwiC.id, { label: "  " })).rejects.toMatchObject({ code: "validation" });
    await expect(applyJourneyTemplate(nuraaly, kiwiC.id, "nope" as "upsell")).rejects.toMatchObject({ code: "validation" });
  });
});
