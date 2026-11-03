import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { composeRequests, orchestrateTick } from "@/server/ai/orchestrator";
import type { LlmGenerateInput, LlmProvider } from "@/server/ai/provider";
import { aiRoleConfigs, aiRoleHires, aiRoleSettingsLog, metricDefinitions } from "@/server/db/schema";
import { createCustomRole, listHireVersions, listRoleVersions, revertHire, revertRole, updateRoleConfig } from "@/server/services/ai-role-editor";
import { collectAiRequests, getHire, getRun, hireRole, listRoles, rerunReport, runHireNow, updateHire } from "@/server/services/ai-roles";
import type { ServiceContext } from "@/server/services/context";
import { saveMetricGrid } from "@/server/services/metrics";
import { orgExpertHires, orgExpertSummaryLines } from "@/server/services/org-expert";
import { applyVysotskyTemplate, orgExpertForCompany } from "@/server/services/org";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let kiwi: string;
let brand: string;
const staff = (): ServiceContext => ({ ...t.ctx("nuraaly"), user: { ...t.founders.nuraaly, id: crypto.randomUUID(), role: "staff" } });

async function metricId(companyId: string, key: string): Promise<string> {
  const [row] = await t.handle.db
    .select({ id: metricDefinitions.id })
    .from(metricDefinitions)
    .where(and(eq(metricDefinitions.companyId, companyId), eq(metricDefinitions.key, key)));
  return row!.id;
}
async function enter(companyId: string, values: Record<string, Record<string, string>>) {
  const cells: { metricId: string; period: string; value: string }[] = [];
  for (const [key, byMonth] of Object.entries(values)) for (const [m, v] of Object.entries(byMonth)) cells.push({ metricId: await metricId(companyId, key), period: m, value: v });
  const r = await saveMetricGrid(t.ctx("nuraaly"), companyId, cells);
  expect(r.errors).toEqual([]);
}

beforeAll(async () => {
  t = await createTestDb();
  kiwi = t.companyIds["kiwi-go"]!;
  brand = t.companyIds["alura-brand"]!;
  // Pay data in a company's numbers (for the salary guard).
  await t.handle.db.insert(metricDefinitions).values([
    { companyId: kiwi, key: "payroll_fund", name: "Payroll fund", unit: "KGS", granularity: "month" },
    { companyId: kiwi, key: "staff_cost", name: "Зарплата офиса", unit: "KGS", granularity: "month" },
  ]);
  // Revenue: 1 200 000 → 1 080 000 (−10 %); sales / orders to factory for the ratio check.
  await enter(kiwi, { revenue: { "2026-07": "1200000", "2026-08": "1200000", "2026-09": "1200000", "2026-10": "1080000" }, payroll_fund: { "2026-09": "500", "2026-10": "900" } });
  await enter(brand, { sales: { "2026-09": "100000", "2026-10": "90000" }, orders_to_factory: { "2026-09": "100", "2026-10": "150" } });
});
afterAll(async () => {
  await t.handle.close();
});

describe("custom role: create → hire → run → report (same pipeline)", () => {
  let roleKey: string;
  let hireId: string;
  it("a founder creates a Kiwi Go role watching revenue with a 10% threshold; it reports the finding", async () => {
    const role = await createCustomRole(t.ctx("nuraaly"), {
      companyId: kiwi,
      config: {
        profile: { name: "Revenue watcher", description: "Watches revenue", responsibilities: ["Flag revenue moves"], instructions: "Be brief." },
        watchedMetricKeys: ["revenue"],
        checks: { change_prev: { enabled: true, warnPct: 10, riskPct: 50 } },
      },
    });
    roleKey = role.key;
    expect(role).toMatchObject({ custom: true, engine: "custom", name: "Revenue watcher", companyId: kiwi, watchedMetricKeys: ["revenue"], version: 1 });
    expect((await listRoles(t.ctx("talant"))).map((r) => r.name)).toContain("Revenue watcher");
    const hire = await hireRole(t.ctx("talant"), { templateKey: roleKey, companyId: kiwi });
    hireId = hire.id;
    expect(hire).toMatchObject({ roleName: "Revenue watcher", custom: true, scheduleLabel: "Monthly on the 10th" });
    expect(hire.settings.thresholds).toEqual({ changePct: 10, riskChangePct: 50 });
    expect(hire.settings.requiredMetricKeys).toEqual(["revenue"]);
    const run = await runHireNow(t.ctx("nuraaly"), hire.id);
    expect(run.status).toBe("reported");
    expect(run.findings.map((f) => `${f.severity}: ${f.sentence}`)).toEqual(["warn: Revenue fell 10% vs September and fell 10% vs the 3-month average (Sep: 1 200 000 KGS, Oct: 1 080 000 KGS)."]);
    // Only the watched number is analysed (no COD, no other Kiwi Go numbers, no pay data).
    expect(run.inputs!.metrics.map((m) => m.key)).toEqual(["revenue"]);
    expect(run.hire.roleName).toBe("Revenue watcher");
  });

  it("a role-level edit marks the report 'Settings changed'; Run again re-analyses; revert restores", async () => {
    const before = await listRoleVersions(t.ctx("nuraaly"), roleKey);
    expect(before.map((v) => v.action)).toEqual(["create"]);
    const role = await updateRoleConfig(t.ctx("talant"), roleKey, {
      profile: { name: "Revenue watcher", description: "Watches revenue" },
      watchedMetricKeys: ["revenue"],
      checks: { change_prev: { enabled: true, warnPct: 10, riskPct: 50 }, change_avg: { enabled: false } },
    });
    expect(role.version).toBe(2);
    const [runId] = [(await getHire(t.ctx("nuraaly"), hireId)).latestRun!.id];
    expect(await getRun(t.ctx("nuraaly"), runId)).toMatchObject({ settingsChanged: true, inputsChanged: false });
    const rerun = await rerunReport(t.ctx("nuraaly"), runId);
    expect(rerun.settingsChanged).toBe(false);
    expect(rerun.findings.map((f) => f.sentence)).toEqual(["Revenue fell 10% vs September (Sep: 1 200 000 KGS, Oct: 1 080 000 KGS)."]);
    const reverted = await revertRole(t.ctx("nuraaly"), roleKey, 1);
    expect(reverted.version).toBe(3);
    expect(reverted.checks.change_avg!.enabled).toBe(true);
    const versions = await listRoleVersions(t.ctx("nuraaly"), roleKey);
    expect(versions.map((v) => [v.version, v.action, v.revertedTo, v.byName])).toEqual([
      [3, "revert", 1, "Nuraaly"],
      [2, "edit", null, "Talant"],
      [1, "create", null, "Nuraaly"],
    ]);
    expect(versions[1]!.changed).toEqual(["checks", "profile"]);
    expect(versions[1]!.before).toMatchObject({ profile: { instructions: "Be brief." } });
    expect(await getRun(t.ctx("nuraaly"), runId)).toMatchObject({ settingsChanged: true });
  });

  it("per-hire overrides (name, checks), each logged; revert a hire; clearing goes back to the role's", async () => {
    const h = await updateHire(t.ctx("nuraaly"), hireId, {
      settings: { profile: { name: "Kiwi revenue", instructions: "Mention COD." }, checks: { change_prev: { enabled: false }, change_avg: { enabled: true } } },
    });
    expect(h.roleName).toBe("Kiwi revenue");
    expect(h.instructions).toBe("Mention COD.");
    expect(h.checks.change_prev!.enabled).toBe(false);
    const v = await listHireVersions(t.ctx("talant"), hireId);
    expect(v.map((x) => x.action)).toEqual(["edit", "create"]);
    const back = await revertHire(t.ctx("talant"), hireId, 1);
    expect(back.roleName).toBe("Revenue watcher");
    expect(back.checks.change_prev!.enabled).toBe(true);
    expect(back.settings.checks).toBeUndefined();
    expect((await listHireVersions(t.ctx("talant"), hireId)).map((x) => [x.action, x.revertedTo])).toEqual([["revert", 1], ["edit", null], ["create", null]]);
  });

  it("data requests: one grouped line per role and founder (same anti-spam pipeline)", async () => {
    const role = await createCustomRole(t.ctx("nuraaly"), {
      companyId: kiwi,
      config: { profile: { name: "Courier watcher" }, watchedMetricKeys: ["revenue", "couriers_active", "on_time_pct"], schedule: { kind: "monthly", day: 1 } },
    });
    const hire = await hireRole(t.ctx("nuraaly"), { templateKey: role.key, companyId: kiwi });
    await orchestrateTick(t.handle.db, t.ctx("nuraaly").now);
    await orchestrateTick(t.handle.db, t.ctx("nuraaly").now);
    const items = (await collectAiRequests(t.ctx("nuraaly"))).filter((i) => i.hireId === hire.id);
    expect(items).toHaveLength(1);
    const composed = composeRequests(items, [], null);
    expect(composed.aiLines.map((l) => l.text)).toEqual([
      "AI roles · numbers needed",
      "Courier watcher needs October 2026 numbers for Kiwi Go: On-time delivery, Active couriers — enter by hand or upload until the data source is connected: /companies/kiwi-go?tab=numbers&g=day",
    ]);
  });
});

describe("custom ratio checks, isolation, founders only", () => {
  it("ratio between two chosen numbers with a minimum", async () => {
    const role = await createCustomRole(t.ctx("talant"), {
      companyId: brand,
      config: {
        profile: { name: "Sales per order" },
        watchedMetricKeys: ["sales", "orders_to_factory"],
        checks: { change_prev: { enabled: false }, change_avg: { enabled: false } },
        ratioChecks: [{ id: "sales-per-piece", numeratorKey: "sales", denominatorKey: "orders_to_factory", min: "800", max: null }],
      },
    });
    const hire = await hireRole(t.ctx("talant"), { templateKey: role.key, companyId: brand });
    const run = await runHireNow(t.ctx("talant"), hire.id);
    expect(run.findings.map((f) => f.sentence)).toEqual(["Sales / Orders to factory was 600 in October, below the minimum of 800."]);
  });

  it("isolation: another company's numbers, hiring for another company, ratios of unwatched numbers are refused", async () => {
    await expect(createCustomRole(t.ctx("nuraaly"), { companyId: kiwi, config: { profile: { name: "X" }, watchedMetricKeys: ["sales"] } })).rejects.toMatchObject({ code: "validation" });
    const role = await createCustomRole(t.ctx("nuraaly"), { companyId: kiwi, config: { profile: { name: "Kiwi only" }, watchedMetricKeys: ["revenue"] } });
    await expect(hireRole(t.ctx("nuraaly"), { templateKey: role.key, companyId: brand })).rejects.toMatchObject({ code: "validation" });
    await expect(
      updateRoleConfig(t.ctx("nuraaly"), role.key, {
        profile: { name: "Kiwi only" },
        watchedMetricKeys: ["revenue"],
        ratioChecks: [{ id: "r", numeratorKey: "revenue", denominatorKey: "orders_day", min: "1" }],
      }),
    ).rejects.toMatchObject({ code: "validation" });
    // A built-in role has no watched numbers of its own.
    await expect(updateRoleConfig(t.ctx("nuraaly"), "financial-analyst", { watchedMetricKeys: ["revenue"] })).rejects.toMatchObject({ code: "validation" });
    await expect(updateRoleConfig(t.ctx("nuraaly"), "no-such-role", {})).rejects.toMatchObject({ code: "not_found" });
  });

  it("founders only: staff can neither read nor change roles or versions", async () => {
    await expect(listRoles(staff())).rejects.toMatchObject({ code: "forbidden" });
    await expect(createCustomRole(staff(), { companyId: kiwi, config: { profile: { name: "S" }, watchedMetricKeys: ["revenue"] } })).rejects.toMatchObject({ code: "forbidden" });
    await expect(updateRoleConfig(staff(), "financial-analyst", {})).rejects.toMatchObject({ code: "forbidden" });
    await expect(listRoleVersions(staff(), "financial-analyst")).rejects.toMatchObject({ code: "forbidden" });
    await expect(revertRole(staff(), "financial-analyst", 1)).rejects.toMatchObject({ code: "forbidden" });
    await expect(revertHire(staff(), crypto.randomUUID(), 1)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("salary guard: a custom role can never watch pay data", () => {
  it("refuses pay-named numbers (by key or by name), allows the piecework total", async () => {
    for (const key of ["payroll_fund", "staff_cost"]) {
      await expect(createCustomRole(t.ctx("nuraaly"), { companyId: kiwi, config: { profile: { name: "Pay" }, watchedMetricKeys: ["revenue", key] } })).rejects.toMatchObject({
        code: "validation",
        message: expect.stringContaining("pay data"),
      });
    }
    // Copying the Financial Analyst never brings pay data along either.
    const copy = await createCustomRole(t.ctx("nuraaly"), { companyId: kiwi, copyFrom: "financial-analyst", config: {} });
    expect(copy.watchedMetricKeys).toEqual(["revenue", "orders_day", "cod_collected", "cod_paid_out"]);
    expect(copy.name).toBe("Financial Analyst (copy)");
    const style = t.companyIds["alura-style"]!;
    const piece = await createCustomRole(t.ctx("nuraaly"), { companyId: style, config: { profile: { name: "Piecework" }, watchedMetricKeys: ["piecework_total", "output_pcs"] } });
    expect(piece.watchedMetricKeys).toEqual(["piecework_total", "output_pcs"]);
  });

  it("even a forged config never analyses pay data, and instructions naming salaries never reach a provider", async () => {
    const role = await createCustomRole(t.ctx("nuraaly"), { companyId: kiwi, config: { profile: { name: "Forged", instructions: "Compare with the зарплата of each courier" }, watchedMetricKeys: ["revenue"] } });
    // Written behind the service's back: the run-time filter still drops the pay number.
    await t.handle.db.update(aiRoleConfigs).set({ config: { profile: { name: "Forged", instructions: "Compare with the зарплата of each courier" }, watchedMetricKeys: ["revenue", "payroll_fund"] } }).where(eq(aiRoleConfigs.key, role.key));
    const hire = await hireRole(t.ctx("nuraaly"), { templateKey: role.key, companyId: kiwi, settings: { requiredMetricKeys: ["revenue"] } });
    const prompts: LlmGenerateInput[] = [];
    const provider: LlmProvider = { id: "capture", configured: true, generate: async (p) => (prompts.push(p), { text: "ok", usage: { inputTokens: 1, outputTokens: 1 } }) };
    const run = await runHireNow(t.ctx("nuraaly"), hire.id, { provider });
    expect(run.inputs!.metrics.map((m) => m.key)).toEqual(["revenue"]);
    expect(JSON.stringify(run.findings)).not.toMatch(/payroll|Payroll/);
    expect(run.narrativeStatus).toBe("narrative_skipped:salary");
    expect(prompts).toHaveLength(0);
  });
});

describe("salary guard: the is_pay_data flag (C5b #3)", () => {
  it("a number flagged as pay data is refused for a custom role whatever its name; seeded numbers keep their flag", async () => {
    await t.handle.db.insert(metricDefinitions).values({ companyId: kiwi, key: "fund_a", name: "Fund A", unit: "KGS", granularity: "month", isPayData: true });
    await expect(createCustomRole(t.ctx("nuraaly"), { companyId: kiwi, config: { profile: { name: "Fund" }, watchedMetricKeys: ["revenue", "fund_a"] } })).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("pay data"),
    });
    const flags = await t.handle.db.select({ key: metricDefinitions.key, pay: metricDefinitions.isPayData }).from(metricDefinitions).where(eq(metricDefinitions.isPayData, true));
    expect(flags.map((f) => f.key)).toEqual(["fund_a"]); // the seed has no pay data; piecework_total stays allowed
    // Name-only variants the old list missed are refused too.
    await t.handle.db.insert(metricDefinitions).values([
      { companyId: kiwi, key: "staff_pay", name: "З/П сотрудников", unit: "KGS", granularity: "month" },
      { companyId: kiwi, key: "fotTotal", name: "Total", unit: "KGS", granularity: "month" },
      { companyId: kiwi, key: "comp", name: "Compensation", unit: "KGS", granularity: "month" },
      { companyId: kiwi, key: "zar", name: "Зар. плата", unit: "KGS", granularity: "month" },
    ]);
    for (const key of ["staff_pay", "fotTotal", "comp", "zar"]) {
      await expect(createCustomRole(t.ctx("nuraaly"), { companyId: kiwi, config: { profile: { name: "Pay" }, watchedMetricKeys: [key] } }), key).rejects.toMatchObject({ code: "validation" });
    }
  });
});

describe("built-in roles: template-level edits, defaults unchanged", () => {
  it("a Financial Analyst hire without edits keeps its report hash; a role-level check change is 'Settings changed'", async () => {
    const hire = await hireRole(t.ctx("nuraaly"), { templateKey: "financial-analyst", companyId: brand });
    const run = await runHireNow(t.ctx("nuraaly"), hire.id);
    expect(run.status).toBe("reported");
    // Saving the defaults explicitly changes nothing.
    await updateHire(t.ctx("nuraaly"), hire.id, { settings: { checks: { change_prev: { enabled: true }, cod_payout: { enabled: true } } } });
    expect(await getRun(t.ctx("nuraaly"), run.id)).toMatchObject({ settingsChanged: false, inputsChanged: false });
    await updateHire(t.ctx("nuraaly"), hire.id, { settings: { checks: null } });
    // The role's name and a check default change for every hire that did not override them.
    await updateRoleConfig(t.ctx("talant"), "financial-analyst", { profile: { name: "Finance brain" }, checks: { change_avg: { enabled: false } } });
    const h = await getHire(t.ctx("nuraaly"), hire.id);
    expect(h.roleName).toBe("Finance brain");
    expect(h.checks.change_avg!.enabled).toBe(false);
    expect(await getRun(t.ctx("nuraaly"), run.id)).toMatchObject({ settingsChanged: true });
    await revertRole(t.ctx("talant"), "financial-analyst", 1);
    const versions = await listRoleVersions(t.ctx("talant"), "financial-analyst");
    expect(versions.map((v) => v.action)).toEqual(["revert", "edit"]);
    // Version 1 here is the first edit; reverting to it keeps the edit — revert to "nothing" by saving {}.
    await updateRoleConfig(t.ctx("talant"), "financial-analyst", {});
    expect((await getHire(t.ctx("nuraaly"), hire.id)).roleName).toBe("Financial Analyst");
    expect(await getRun(t.ctx("nuraaly"), run.id)).toMatchObject({ settingsChanged: false });
    const log = await t.handle.db.select().from(aiRoleSettingsLog).where(eq(aiRoleSettingsLog.scopeKey, "role:financial-analyst"));
    expect(log).toHaveLength(3);
  });

  it("Org Structure Expert: checks off, overdue threshold and the line's weekday", async () => {
    const ctx = t.ctx("nuraaly");
    const jobutify = t.companyIds["jobutify"]!;
    await applyVysotskyTemplate(ctx, { companyId: jobutify, companyUnitId: null });
    const hire = await hireRole(ctx, { templateKey: "org-structure-expert", companyId: jobutify });
    expect(hire.scheduleLabel).toBe("Weekly on Mondays");
    const rules = async () => (await orgExpertForCompany(ctx, jobutify, (await orgExpertHires(ctx)).find((h) => h.companyId === jobutify)!.options)).flatMap((r) => r.findings.map((f) => f.rule));
    expect(await rules()).toContain("department_no_head");
    await updateHire(ctx, hire.id, { settings: { schedule: { kind: "weekly", weekday: 2 }, checks: { department_no_head: { enabled: false }, division_no_head: { enabled: false } } } });
    expect(await rules()).not.toContain("department_no_head");
    expect(await rules()).not.toContain("division_no_head");
    expect((await getHire(ctx, hire.id)).scheduleLabel).toBe("Weekly on Tuesdays");
    const monday = await orgExpertSummaryLines(t.ctx("nuraaly", new Date("2026-11-09T06:00:00Z")));
    const tuesday = await orgExpertSummaryLines(t.ctx("nuraaly", new Date("2026-11-10T06:00:00Z")));
    expect(monday).toEqual([]);
    expect(tuesday).toHaveLength(1);
    expect(tuesday[0]!.text).toContain("Org Structure Expert (weekly): Jobutify");
    await updateHire(ctx, hire.id, { settings: { schedule: { kind: "off" } } });
    expect(await orgExpertSummaryLines(t.ctx("nuraaly", new Date("2026-11-10T06:00:00Z")))).toEqual([]);
    // "Monthly on day 1" is kept as chosen (C5b #4): not turned into weekly Mondays.
    await updateHire(ctx, hire.id, { settings: { schedule: { kind: "monthly", day: 1 } } });
    const saved = await getHire(ctx, hire.id);
    expect(saved.settings.schedule).toEqual({ kind: "monthly", day: 1 });
    expect(saved.scheduleLabel).toBe("Monthly on the 1st");
    expect((await orgExpertHires(ctx)).find((h) => h.companyId === jobutify)!.schedule).toEqual({ kind: "monthly", day: 1 });
    expect(await orgExpertSummaryLines(t.ctx("nuraaly", new Date("2026-11-09T06:00:00Z")))).toEqual([]); // a Monday
    const first = await orgExpertSummaryLines(t.ctx("nuraaly", new Date("2026-12-01T06:00:00Z"))); // the 1st
    expect(first).toHaveLength(1);
    expect(first[0]!.text).toContain("Org Structure Expert (monthly): Jobutify");
  });
});

describe("revert: a version that is not a positive integer is 'not found', never a 500 (C5b #5)", () => {
  it("role and hire", async () => {
    const [hire] = await t.handle.db.select({ id: aiRoleHires.id }).from(aiRoleHires).limit(1);
    expect(hire).toBeTruthy();
    for (const bad of ["abc", "", "1.5", "1e3", "-1", 0, -1, 1.5, Number.NaN, Infinity, 2 ** 40, "99999999999", null, undefined, {}, [1]]) {
      await expect(revertRole(t.ctx("nuraaly"), "financial-analyst", bad as never), String(bad)).rejects.toMatchObject({ code: "not_found", message: "Version not found" });
      await expect(revertHire(t.ctx("nuraaly"), hire!.id, bad as never), String(bad)).rejects.toMatchObject({ code: "not_found", message: "Version not found" });
    }
    // A well-formed number that does not exist is also "not found"; digits as text work.
    await expect(revertRole(t.ctx("nuraaly"), "financial-analyst", 9999)).rejects.toMatchObject({ code: "not_found" });
    await expect(revertRole(t.ctx("nuraaly"), "financial-analyst", "1" as never)).resolves.toBeTruthy();
  });
});
