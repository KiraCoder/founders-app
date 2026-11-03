/**
 * Monthly totals for daily numbers: a founder enters one value for a daily number and a
 * month (period_kind = month_total). An AI role hire with acceptMonthlyTotals (default true
 * for a new Financial Analyst — the founders' decision; it can be switched off)
 * uses it when the days are incomplete; complete days always win; the value never mixes into
 * the daily series, freshness or the grid's day rows.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { periodsInMonth } from "@/server/ai/month-values";
import { composeMorningRequests, orchestrateTick } from "@/server/ai/orchestrator";
import type { Db } from "@/server/db/connect";
import { metricDefinitions, metricValues } from "@/server/db/schema";
import {
  collectAiRequests,
  enterMonthTotalForRun,
  getRun,
  hireRole,
  runHireNow,
  updateHire,
  type HireView,
} from "@/server/services/ai-roles";
import type { ServiceContext } from "@/server/services/context";
import {
  currentValues,
  listCompanyMetricCards,
  listMetricValues,
  recordMonthTotal,
  saveMetricGrid,
  writeMetricValueTx,
} from "@/server/services/metrics";
import { createTestDb, type TestDb } from "../helpers/db";

const bishkek = (day: string, hm: string) => new Date(`${day}T${hm}:00+06:00`);
let t: TestDb;
let kiwi: string;
let jobutify: string;

async function metricId(companyId: string, key: string): Promise<string> {
  const [row] = await t.handle.db
    .select({ id: metricDefinitions.id })
    .from(metricDefinitions)
    .where(and(eq(metricDefinitions.companyId, companyId), eq(metricDefinitions.key, key)));
  return row!.id;
}

const ctx = (day = "2026-11-02", hm = "12:00"): ServiceContext => t.ctx("nuraaly", bishkek(day, hm));
const staff = (): ServiceContext => ({ ...ctx(), user: { ...t.founders.nuraaly, id: crypto.randomUUID(), role: "staff" } });

/** Enters `days` days of October for a daily number (all of October by default). */
async function enterDays(key: string, value: string, days = periodsInMonth("2026-10-01", "day")) {
  const id = await metricId(kiwi, key);
  const r = await saveMetricGrid(ctx(), kiwi, days.map((d) => ({ metricId: id, period: d, value })));
  expect(r.errors).toEqual([]);
}

let hire: HireView;

beforeAll(async () => {
  t = await createTestDb();
  kiwi = t.companyIds["kiwi-go"]!;
  jobutify = t.companyIds["jobutify"]!;
  hire = await hireRole(ctx(), {
    templateKey: "financial-analyst",
    companyId: kiwi,
    // Switched off on purpose: the first tests are about the "off" behaviour.
    settings: { requiredMetricKeys: ["revenue", "orders_day", "on_time_pct", "cod_collected"], askUserIds: [t.userIds.nuraaly], acceptMonthlyTotals: false },
  });
  // Revenue (monthly) is complete; the daily numbers have only 10 of 31 days.
  const r = await saveMetricGrid(ctx(), kiwi, [{ metricId: await metricId(kiwi, "revenue"), period: "2026-10", value: "1500000" }]);
  expect(r.errors).toEqual([]);
  const tenDays = periodsInMonth("2026-10-01", "day").slice(0, 10);
  await enterDays("orders_day", "100", tenDays);
  await enterDays("on_time_pct", "90", tenDays);
  await enterDays("cod_collected", "5000", tenDays);
}, 60_000);
afterAll(async () => {
  await t.handle.close();
});

describe("default for a new hire", () => {
  it("a new Financial Analyst hire accepts monthly totals unless the wizard says otherwise", async () => {
    const tt = await createTestDb();
    try {
      const c = tt.ctx("nuraaly", bishkek("2026-11-02", "12:00"));
      const h = await hireRole(c, { templateKey: "financial-analyst", companyId: tt.companyIds["kiwi-go"]! });
      expect(h.settings.acceptMonthlyTotals).toBe(true);
      const off = await hireRole(c, { templateKey: "financial-analyst", companyId: tt.companyIds["jobutify"]!, settings: { acceptMonthlyTotals: false } });
      expect(off.settings.acceptMonthlyTotals).toBe(false);
    } finally {
      await tt.handle.close();
    }
  });
});

describe("acceptMonthlyTotals off", () => {
  it("a hire with the switch off ignores entered month totals", async () => {
    expect(hire.settings.acceptMonthlyTotals).toBe(false);
    await recordMonthTotal(ctx(), await metricId(kiwi, "orders_day"), { month: "2026-10", value: "3100" });
    const run = await runHireNow(ctx(), hire.id);
    expect(run.status).toBe("waiting_for_data");
    expect(run.missing.map((m) => [m.key, m.detail])).toEqual([
      ["orders_day", "21 of 31 days missing"],
      ["on_time_pct", "21 of 31 days missing"],
      ["cod_collected", "21 of 31 days missing"],
    ]);
    expect(run.monthTotalEntry).toEqual({});
    await expect(enterMonthTotalForRun(ctx(), run.id, await metricId(kiwi, "on_time_pct"), "95")).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("Accept monthly totals"),
    });
  });
});

describe("acceptMonthlyTotals on", () => {
  it("names what can be entered and lets the report's missing list take a month value", async () => {
    hire = await updateHire(ctx(), hire.id, { settings: { acceptMonthlyTotals: true } });
    expect(hire.settings.acceptMonthlyTotals).toBe(true);
    let run = await runHireNow(ctx(), hire.id);
    // orders_day has a month total → used; the others are still missing, with the hint.
    expect(run.missing.map((m) => [m.key, m.detail])).toEqual([
      ["on_time_pct", "21 of 31 days missing — or enter the month average"],
      ["cod_collected", "21 of 31 days missing — or enter the month total"],
    ]);
    const onTime = await metricId(kiwi, "on_time_pct");
    const cod = await metricId(kiwi, "cod_collected");
    expect(run.monthTotalEntry).toEqual({ [onTime]: "average", [cod]: "total" });

    // Another company's metric (isolation) and a number the run is not missing are refused.
    await expect(enterMonthTotalForRun(ctx(), run.id, await metricId(jobutify, "wms_orders_day"), "5")).rejects.toMatchObject({ code: "validation" });
    await expect(enterMonthTotalForRun(ctx(), run.id, await metricId(kiwi, "revenue"), "5")).rejects.toMatchObject({ code: "validation" });

    run = await enterMonthTotalForRun(ctx(), run.id, onTime, "95.55");
    expect(run.status).toBe("waiting_for_data");
    run = await enterMonthTotalForRun(ctx(), run.id, cod, "1234567.89");
    expect(run.status).toBe("reported");

    // Numbers used: exact decimals, marked per month and kind of value.
    const row = (key: string) => run.inputs!.metrics.find((m) => m.key === key)!;
    const oct = run.inputs!.months.indexOf("2026-10-01");
    expect(row("orders_day").values[oct]).toBe("3100");
    expect(row("orders_day").label).toBe("Orders (month total)");
    expect(row("orders_day").fromMonthTotal![oct]).toBe(true);
    expect(row("orders_day").monthTotalMark).toBe("(month total entered)");
    expect(row("on_time_pct").values[oct]).toBe("95.55");
    expect(row("on_time_pct").monthTotalMark).toBe("(month average entered)");
    expect(row("cod_collected").values[oct]).toBe("1234567.89");
    expect(row("revenue").fromMonthTotal).toBeUndefined();
    expect(row("cod_paid_out").values[oct]).toBeNull(); // no days, no total: still "—"
  });

  it("complete days win over an entered month total", async () => {
    await enterDays("orders_day", "100"); // every day of October now
    const run = await runHireNow(ctx(), hire.id);
    const orders = run.inputs!.metrics.find((m) => m.key === "orders_day")!;
    const oct = run.inputs!.months.indexOf("2026-10-01");
    expect(orders.values[oct]).toBe("3100"); // the days' sum, not the total
    expect(orders.fromMonthTotal?.[oct] ?? false).toBe(false);
    // Change the month total to something else: the days still win.
    await recordMonthTotal(ctx(), await metricId(kiwi, "orders_day"), { month: "2026-10-01", value: "9999" });
    const again = await getRun(ctx(), run.id);
    expect(again.inputsChanged).toBe(false);
  });

  it("turning the switch on after a report says Settings changed (off keeps old reports' hash)", async () => {
    const tt = await createTestDb();
    try {
      const k = tt.companyIds["kiwi-go"]!;
      const c = tt.ctx("nuraaly", bishkek("2026-11-02", "12:00"));
      const [rev] = await tt.handle.db
        .select({ id: metricDefinitions.id })
        .from(metricDefinitions)
        .where(and(eq(metricDefinitions.companyId, k), eq(metricDefinitions.key, "revenue")));
      const h = await hireRole(c, { templateKey: "financial-analyst", companyId: k, settings: { requiredMetricKeys: ["revenue"], acceptMonthlyTotals: false } });
      await saveMetricGrid(c, k, [{ metricId: rev!.id, period: "2026-10", value: "100" }]);
      const run = await runHireNow(c, h.id);
      expect(run.status).toBe("reported");
      expect(run.settingsChanged).toBe(false);
      await updateHire(c, h.id, { settings: { acceptMonthlyTotals: true } });
      expect((await getRun(c, run.id)).settingsChanged).toBe(true);
      await updateHire(c, h.id, { settings: { acceptMonthlyTotals: false } });
      expect((await getRun(c, run.id)).settingsChanged).toBe(false);
    } finally {
      await tt.handle.close();
    }
  });
});

describe("month totals before the window (never entered vs 2+ months missing)", () => {
  it("off: an earlier month total alone is still 'never entered' (info); on: it counts as earlier data (warn)", async () => {
    const tt = await createTestDb();
    try {
      const k = tt.companyIds["kiwi-go"]!;
      const c = tt.ctx("nuraaly", bishkek("2026-11-02", "12:00"));
      const idOf = async (key: string) =>
        (
          await tt.handle.db
            .select({ id: metricDefinitions.id })
            .from(metricDefinitions)
            .where(and(eq(metricDefinitions.companyId, k), eq(metricDefinitions.key, key)))
        )[0]!.id;
      const h = await hireRole(c, { templateKey: "financial-analyst", companyId: k, settings: { requiredMetricKeys: ["revenue"], acceptMonthlyTotals: false } });
      await saveMetricGrid(c, k, [{ metricId: await idOf("revenue"), period: "2026-10", value: "100" }]);
      // On-time % (a daily number): no days ever, only a month total long before the window.
      await recordMonthTotal(c, await idOf("on_time_pct"), { month: "2025-06", value: "90" });
      const flags = (run: { findings: { id: string; rule: string; metricKeys?: string[] }[] }) => ({
        never: run.findings.some((f) => f.rule === "never_entered" && f.metricKeys?.includes("on_time_pct")),
        missing: run.findings.some((f) => f.rule === "missing" && f.id.startsWith("missing:on_time_pct:")),
      });

      const off = await runHireNow(c, h.id);
      expect(off.status).toBe("reported");
      expect(flags(off)).toEqual({ never: true, missing: false });

      await updateHire(c, h.id, { settings: { acceptMonthlyTotals: true } });
      const on = await runHireNow(c, h.id);
      expect(on.status).toBe("reported");
      expect(flags(on)).toEqual({ never: false, missing: true });
    } finally {
      await tt.handle.close();
    }
  });
});

describe("storage rules", () => {
  it("latest wins per metric + month, history kept; never part of the daily series, freshness or the grid", async () => {
    const id = await metricId(kiwi, "cod_paid_out");
    await recordMonthTotal(ctx(), id, { month: "2026-09", value: "100.10" });
    const second = await recordMonthTotal(ctx(), id, { month: "2026-09-15", value: "200.20" });
    expect(second).toMatchObject({ action: "updated", month: "2026-09-01", value: 200.2 });
    const rows = await t.handle.db
      .select()
      .from(metricValues)
      .where(and(eq(metricValues.metricId, id), eq(metricValues.periodKind, "month_total")));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.isCurrent).map((r) => r.value)).toEqual(["200.2000"]);
    // A daily value for 1 September is a separate row (its own kind).
    await saveMetricGrid(ctx(), kiwi, [{ metricId: id, period: "2026-09-01", value: "7" }]);
    expect((await currentValues(t.handle.db, [id], { from: "2026-09-01", to: "2026-09-30" })).get(`${id}|2026-09-01`)).toBe(7);
    expect((await currentValues(t.handle.db, [id], { from: "2026-09-01", to: "2026-09-30" }, "month_total")).get(`${id}|2026-09-01`)).toBe(200.2);
    // History list, cards and freshness only see the day.
    expect((await listMetricValues(ctx(), id)).map((v) => v.value)).toEqual([7]);
    const card = (await listCompanyMetricCards(ctx(), kiwi)).find((c) => c.id === id)!;
    expect(card.latest).toMatchObject({ period: "2026-09-01", value: 7 });
    expect(card.series.some((p) => p.value === 200.2)).toBe(false);
  });

  it("month totals are for daily numbers and finished months only; the grid takes them with kind month_total", async () => {
    const revenue = await metricId(kiwi, "revenue");
    await expect(recordMonthTotal(ctx(), revenue, { month: "2026-10", value: "1" })).rejects.toMatchObject({ code: "validation" });
    const orders = await metricId(kiwi, "orders_day");
    await expect(recordMonthTotal(ctx(), orders, { month: "2026-11", value: "1" })).rejects.toMatchObject({ code: "validation" });
    const r = await saveMetricGrid(ctx(), kiwi, [
      { metricId: orders, period: "2026-08", value: "2 500,5", kind: "month_total" },
      { metricId: revenue, period: "2026-08", value: "5", kind: "month_total" },
    ]);
    expect(r.created).toBe(1);
    expect(r.errors.map((e) => e.metricId)).toEqual([revenue]);
    expect((await currentValues(t.handle.db, [orders], { from: "2026-08-01", to: "2026-08-31" }, "month_total")).get(`${orders}|2026-08-01`)).toBe(2500.5);
    expect((await currentValues(t.handle.db, [orders], { from: "2026-08-01", to: "2026-08-31" })).has(`${orders}|2026-08-01`)).toBe(false);
    // The DB itself keeps month totals on the 1st.
    await expect(
      t.handle.db.insert(metricValues).values({ metricId: orders, periodStart: "2026-08-15", value: "1", source: "manual", periodKind: "month_total" }),
    ).rejects.toBeTruthy();
  });

  it("company isolation: another company's grid, a staff user", async () => {
    const orders = await metricId(kiwi, "orders_day");
    const r = await saveMetricGrid(ctx(), jobutify, [{ metricId: orders, period: "2026-08", value: "1", kind: "month_total" }]);
    expect(r.errors).toEqual([expect.objectContaining({ message: "Metric not found in this company" })]);
    await expect(recordMonthTotal(staff(), orders, { month: "2026-08", value: "1" })).rejects.toMatchObject({ code: expect.stringMatching(/forbidden|not_found/) });
  });

  it("a connector never touches a month total", async () => {
    const orders = await metricId(kiwi, "orders_day");
    const before = (await currentValues(t.handle.db, [orders], { from: "2026-08-01", to: "2026-08-31" }, "month_total")).get(`${orders}|2026-08-01`);
    await t.handle.db.transaction((tx) =>
      writeMetricValueTx(tx as unknown as Db, orders, "2026-08-01", 42, { source: "connector", enteredBy: null, now: new Date() }),
    );
    expect((await currentValues(t.handle.db, [orders], { from: "2026-08-01", to: "2026-08-31" }, "month_total")).get(`${orders}|2026-08-01`)).toBe(before);
    expect((await currentValues(t.handle.db, [orders], { from: "2026-08-01", to: "2026-08-31" })).get(`${orders}|2026-08-01`)).toBe(42);
  });
});

describe("data request wording", () => {
  it("says 'enter the October total (or every day)' for a role that accepts monthly totals", async () => {
    const tt = await createTestDb();
    try {
      const k = tt.companyIds["kiwi-go"]!;
      const c = (day: string) => tt.ctx("nuraaly", bishkek(day, "08:00"));
      const h = await hireRole(c("2026-11-02"), {
        templateKey: "financial-analyst",
        companyId: k,
        settings: { requiredMetricKeys: ["orders_day"], askUserIds: [tt.userIds.nuraaly], acceptMonthlyTotals: true },
      });
      await orchestrateTick(tt.handle.db, bishkek("2026-11-10", "08:00"));
      const [item] = await collectAiRequests(c("2026-11-10"));
      expect(item).toMatchObject({ acceptMonthlyTotals: true, missing: [expect.objectContaining({ key: "orders_day", granularity: "day", aggregation: "sum" })] });
      let composed = await composeMorningRequests(c("2026-11-10"), { waiting: [], holding: null });
      expect(composed.aiLines[1]!.text).toContain("Orders per day — enter the October total (or every day) until the data source is connected:");
      // Off: today's wording.
      await updateHire(c("2026-11-10"), h.id, { settings: { acceptMonthlyTotals: false } });
      composed = await composeMorningRequests(c("2026-11-10"), { waiting: [], holding: null });
      expect(composed.aiLines[1]!.text).toContain("Orders per day — enter by hand or upload until the data source is connected:");
    } finally {
      await tt.handle.close();
    }
  });
});
