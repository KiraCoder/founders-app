import { describe, expect, it } from "vitest";
import { defaultAcceptMonthlyTotals, defaultSettings, FINANCIAL_ANALYST, ROLE_TEMPLATES } from "@/lib/ai-roles";
import { monthTotalKind, monthTotalMark, monthValue, periodsInMonth } from "@/server/ai/month-values";
import { composeRequests, monthTotalsWording } from "@/server/ai/orchestrator";
import type { AiRequestItem } from "@/server/services/ai-roles";

const OCT = "2026-10-01";
const days = (n: number, v = "10.5") => new Map(periodsInMonth(OCT, "day").slice(0, n).map((d) => [d, v]));
const daily = { granularity: "day" as const, aggregation: "sum" as const };

describe("monthValue precedence: complete days → month total (if accepted) → missing", () => {
  it("complete days win over a month total", () => {
    expect(monthValue(daily, days(31), OCT, "1")).toEqual({ value: "325.5" });
  });
  it("incomplete days take the month total, exactly and marked", () => {
    expect(monthValue(daily, days(30), OCT, "1234567.8912")).toEqual({ value: "1234567.8912", fromMonthTotal: true });
    expect(monthValue({ granularity: "day", aggregation: "avg" }, days(3), OCT, "95.55")).toEqual({ value: "95.55", fromMonthTotal: true });
  });
  it("without a month total (or when the role does not accept them) the month is missing", () => {
    expect(monthValue(daily, days(30), OCT)).toEqual({ missing: 1, total: 31 });
    expect(monthValue(daily, days(30), OCT, null)).toEqual({ missing: 1, total: 31 });
  });
  it("weekly and monthly numbers never take a month total", () => {
    expect(monthValue({ granularity: "week", aggregation: "sum" }, new Map(), OCT, "5")).toMatchObject({ missing: 4 });
    expect(monthValue({ granularity: "month", aggregation: "sum" }, new Map(), OCT, "5")).toEqual({ missing: 1, total: 1 });
  });
  it("labels the kind of value per aggregation", () => {
    expect([monthTotalKind("sum"), monthTotalKind("avg"), monthTotalKind("last")]).toEqual(["total", "average", "end-of-month value"]);
    expect([monthTotalMark("sum"), monthTotalMark("avg"), monthTotalMark("last")]).toEqual([
      "(month total entered)",
      "(month average entered)",
      "(end-of-month value entered)",
    ]);
  });
});

describe("request wording", () => {
  const m = (label: string, granularity: "day" | "month", aggregation: "sum" | "avg" = "sum") => ({
    metricId: label,
    key: label,
    label,
    granularity,
    aggregation,
  });
  const item = (missing: AiRequestItem["missing"], months = [OCT], accept = true): AiRequestItem => ({
    requestId: "r1",
    hireId: "h1",
    roleName: "Financial Analyst",
    companyName: "Kiwi Go",
    companySlug: "kiwi-go",
    months,
    missing,
    waitingOnHolding: [],
    dueToday: true,
    acceptMonthlyTotals: accept,
  });

  it("one month, totals / averages / both; several months; off or no daily number → null", () => {
    expect(monthTotalsWording(item([m("Orders per day", "day")]), [m("Orders per day", "day")])).toBe("enter the October total (or every day)");
    expect(monthTotalsWording(item([]), [m("On-time delivery", "day", "avg")])).toBe("enter the October average (or every day)");
    expect(monthTotalsWording(item([]), [m("Revenue", "month"), m("On-time delivery", "day", "avg")])).toBe(
      "enter the October total or average (or every day)",
    );
    expect(monthTotalsWording(item([], ["2026-09-01", OCT]), [m("Orders per day", "day")])).toBe(
      "enter the September and October 2026 totals (or every day)",
    );
    expect(monthTotalsWording(item([], [OCT], false), [m("Orders per day", "day")])).toBeNull();
    expect(monthTotalsWording(item([]), [m("Revenue", "month")])).toBeNull();
  });

  it("the role's line in the morning summary uses it", () => {
    const missing = [m("Revenue", "month"), m("Orders per day", "day")];
    const { aiLines } = composeRequests([item(missing)], [], null);
    expect(aiLines[1]!.text).toMatch(/^Financial Analyst needs October 2026 numbers for Kiwi Go: Revenue, Orders per day — enter the October total \(or every day\): /);
    const off = composeRequests([item(missing, [OCT], false)], [], null);
    expect(off.aiLines[1]!.text).toContain("— enter them: ");
  });
});

describe("acceptMonthlyTotals default (the founders' decision)", () => {
  it("is on for a new Financial Analyst, off for the other roles", () => {
    expect(defaultAcceptMonthlyTotals(FINANCIAL_ANALYST)).toBe(true);
    for (const t of ROLE_TEMPLATES) {
      expect(defaultSettings(t, "delivery", ["u1"]).acceptMonthlyTotals).toBe(t.key === FINANCIAL_ANALYST);
    }
  });
});
