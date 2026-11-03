import { describe, expect, it } from "vitest";
import { chaseDueToday, firstPeriodFor, monthsLabel, runDueOn, scheduledPeriod, scheduleLabel, hireSettingsSchema } from "@/lib/ai-roles";
import { changeAtLeast, dec, div, divInt, formatDec, pctChange, pctOf, sum, toFixed, toText } from "@/lib/decimal";
import { analyseFinance, severitySummary, type FinanceInput, type MonthSeries } from "@/server/ai/finance-rules";
import { monthValue, periodsInMonth } from "@/server/ai/month-values";

const P = "2026-10-01";
const MONTHS = ["2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"];

function series(key: string, vals: (string | null)[], extra: Partial<MonthSeries> = {}): MonthSeries {
  return {
    metricId: `m-${key}-${extra.unitSlug ?? ""}`,
    key,
    name: extra.name ?? key,
    label: extra.label ?? extra.name ?? key,
    unitSlug: null,
    unit: "KGS",
    direction: "higher_is_better",
    target: null,
    months: Object.fromEntries(MONTHS.map((m, i) => [m, vals[i] ?? null])),
    everHadData: vals.some((v) => v !== null),
    ...extra,
  };
}

const input = (s: MonthSeries[], thresholds = { changePct: 20, riskChangePct: 50 }): FinanceInput => ({
  companyName: "Kiwi Go",
  period: P,
  series: s,
  thresholds,
});

describe("exact decimals", () => {
  it("adds money without float noise and keeps 4 decimals", () => {
    expect(toText(sum([dec("0.1"), dec("0.2")]))).toBe("0.3");
    expect(toText(sum([dec("1234567.89"), dec("9999999.99")]))).toBe("11234567.88");
    expect(toText(dec("12345.6700"))).toBe("12345.67");
    expect(() => dec("1.23456")).toThrow();
  });
  it("divides once, rounding half away from zero", () => {
    expect(toText(div(dec("10"), dec("3")))).toBe("3.3333");
    expect(toText(divInt(dec("2"), 3))).toBe("0.6667");
    expect(toText(pctChange(dec("810000"), dec("1200000"))!)).toBe("-32.5");
    expect(toText(pctOf(dec("720000"), dec("1000000"))!)).toBe("72");
    expect(pctChange(dec("5"), dec("0"))).toBeNull();
    expect(toFixed(dec("-0.04"), 1)).toBe("0.0");
    expect(toFixed(dec("2.25"), 1)).toBe("2.3");
  });
  it("threshold test is exact at the boundary (no division)", () => {
    expect(changeAtLeast(dec("120"), dec("100"), dec("20"))).toBe(true);
    expect(changeAtLeast(dec("119.9999"), dec("100"), dec("20"))).toBe(false);
    expect(changeAtLeast(dec("80"), dec("100"), dec("20"))).toBe(true);
    expect(changeAtLeast(dec("1"), dec("0"), dec("20"))).toBe(false);
  });
  it("formats with Russian grouping", () => {
    expect(formatDec(dec("1234567.89"), "KGS")).toBe("1 234 567.89 KGS");
    expect(formatDec(dec("95.55"), "%")).toBe("95.6%");
    expect(formatDec(dec("-300"), "KGS")).toBe("−300 KGS");
    expect(formatDec(dec("120"), "orders")).toBe("120 orders");
  });
});

describe("month values from daily / weekly / monthly numbers", () => {
  it("a daily number is complete only with every day; then sum / avg / last", () => {
    const days = periodsInMonth("2026-10-01", "day");
    expect(days).toHaveLength(31);
    const vals = new Map(days.map((d, i) => [d, String(i + 1)]));
    expect(monthValue({ granularity: "day", aggregation: "sum" }, vals, "2026-10-01")).toEqual({ value: "496" });
    expect(monthValue({ granularity: "day", aggregation: "avg" }, vals, "2026-10-01")).toEqual({ value: "16" });
    expect(monthValue({ granularity: "day", aggregation: "last" }, vals, "2026-10-01")).toEqual({ value: "31" });
    vals.delete("2026-10-15");
    expect(monthValue({ granularity: "day", aggregation: "sum" }, vals, "2026-10-01")).toEqual({ missing: 1, total: 31 });
  });
  it("money sums stay exact over 31 days", () => {
    const days = periodsInMonth("2026-10-01", "day");
    const vals = new Map(days.map((d) => [d, "1234567.89"]));
    expect(monthValue({ granularity: "day", aggregation: "sum" }, vals, "2026-10-01")).toEqual({ value: "38271604.59" });
  });
  it("weeks belong to the month of their Monday", () => {
    expect(periodsInMonth("2026-10-01", "week")).toEqual(["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
  });
});

describe("schedule and chasing cadence", () => {
  const s = { kind: "monthly" as const, day: 10 };
  it("runs last month from the schedule day", () => {
    expect(scheduledPeriod("2026-11-09", s)).toBe("2026-09-01");
    expect(scheduledPeriod("2026-11-10", s)).toBe("2026-10-01");
    expect(runDueOn("2026-10-01", s)).toBe("2026-11-10");
    expect(firstPeriodFor("2026-11-02")).toBe("2026-10-01");
    expect(scheduleLabel(s)).toBe("Monthly on the 10th");
    expect(scheduleLabel({ kind: "monthly", day: 1 })).toBe("Monthly on the 1st");
    expect(monthsLabel(["2026-10-01", "2026-09-01"])).toBe("September and October 2026");
  });
  it("request months stay short: ranges for consecutive months, at most 3 named then +N earlier", () => {
    expect(monthsLabel(["2026-10-01"])).toBe("October 2026");
    expect(monthsLabel(["2026-08-01", "2026-10-01", "2026-09-01"])).toBe("August–October 2026");
    expect(monthsLabel(["2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"])).toBe("May–October 2026");
    expect(monthsLabel(["2025-11-01", "2025-12-01", "2026-01-01"])).toBe("November 2025–January 2026");
    expect(monthsLabel(["2025-12-01", "2026-01-01"])).toBe("December 2025 and January 2026");
    expect(monthsLabel(["2026-06-01", "2026-08-01", "2026-10-01"])).toBe("June, August and October 2026");
    expect(monthsLabel(["2026-02-01", "2026-04-01", "2026-06-01", "2026-08-01", "2026-10-01"])).toBe("June, August and October 2026 (+2 earlier)");
  });
  it("chases daily for 7 days, then weekly, never twice a day", () => {
    const created = "2026-11-10";
    expect(chaseDueToday(created, null, "2026-11-10")).toBe(true);
    expect(chaseDueToday(created, "2026-11-10", "2026-11-10")).toBe(false);
    expect(chaseDueToday(created, "2026-11-10", "2026-11-11")).toBe(true);
    expect(chaseDueToday(created, "2026-11-16", "2026-11-17")).toBe(false); // day 7: weekly now
    expect(chaseDueToday(created, "2026-11-16", "2026-11-23")).toBe(true);
    expect(chaseDueToday(created, "2026-11-23", "2026-11-29")).toBe(false);
    expect(chaseDueToday(created, "2026-11-23", "2026-11-30")).toBe(true);
    expect(chaseDueToday(created, null, "2026-12-01")).toBe(true); // never shown: show once
  });
  it("settings: risk threshold must not be below the warning threshold", () => {
    const base = { schedule: { kind: "monthly", day: 10 }, requiredMetricKeys: [], recipients: [crypto.randomUUID()], askUserIds: [crypto.randomUUID()] };
    expect(hireSettingsSchema.safeParse({ ...base, thresholds: { changePct: 30, riskChangePct: 20 } }).success).toBe(false);
    expect(hireSettingsSchema.safeParse({ ...base, schedule: { kind: "monthly", day: 31 }, thresholds: { changePct: 20, riskChangePct: 50 } }).success).toBe(false);
    expect(hireSettingsSchema.safeParse({ ...base, thresholds: { changePct: 20, riskChangePct: 50 } }).success).toBe(true);
  });
});

describe("finance rules (fixed fixtures)", () => {
  it("month-over-month change beyond the threshold, severity by direction", () => {
    const f = analyseFinance(input([series("revenue", ["1000000", "1100000", "1200000", "810000"], { label: "Revenue" })]));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: "change", severity: "warn", metricKeys: ["revenue"] });
    expect(f[0]!.sentence).toBe(
      "Revenue fell 32.5% vs September and fell 26.4% vs the 3-month average (Sep: 1 200 000 KGS, Oct: 810 000 KGS).",
    );
    expect(f[0]!.numbers).toContainEqual({ label: "Revenue · 3-month average", value: "1 100 000 KGS" });
  });
  it("exactly at the threshold counts; just below does not", () => {
    expect(analyseFinance(input([series("revenue", [null, null, "1000", "1200"])]))).toHaveLength(1);
    expect(analyseFinance(input([series("revenue", [null, null, "1000", "1199.99"])]))).toHaveLength(0);
  });
  it("risk past the risk threshold; a good move is info; neutral numbers are info", () => {
    expect(analyseFinance(input([series("revenue", [null, null, "1000", "400"])]))[0]!.severity).toBe("risk");
    expect(analyseFinance(input([series("revenue", [null, null, "1000", "1600"])]))[0]!.severity).toBe("info");
    expect(analyseFinance(input([series("cod_paid_out", [null, null, "1000", "100"], { direction: "neutral" })]))[0]!.severity).toBe("info");
    const lower = analyseFinance(input([series("wb_returns", [null, null, "10", "13"], { direction: "lower_is_better", unit: "pcs" })]));
    expect(lower[0]!.severity).toBe("warn");
  });
  it("vs the 3-month average alone (no previous-month move)", () => {
    const f = analyseFinance(input([series("sales", ["100", "100", "130", "135"])]));
    expect(f).toHaveLength(1);
    expect(f[0]!.sentence).toBe("sales rose 22.7% vs the 3-month average (3-month average: 110 KGS, Oct: 135 KGS).");
  });
  it("each comparison has its own direction: a drop vs September is not a risk because it is up vs the average", () => {
    // 10, 10, 100 → 75: −25% vs September (warning), +87.5% vs the average 40 (good news).
    const f = analyseFinance(input([series("revenue", ["10", "10", "100", "75"], { label: "Revenue" })]));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("warn");
    expect(f[0]!.sentence).toBe("Revenue fell 25% vs September and rose 87.5% vs the 3-month average (Sep: 100 KGS, Oct: 75 KGS).");
  });
  it("a big drop vs the 3-month average is a risk even when the number rose vs September; the sentence names the average", () => {
    // 100, 100, 10 → 30: +200% vs September (info), −57.1% vs the average 70 (risk).
    const f = analyseFinance(input([series("revenue", ["100", "100", "10", "30"], { label: "Revenue" })]));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("risk");
    expect(f[0]!.sentence).toBe("Revenue fell 57.1% vs the 3-month average and rose 200% vs September (3-month average: 70 KGS, Oct: 30 KGS).");
  });
  it("percentage metrics are phrased in percentage points", () => {
    const f = analyseFinance(input([series("defect_pct", [null, null, "3", "4.5"], { label: "Defect rate", unit: "%", direction: "lower_is_better" })]));
    expect(f[0]).toMatchObject({ rule: "change", severity: "risk" });
    expect(f[0]!.sentence).toBe("Defect rate rose 1.5 pp vs September, from 3.0% to 4.5%.");
    const r = analyseFinance(
      input([
        series("wb_returns", [null, null, "30", "45"], { label: "Returns", unit: "pcs", direction: "lower_is_better" }),
        series("wb_orders", [null, null, "1000", "1000"], { label: "Orders", unit: "pcs" }),
      ]),
    ).find((x) => x.rule === "ratio")!;
    expect(r.sentence).toBe("Returns rate rose 1.5 pp vs September, from 3.0% to 4.5%.");
  });
  it("custom thresholds are used", () => {
    expect(analyseFinance(input([series("revenue", [null, null, "100", "110"])], { changePct: 5, riskChangePct: 50 }))).toHaveLength(1);
  });
  it("COD paid out vs collected (gap) and revenue per order ratio", () => {
    const f = analyseFinance(
      input([
        series("cod_collected", [null, null, "1000000", "1000000"], { label: "COD collected" }),
        series("cod_paid_out", [null, null, "980000", "720000"], { label: "COD paid out", direction: "neutral" }),
      ]),
    );
    const cod = f.find((x) => x.rule === "cod_payout")!;
    expect(cod.severity).toBe("warn");
    expect(cod.sentence).toBe(
      "Only 72% of COD collected in October was paid out to shops: 1 000 000 KGS collected, 720 000 KGS paid out (280 000 KGS not paid out yet).",
    );
    const r = analyseFinance(
      input([
        series("revenue", [null, null, "1000000", "1000000"], { label: "Revenue" }),
        series("orders_day", [null, null, "4000", "5000"], { label: "Orders per day", unit: "orders" }),
      ]),
    ).find((x) => x.rule === "ratio")!;
    expect(r).toMatchObject({ severity: "warn", id: "ratio:revenue_per_order:" });
    expect(r.sentence).toBe("Revenue per order fell 20% vs September (250 KGS → 200 KGS).");
  });
  it("piecework pay per piece per factory (same factory only)", () => {
    const f = analyseFinance(
      input([
        series("piecework_total", [null, null, "500000", "650000"], { label: "Piecework pay total · ХБК", unitSlug: "hbk", direction: "neutral" }),
        series("output_pcs", [null, null, "40000", "40000"], { label: "Output per day · ХБК", unitSlug: "hbk", unit: "pcs" }),
        series("output_pcs", [null, null, "10", "10"], { label: "Output per day · Ош Район", unitSlug: "osh-rayon", unit: "pcs" }),
      ]),
    );
    const r = f.find((x) => x.rule === "ratio")!;
    expect(r.severity).toBe("warn");
    expect(r.sentence).toBe("Piecework pay per piece · ХБК rose 30% vs September (12.5 KGS → 16.25 KGS).");
    expect(f.filter((x) => x.rule === "ratio")).toHaveLength(1);
  });
  it("defect rate vs target (a %)", () => {
    const f = analyseFinance(input([series("defect_pct", [null, null, "2.6", "2.6"], { label: "Defect rate · ХБК", unit: "%", direction: "lower_is_better", target: "2" })]));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: "target", severity: "warn" });
    expect(f[0]!.sentence).toBe("Defect rate · ХБК was 2.6% in October, above the 2% target (off by 0.6 pp).");
  });
  it("numbers missing for 2+ months; never entered in one info line", () => {
    const f = analyseFinance(
      input([
        series("revenue", [null, null, "1", "1"]),
        { ...series("couriers_active", ["10", null, null, null], { label: "Active couriers", unit: "people" }) },
        { ...series("on_time_pct", [null, null, null, null], { label: "On-time delivery" }), everHadData: false },
      ]),
    );
    expect(f.map((x) => x.rule)).toEqual(["missing", "never_entered"]);
    expect(f[0]!.sentence).toBe("Active couriers has no numbers for September and October 2026 (2+ months missing).");
    expect(f[1]!.sentence).toBe("Never entered yet, so not analysed: On-time delivery.");
  });
  it("intercompany debt growing 3 months in a row is a risk (not also a change)", () => {
    const f = analyseFinance(
      input([series("intercompany_debt", ["1000000", "1100000.10", "1250000", "1400000.20"], { label: "Intercompany debt total", direction: "lower_is_better" })]),
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: "debt_trend", severity: "risk" });
    expect(f[0]!.sentence).toBe(
      "Intercompany debt total grew 3 months in a row: 1 000 000 KGS → 1 100 000.1 KGS → 1 250 000 KGS → 1 400 000.2 KGS (Jul–Oct), +400 000.2 KGS in total.",
    );
    // Not strictly growing: no trend finding.
    expect(analyseFinance(input([series("intercompany_debt", ["1000", "1100", "1100", "1200"], { direction: "lower_is_better" })])).map((x) => x.rule)).not.toContain("debt_trend");
  });
  it("is deterministic and sorted by severity", () => {
    const s = [
      series("revenue", [null, null, "1000", "1600"]),
      series("intercompany_debt", ["1", "2", "3", "4"], { direction: "lower_is_better" }),
      series("sales", [null, null, "1000", "700"]),
    ];
    const a = analyseFinance(input(s));
    expect(a.map((x) => x.severity)).toEqual(["risk", "warn", "info"]);
    expect(analyseFinance(input(s))).toEqual(a);
    expect(severitySummary(a)).toBe("1 risk · 1 warning · 1 info");
  });
});
