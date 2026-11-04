import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/db";
import { clientProjects, companies, orgDepartments, orgFunctions, orgJourneySteps, orgPosts, people } from "@/server/db/schema";
import {
  boardByStage,
  clientProjectTotals,
  createClientProject,
  getClientProject,
  listClientProjects,
  listPartnerJourney,
  setClientProjectArchived,
  updateClientProject,
} from "@/server/services/client-projects";
import { applyVysotskyTemplate } from "@/server/services/org";
import type { ServiceContext } from "@/server/services/context";

let t: TestDb;
let jobutify: string;
let kiwi: string;
let upsell: string;
let nuraaly: ServiceContext;
let talant: ServiceContext;
let staff: ServiceContext;

beforeAll(async () => {
  t = await createTestDb();
  jobutify = t.companyIds["jobutify"]!;
  kiwi = t.companyIds["kiwi-go"]!;
  upsell = t.companyIds["upsell-group"]!;
  nuraaly = t.ctx("nuraaly");
  talant = t.ctx("talant");
  staff = { ...t.ctx("nuraaly"), user: { ...t.founders.nuraaly, role: "staff" } };
});
afterAll(async () => {
  await t.handle.close();
});

describe("client projects: CRUD", () => {
  it("creates with defaults, exact fee text and an upper-case currency", async () => {
    const p = await createClientProject(nuraaly, jobutify, {
      clientName: "  Globus  ",
      title: "WMS rollout",
      slaMonthlyFee: "12 500,50",
      slaCurrency: "usd",
      dueDate: "2026-12-01",
      slaResponseHours: "4",
    });
    expect(p).toMatchObject({
      companyId: jobutify,
      clientName: "Globus",
      stage: "lead",
      status: "on_track",
      slaMonthlyFee: "12500.5",
      slaCurrency: "USD",
      slaResponseHours: 4,
      dueDate: "2026-12-01",
      archived: false,
    });
    const [row] = await t.handle.db.select().from(clientProjects).where(eq(clientProjects.id, p.id));
    expect(row!.slaMonthlyFee).toBe("12500.50");
    expect(await getClientProject(talant, jobutify, p.id)).toEqual(p);
  });

  it("validates input (Zod): required fields, enums, fee format, currency, date order, unknown keys", async () => {
    await expect(createClientProject(nuraaly, jobutify, { clientName: "", title: "x" })).rejects.toMatchObject({ code: "validation" });
    await expect(createClientProject(nuraaly, jobutify, { clientName: "A", title: "x", stage: "won" })).rejects.toMatchObject({ code: "validation" });
    await expect(createClientProject(nuraaly, jobutify, { clientName: "A", title: "x", slaMonthlyFee: "1.234" })).rejects.toMatchObject({
      code: "validation",
    });
    await expect(createClientProject(nuraaly, jobutify, { clientName: "A", title: "x", slaMonthlyFee: "-5" })).rejects.toMatchObject({ code: "validation" });
    await expect(createClientProject(nuraaly, jobutify, { clientName: "A", title: "x", slaCurrency: "SOMS" })).rejects.toMatchObject({ code: "validation" });
    await expect(
      createClientProject(nuraaly, jobutify, { clientName: "A", title: "x", startDate: "2026-12-10", dueDate: "2026-12-01" }),
    ).rejects.toMatchObject({ code: "validation", fields: { dueDate: expect.any(Array) } });
    await expect(createClientProject(nuraaly, jobutify, { clientName: "A", title: "x", companyId: kiwi })).rejects.toMatchObject({ code: "validation" });
  });

  it("updates only the fields sent; blank clears; checks the date order against stored dates", async () => {
    const p = await createClientProject(nuraaly, jobutify, { clientName: "Narodny", title: "Integration", startDate: "2026-11-01", notes: "n" });
    const u = await updateClientProject(nuraaly, jobutify, p.id, { stage: "build", status: "at_risk", notes: "" });
    expect(u).toMatchObject({ stage: "build", status: "at_risk", notes: null, clientName: "Narodny", startDate: "2026-11-01" });
    await expect(updateClientProject(nuraaly, jobutify, p.id, { dueDate: "2026-10-01" })).rejects.toMatchObject({ code: "validation" });
    expect(await updateClientProject(nuraaly, jobutify, p.id, {})).toEqual(u);
  });

  it("archives instead of deleting, hides archived from the list, restores", async () => {
    const p = await createClientProject(nuraaly, jobutify, { clientName: "Old client", title: "Legacy" });
    const a = await setClientProjectArchived(nuraaly, jobutify, p.id, true);
    expect(a.archived).toBe(true);
    expect((await listClientProjects(nuraaly, jobutify)).some((x) => x.id === p.id)).toBe(false);
    expect((await listClientProjects(nuraaly, jobutify, { includeArchived: true })).some((x) => x.id === p.id)).toBe(true);
    await expect(updateClientProject(nuraaly, jobutify, p.id, { title: "x" })).rejects.toMatchObject({ code: "conflict" });
    const [row] = await t.handle.db.select().from(clientProjects).where(eq(clientProjects.id, p.id));
    expect(row).toBeDefined();
    expect((await setClientProjectArchived(nuraaly, jobutify, p.id, false)).archived).toBe(false);
  });
});

describe("client projects: access", () => {
  it("is founders only (reads and writes)", async () => {
    const p = await createClientProject(nuraaly, jobutify, { clientName: "Staff test", title: "x" });
    await expect(listClientProjects(staff, jobutify)).rejects.toMatchObject({ code: "forbidden" });
    await expect(getClientProject(staff, jobutify, p.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(createClientProject(staff, jobutify, { clientName: "A", title: "x" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(updateClientProject(staff, jobutify, p.id, { title: "y" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(setClientProjectArchived(staff, jobutify, p.id, true)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("keeps companies apart: another company's id never reaches the project", async () => {
    const p = await createClientProject(nuraaly, jobutify, { clientName: "Isolated", title: "x" });
    await expect(getClientProject(nuraaly, kiwi, p.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(updateClientProject(nuraaly, kiwi, p.id, { title: "hijack" })).rejects.toMatchObject({ code: "not_found" });
    await expect(setClientProjectArchived(nuraaly, kiwi, p.id, true)).rejects.toMatchObject({ code: "not_found" });
    expect((await listClientProjects(nuraaly, kiwi)).some((x) => x.id === p.id)).toBe(false);
    expect((await getClientProject(nuraaly, jobutify, p.id)).title).toBe("x");
  });

  it("treats malformed ids and archived companies as not found", async () => {
    await expect(listClientProjects(nuraaly, "not-a-uuid")).rejects.toMatchObject({ code: "not_found" });
    await expect(getClientProject(nuraaly, jobutify, "nope")).rejects.toMatchObject({ code: "not_found" });
    const marketing = t.companyIds["marketing"]!;
    await t.handle.db.update(companies).set({ archivedAt: new Date() }).where(eq(companies.id, marketing));
    try {
      await expect(createClientProject(nuraaly, marketing, { clientName: "A", title: "x" })).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await t.handle.db.update(companies).set({ archivedAt: null }).where(eq(companies.id, marketing));
    }
  });
});

describe("client projects: totals and board", () => {
  it("sums monthly SLA revenue of live projects exactly, per currency; counts active and at-risk", async () => {
    const company = t.companyIds["asqa-zou-holding"]!;
    const mk = (x: Record<string, unknown>) => createClientProject(nuraaly, company, { clientName: "C", title: "T", ...x });
    await mk({ stage: "live_sla", slaMonthlyFee: "0.10", slaCurrency: "KGS" });
    await mk({ stage: "live_sla", slaMonthlyFee: "0.20", slaCurrency: "KGS" });
    await mk({ stage: "live_sla", slaMonthlyFee: "9999999999.99", slaCurrency: "KGS" });
    await mk({ stage: "live_sla", slaMonthlyFee: "1500", slaCurrency: "USD", status: "late" });
    await mk({ stage: "build", slaMonthlyFee: "700", status: "at_risk" }); // not live: no SLA revenue yet
    await mk({ stage: "paused", status: "at_risk" }); // not active
    await mk({ stage: "closed", slaMonthlyFee: "50" });
    const archived = await mk({ stage: "live_sla", slaMonthlyFee: "1000", status: "at_risk" });
    await setClientProjectArchived(nuraaly, company, archived.id, true);

    const list = await listClientProjects(nuraaly, company, { includeArchived: true });
    const totals = clientProjectTotals(list);
    expect(totals).toEqual({
      active: 5,
      monthlySla: [
        { currency: "KGS", amount: "10000000000.29" },
        { currency: "USD", amount: "1500" },
      ],
      atRisk: 1,
      late: 1,
    });
    // 0.1 + 0.2 in floats would be 0.30000000000000004
    expect(clientProjectTotals(list.filter((p) => p.slaMonthlyFee === "0.1" || p.slaMonthlyFee === "0.2")).monthlySla).toEqual([
      { currency: "KGS", amount: "0.3" },
    ]);

    const board = boardByStage(list.filter((p) => !p.archived));
    expect(board.map((c) => c.stage)).toEqual(["lead", "discovery", "build", "implementation", "live_sla", "paused", "closed"]);
    expect(board.find((c) => c.stage === "live_sla")!.items).toHaveLength(4);
  });

  it("lists in pipeline order", async () => {
    const list = await listClientProjects(nuraaly, t.companyIds["asqa-zou-holding"]!);
    const order = ["lead", "discovery", "build", "implementation", "live_sla", "paused", "closed"];
    const idx = list.map((p) => order.indexOf(p.stage));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });
});

describe("partner journey (read-only)", () => {
  it("lists steps in order with the distinct active people of each step's department", async () => {
    const chart = await applyVysotskyTemplate(nuraaly, { companyId: upsell, companyUnitId: null });
    const depts = chart.divisions.flatMap((d) => d.departments);
    const [d1, d2] = [depts[0]!, depts[1]!];
    const [a, b, gone] = await t.handle.db
      .insert(people)
      .values([{ fullName: "Aibek Partner" }, { fullName: "Bakyt Partner", shortName: "Bakyt" }, { fullName: "Gone Partner", leftAt: new Date() }])
      .returning();
    await t.handle.db.update(orgDepartments).set({ headPersonId: a!.id }).where(eq(orgDepartments.id, d1.id));
    await t.handle.db.insert(orgPosts).values([
      { chartId: chart.id, companyId: upsell, departmentId: d1.id, personId: a!.id, title: "dup" },
      { chartId: chart.id, companyId: upsell, departmentId: d1.id, personId: b!.id, title: "Manager" },
      { chartId: chart.id, companyId: upsell, departmentId: d1.id, personId: gone!.id, title: "Left" },
      { chartId: chart.id, companyId: upsell, departmentId: d1.id, hiring: true, hiringRoleTitle: "Open" },
    ]);
    const fn = d2.functions[0];
    if (fn) await t.handle.db.update(orgFunctions).set({ responsiblePersonId: b!.id }).where(eq(orgFunctions.id, fn.id));
    await t.handle.db.insert(orgJourneySteps).values([
      { companyId: upsell, number: 2, label: "Onboarding", departmentId: d2.id, sort: 1 },
      { companyId: upsell, number: 1, label: "First contact", departmentId: d1.id, sort: 0 },
      { companyId: upsell, number: 3, label: "Repeat orders", departmentId: null, sort: 2 },
      { companyId: upsell, number: 4, label: "Archived step", sort: 3, archivedAt: new Date() },
      // Another company's step never shows up here.
      { companyId: kiwi, number: 1, label: "Kiwi step", sort: 0 },
    ]);

    const steps = await listPartnerJourney(talant, upsell);
    expect(steps.map((s) => s.label)).toEqual(["First contact", "Onboarding", "Repeat orders"]);
    expect(steps[0]!.partners.map((p) => p.name)).toEqual(["Aibek Partner", "Bakyt"]);
    expect(steps[1]!.partners.map((p) => p.name)).toEqual(fn ? ["Bakyt"] : []);
    expect(steps[2]).toMatchObject({ departmentId: null, departmentName: null, partners: [] });
  });

  it("follows the company rule", async () => {
    await expect(listPartnerJourney(staff, upsell)).rejects.toMatchObject({ code: "not_found" });
    await expect(listPartnerJourney(nuraaly, "bad")).rejects.toMatchObject({ code: "not_found" });
  });
});
