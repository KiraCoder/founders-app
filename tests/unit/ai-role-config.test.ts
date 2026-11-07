import { describe, expect, it } from "vitest";
import { ChecksError, defaultChecks, normalizeChecks, ratioCheckSchema } from "@/lib/ai-role-config";
import { firstWeekdayOfMonth, runDueOn, scheduledPeriod, scheduleLabel, summaryLineDueOn } from "@/lib/ai-roles";
import { analyseFinance, analysisChecksFrom, defaultAnalysisChecks, type FinanceInput, type MonthSeries } from "@/server/ai/finance-rules";

const months = ["2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"];
function series(key: string, values: (string | null)[], extra: Partial<MonthSeries> = {}): MonthSeries {
  return {
    metricId: key,
    key,
    name: key,
    label: extra.label ?? key,
    unitSlug: null,
    unit: "KGS",
    direction: "higher_is_better",
    target: null,
    months: Object.fromEntries(months.map((m, i) => [m, values[i] ?? null])),
    everHadData: true,
    ...extra,
  };
}

const input = (s: MonthSeries[], t = { changePct: 20, riskChangePct: 50 }): FinanceInput => ({ companyName: "Kiwi Go", period: "2026-10-01", series: s, thresholds: t });

/** A month with something for every Financial Analyst rule. */
const everything = [
  series("revenue", ["100", "100", "1000", "700"]),
  series("orders_day", ["10", "10", "10", "10"], { unit: "orders" }),
  series("cod_collected", ["100", "100", "100", "100"]),
  series("cod_paid_out", ["100", "100", "100", "40"], { direction: "neutral" }),
  series("intercompany_debt", ["1", "2", "3", "4"], { direction: "lower_is_better" }),
  series("defect_pct", ["2", "2", "2", "4.5"], { unit: "%", direction: "lower_is_better", target: "2" }),
  series("headcount", [null, null, null, null], { everHadData: true }),
  series("never", [null, null, null, null], { everHadData: false }),
];

describe("checks: defaults reproduce the analysis from before the editor", () => {
  it("no checks, the catalogue defaults and explicit default checks give identical findings", () => {
    for (const t of [{ changePct: 20, riskChangePct: 50 }, { changePct: 10, riskChangePct: 30 }, { changePct: 35, riskChangePct: 35 }]) {
      const plain = analyseFinance(input(everything, t));
      expect(plain.length).toBeGreaterThan(5);
      const viaCatalogue = analyseFinance({ ...input(everything, t), checks: analysisChecksFrom("finance", defaultChecks("finance"), t) });
      expect(viaCatalogue).toEqual(plain);
      expect(analysisChecksFrom("finance", defaultChecks("finance"), t)).toEqual(defaultAnalysisChecks(t));
      expect(analysisChecksFrom("finance", normalizeChecks("finance", {}), t)).toEqual(defaultAnalysisChecks(t));
    }
  });

  it("thresholds per check: 3-month average, COD floor, debt months, defect ceiling", () => {
    const t = { changePct: 20, riskChangePct: 50 };
    const ids = (checks: Record<string, unknown>) =>
      analyseFinance({ ...input(everything, t), checks: analysisChecksFrom("finance", normalizeChecks("finance", checks), t) }).map((f) => `${f.id}:${f.severity}`);
    const base = ids({});
    expect(base).toContain("cod_payout:cod_paid_out+cod_collected::risk"); // 40% paid ≤ 100 − 50
    expect(base).toContain("debt_trend:intercompany_debt::risk");
    expect(base.some((i) => i.startsWith("defect_max"))).toBe(false); // off by default
    // COD: warn below 30 → 40% is fine.
    expect(ids({ cod_payout: { enabled: true, warnBelowPct: 30, riskBelowPct: 10 } }).some((i) => i.startsWith("cod_payout"))).toBe(false);
    // COD: risk only below 30 → 40% is a warning.
    expect(ids({ cod_payout: { enabled: true, warnBelowPct: 90, riskBelowPct: 30 } })).toContain("cod_payout:cod_paid_out+cod_collected::warn");
    // Debt: 4 months in a row needs 5 values → none with 4.
    expect(ids({ debt_trend: { enabled: true, months: 4 } }).some((i) => i.startsWith("debt_trend"))).toBe(false);
    // Defect ceiling 3% → 4.5% flagged.
    const withDefect = analyseFinance({ ...input(everything, t), checks: analysisChecksFrom("finance", normalizeChecks("finance", { defect_max: { enabled: true, maxPct: 3 } }), t) });
    expect(withDefect.find((f) => f.rule === "defect_max")?.sentence).toBe("defect_pct was 4.5% in October, above the 3% ceiling.");
    // 3-month average: revenue 700 vs avg 400 (+75%): with its own warn 100% it is no longer a hit.
    const avgOnly = (c: Record<string, unknown>) =>
      analyseFinance({ ...input([series("revenue", ["400", "400", "400", "700"])], t), checks: analysisChecksFrom("finance", normalizeChecks("finance", c), t) });
    expect(avgOnly({}).map((f) => f.sentence)).toEqual(["revenue rose 75% vs September and rose 75% vs the 3-month average (Sep: 400 KGS, Oct: 700 KGS)."]);
    expect(avgOnly({ change_avg: { enabled: true, warnPct: 100, riskPct: 200 } }).map((f) => f.sentence)).toEqual(["revenue rose 75% vs September (Sep: 400 KGS, Oct: 700 KGS)."]);
  });

  it("each check can be turned off", () => {
    const t = { changePct: 20, riskChangePct: 50 };
    const off = Object.fromEntries(Object.keys(defaultChecks("finance")).map((id) => [id, { enabled: false }]));
    expect(analyseFinance({ ...input(everything, t), checks: analysisChecksFrom("finance", normalizeChecks("finance", off), t) })).toEqual([]);
    const noChange = analyseFinance({ ...input(everything, t), checks: analysisChecksFrom("finance", normalizeChecks("finance", { change_prev: { enabled: false }, change_avg: { enabled: false } }), t) });
    expect(noChange.some((f) => f.rule === "change")).toBe(false);
    expect(noChange.some((f) => f.rule === "cod_payout")).toBe(true);
  });

  it("custom roles: generic checks only, ratio between two numbers with min / max", () => {
    const t = { changePct: 10, riskChangePct: 50 };
    const ratio = ratioCheckSchema.parse({ id: "rev-per-order", numeratorKey: "revenue", denominatorKey: "orders_day", min: "80" });
    const f = analyseFinance({ ...input(everything, t), checks: analysisChecksFrom("custom", normalizeChecks("custom", {}), t, [ratio]) });
    expect(f.some((x) => x.rule === "cod_payout" || x.rule === "debt_trend" || x.rule === "ratio")).toBe(false);
    expect(f.find((x) => x.rule === "custom_ratio")?.severity).toBe("warn"); // 700 / 10 = 70 < 80
    const f2 = analyseFinance({ ...input([series("revenue", ["700", "700", "700", "700"]), series("orders_day", ["10", "10", "10", "10"])], t), checks: analysisChecksFrom("custom", normalizeChecks("custom", {}), t, [ratio]) });
    expect(f2.map((x) => x.sentence)).toEqual(["revenue / orders_day was 70 in October, below the minimum of 80."]);
  });

  it("normalizeChecks refuses unknown checks, out-of-range values and risk below warning", () => {
    expect(() => normalizeChecks("finance", { nope: { enabled: true } })).toThrow(ChecksError);
    expect(() => normalizeChecks("finance", { change_avg: { enabled: true, warnPct: 0 } })).toThrow(ChecksError);
    expect(() => normalizeChecks("finance", { change_prev: { enabled: true, warnPct: 30, riskPct: 20 } })).toThrow(/at least/);
    expect(() => normalizeChecks("finance", { debt_trend: { enabled: true, months: 9 } })).toThrow(ChecksError);
    expect(() => normalizeChecks("org_rules", { head_overloaded: { enabled: true, nope: 2 } })).toThrow(ChecksError);
    expect(normalizeChecks("org_rules", { overdue_tasks: { enabled: true, minTasks: 3 } }).overdue_tasks).toEqual({ enabled: true, minTasks: 3 });
  });
});

describe("schedules: monthly day, weekly weekday, off", () => {
  it("monthly is unchanged; weekly runs on the first such weekday of the month; off never", () => {
    expect(scheduledPeriod("2026-11-10", { kind: "monthly", day: 10 })).toBe("2026-10-01");
    expect(scheduledPeriod("2026-11-09", { kind: "monthly", day: 10 })).toBe("2026-09-01");
    expect(firstWeekdayOfMonth("2026-11-01", 1)).toBe("2026-11-02");
    expect(firstWeekdayOfMonth("2026-11-01", 7)).toBe("2026-11-01");
    expect(scheduledPeriod("2026-11-01", { kind: "weekly", weekday: 1 })).toBe("2026-09-01");
    expect(scheduledPeriod("2026-11-02", { kind: "weekly", weekday: 1 })).toBe("2026-10-01");
    expect(runDueOn("2026-10-01", { kind: "weekly", weekday: 1 })).toBe("2026-11-02");
    expect(scheduledPeriod("2026-11-02", { kind: "off" })).toBeNull();
    expect(runDueOn("2026-10-01", { kind: "off" })).toBe("9999-12-31");
    expect(summaryLineDueOn("2026-11-02", { kind: "weekly", weekday: 1 })).toBe(true);
    expect(summaryLineDueOn("2026-11-03", { kind: "weekly", weekday: 1 })).toBe(false);
    expect(summaryLineDueOn("2026-11-03", { kind: "weekly", weekday: 2 })).toBe(true);
    expect(summaryLineDueOn("2026-11-15", { kind: "monthly", day: 15 })).toBe(true);
    expect(summaryLineDueOn("2026-11-02", { kind: "off" })).toBe(false);
    expect(scheduleLabel({ kind: "weekly", weekday: 2 }, "org_rules")).toBe("Weekly on Tuesdays");
    expect(scheduleLabel({ kind: "weekly", weekday: 1 })).toBe("Monthly on the first Monday");
    expect(scheduleLabel({ kind: "off" })).toBe("Off (Run now only)");
  });
});
