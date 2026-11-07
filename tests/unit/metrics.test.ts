import { describe, expect, it } from "vitest";
import { todayInTimeZone } from "@/lib/dates";
import {
  aggregateValues,
  decimalPlaces,
  defaultEntryPeriod,
  formatMetricInput,
  GAP_WINDOW,
  hasTimePart,
  lastEnterablePeriod,
  parseDateCell,
  parseMetricInput,
  periodProblem,
  agoText,
  changeVsPrevious,
  expectedPeriod,
  formatDelta,
  formatMetricValue,
  formatPeriod,
  lastPeriods,
  metricFreshness,
  metricValueProblem,
  nextPeriod,
  normalizeHeader,
  parseMetricNumber,
  parsePeriodInput,
  periodStart,
  prevPeriod,
} from "@/lib/metrics";
import { NUMBERS_WAITING_MAX_LINES, numbersWaitingSection } from "@/server/notifications/messages";

const bishkekDay = (utc: string) => todayInTimeZone(new Date(utc), "Asia/Bishkek");

describe("periods", () => {
  it("normalizes to the period start", () => {
    expect(periodStart("2026-11-04", "day")).toBe("2026-11-04");
    expect(periodStart("2026-11-04", "week")).toBe("2026-11-02"); // Wednesday → Monday
    expect(periodStart("2026-11-01", "week")).toBe("2026-10-26"); // Sunday → previous Monday
    expect(periodStart("2026-11-30", "month")).toBe("2026-11-01");
  });
  it("steps across month and year boundaries", () => {
    expect(nextPeriod("2026-12-01", "month")).toBe("2027-01-01");
    expect(prevPeriod("2026-01-01", "month")).toBe("2025-12-01");
    expect(nextPeriod("2026-10-31", "day")).toBe("2026-11-01");
    expect(prevPeriod("2026-03-02", "week")).toBe("2026-02-23");
    expect(lastPeriods("2026-11-15", "month", 3)).toEqual(["2026-09-01", "2026-10-01", "2026-11-01"]);
  });
  it("parses form and spreadsheet periods", () => {
    expect(parsePeriodInput("2026-10", "month")).toBe("2026-10-01");
    expect(parsePeriodInput("31.10.2026", "day")).toBe("2026-10-31");
    expect(parsePeriodInput("31.10.2026", "month")).toBe("2026-10-01");
    expect(parsePeriodInput("10.2026", "month")).toBe("2026-10-01");
    expect(parsePeriodInput("Oct 2026", "month")).toBe("2026-10-01");
    expect(parsePeriodInput("2026-11-04", "week")).toBe("2026-11-02");
    expect(parsePeriodInput("46326", "day")).toBe("2026-10-31"); // Excel serial
    expect(parsePeriodInput("31.02.2026", "day")).toBeNull();
    expect(parsePeriodInput("yesterday", "day")).toBeNull();
    expect(formatPeriod("2026-10-01", "month")).toBe("Oct 2026");
    expect(formatPeriod("2026-10-26", "week")).toBe("Week of 26 Oct");
  });
});

describe("freshness rules", () => {
  it("daily: fresh up to 2 days old, stale after, very stale when 2+ days are overdue", () => {
    const f = (latest: string | null, today: string) => metricFreshness({ granularity: "day", latestPeriod: latest }, today);
    expect(f("2026-11-01", "2026-11-02").status).toBe("fresh"); // yesterday's number
    expect(f("2026-10-31", "2026-11-02").status).toBe("fresh"); // 2 days old
    const stale = f("2026-10-30", "2026-11-02"); // 3 days old
    expect(stale).toMatchObject({ status: "stale", waitingFor: "2026-10-31", dueOn: "2026-11-01", overduePeriods: 1 });
    expect(f("2026-10-29", "2026-11-02")).toMatchObject({ status: "very_stale", overduePeriods: 2 });
    expect(f("2026-01-01", "2026-11-02")).toMatchObject({ status: "very_stale", overduePeriods: 7, moreBeforeWindow: true });
    expect(f(null, "2026-11-02")).toMatchObject({ status: "missing", waitingFor: "2026-10-31" });
  });

  it("weekly: due the Wednesday after the week", () => {
    const f = (latest: string, today: string) => metricFreshness({ granularity: "week", latestPeriod: latest }, today).status;
    // Week of 26 Oct (Mon) ends Sun 1 Nov; due Wed 4 Nov.
    expect(f("2026-10-19", "2026-11-04")).toBe("fresh");
    expect(f("2026-10-19", "2026-11-05")).toBe("stale");
    expect(f("2026-10-26", "2026-11-05")).toBe("fresh");
    expect(f("2026-10-12", "2026-11-05")).toBe("very_stale");
  });

  it("monthly: stale after the 10th of the next month, switching at midnight in Asia/Bishkek", () => {
    const f = (latest: string | null, utcNow: string, dueDays?: number) =>
      metricFreshness({ granularity: "month", latestPeriod: latest, dueDays }, bishkekDay(utcNow));
    // September is the latest value. October's number is due by 10 Nov.
    expect(f("2026-09-01", "2026-11-10T17:59:00Z").status).toBe("fresh"); // 10 Nov 23:59 Bishkek
    const late = f("2026-09-01", "2026-11-10T18:00:00Z"); // 11 Nov 00:00 Bishkek (still 10 Nov in UTC)
    expect(late).toMatchObject({ status: "stale", waitingFor: "2026-10-01", dueOn: "2026-11-10" });
    expect(f("2026-10-01", "2026-11-30T12:00:00Z").status).toBe("fresh");
    // Two months missing → very stale (after 10 Dec).
    expect(f("2026-09-01", "2026-12-10T18:00:00Z").status).toBe("very_stale");
    // Year boundary: December's number is due by 10 Jan.
    expect(f("2026-11-01", "2027-01-10T12:00:00Z").status).toBe("fresh");
    expect(f("2026-11-01", "2027-01-11T12:00:00Z")).toMatchObject({ status: "stale", waitingFor: "2026-12-01" });
    // A custom due day (5th) is respected.
    expect(f("2026-09-01", "2026-11-06T06:00:00Z", 5).status).toBe("stale");
    expect(expectedPeriod("2026-11-02", "month")).toBe("2026-09-01");
  });

  it("agoText", () => {
    expect(agoText("2026-11-02", "2026-11-02")).toBe("today");
    expect(agoText("2026-10-30", "2026-11-02")).toBe("3 days ago");
    expect(agoText("2026-10-01", "2026-11-02")).toBe("4 weeks ago");
  });
});

describe("change vs previous period", () => {
  it("compares with the period right before, following the direction", () => {
    const up = changeVsPrevious(
      [
        { period: "2026-10-31", value: 120 },
        { period: "2026-11-01", value: 150 },
      ],
      "day",
      "higher_is_better",
    );
    expect(up).toMatchObject({ previous: 120, delta: 30, pct: 25, tone: "good" });
    expect(formatDelta(up!, "orders")).toBe("+30 orders (+25%)");
    const errors = changeVsPrevious(
      [
        { period: "2026-10-01", value: 4 },
        { period: "2026-09-01", value: 2 },
      ],
      "month",
      "lower_is_better",
    );
    expect(errors).toMatchObject({ delta: 2, tone: "bad", pct: 100 });
    const neutral = changeVsPrevious(
      [
        { period: "2026-10-01", value: 5 },
        { period: "2026-09-01", value: 2 },
      ],
      "month",
      "neutral",
    );
    expect(neutral?.tone).toBe("flat");
  });
  it("no comparison across a gap or without history; zero previous has no percent", () => {
    expect(changeVsPrevious([{ period: "2026-11-01", value: 1 }], "day", "higher_is_better")).toBeNull();
    expect(
      changeVsPrevious(
        [
          { period: "2026-10-29", value: 1 },
          { period: "2026-11-01", value: 2 },
        ],
        "day",
        "higher_is_better",
      ),
    ).toBeNull();
    expect(
      changeVsPrevious(
        [
          { period: "2026-10-31", value: 0 },
          { period: "2026-11-01", value: 2 },
        ],
        "day",
        "higher_is_better",
      )?.pct,
    ).toBeNull();
  });
});

describe("numbers", () => {
  it("parses Russian and English formats", () => {
    expect(parseMetricNumber("1 234,5")).toBe(1234.5);
    expect(parseMetricNumber("1,234.50")).toBe(1234.5);
    expect(parseMetricNumber("85 000 сом")).toBe(85000);
    expect(parseMetricNumber("96.5%")).toBe(96.5);
    expect(parseMetricNumber("-300")).toBe(-300);
    expect(parseMetricNumber("abc")).toBeNaN();
  });
  it("validates per unit", () => {
    expect(metricValueProblem(101, "%")).toMatch(/between 0 and 100/);
    expect(metricValueProblem(-1, "orders")).toMatch(/negative/);
    expect(metricValueProblem(-1, "KGS")).toBeNull();
    expect(metricValueProblem(Number.NaN, "KGS")).toBe("Not a number");
  });
  it("formats", () => {
    expect(formatMetricValue(12345, "KGS")).toBe("12 345 KGS");
    expect(formatMetricValue(96.5, "%")).toBe("96.5%");
  });
  it("normalizes headers", () => {
    expect(normalizeHeader("Выручка (KGS)")).toBe("выручка");
    expect(normalizeHeader("Output_per_day · ХБК")).toBe("output per day хбк");
    expect(normalizeHeader("Ёлка")).toBe("елка");
  });
});

describe("morning summary: numbers waiting", () => {
  it(`never more than ${NUMBERS_WAITING_MAX_LINES} item lines`, () => {
    const items = ["Kiwi Go", "Jobutify", "Alura Style", "Upsell Group", "Alura Brand"].flatMap((c) =>
      ["A", "B", "C"].map((l) => ({ companyName: c, label: `${c} ${l}` })),
    );
    const lines = numbersWaitingSection(items);
    expect(lines[0]).toEqual({ text: "Numbers waiting (15)", style: "heading" });
    expect(lines.length - 1).toBeLessThanOrEqual(NUMBERS_WAITING_MAX_LINES);
    expect(lines[1]!.text).toBe("Kiwi Go: Kiwi Go A, Kiwi Go B +1 more");
    expect(lines[3]!.text).toContain("+9 more in 3 other companies");
    // Few companies: one line each, no overflow line.
    expect(numbersWaitingSection(items.slice(0, 6)).length).toBe(3);
    expect(numbersWaitingSection([])).toEqual([]);
  });
});

describe("C4 fixes: exact numbers, periods, aggregation, summary back-off", () => {
  it("decimal check is string-based: every 2-decimal value from 1M to 10M passes", () => {
    let rejected = 0;
    for (let cents = 100_000_000; cents < 1_000_000_000; cents += 7_919) {
      const v = Number((cents / 100).toFixed(2));
      if (metricValueProblem(v, "KGS") !== null) rejected++;
    }
    expect(rejected).toBe(0);
    expect(metricValueProblem(1234567.89, "KGS")).toBeNull();
    expect(decimalPlaces(1234567.89)).toBe(2);
    expect(decimalPlaces(1e-7)).toBe(7);
    expect(metricValueProblem(1.23456, "KGS")).toMatch(/4 decimals/);
  });

  it("parseMetricInput refuses what could mean two things", () => {
    expect(parseMetricInput("85.000", "orders")).toEqual({ error: expect.stringMatching(/ambiguous: 85 or 85000/) });
    expect(parseMetricInput("12,345", "KGS")).toEqual({ error: expect.stringMatching(/ambiguous: 12.345 or 12345/) });
    expect(parseMetricInput("0,125", "%")).toEqual({ value: 0.125 });
    expect(parseMetricInput("1,234,567", "KGS")).toEqual({ value: 1234567 });
    expect(parseMetricInput("1 234 567,89", "KGS")).toEqual({ value: 1234567.89 });
    expect(parseMetricInput("1.2340", "%")).toEqual({ value: 1.234 });
    expect(parseMetricInput("12.5%", "%")).toEqual({ value: 12.5 });
    expect(parseMetricInput("12.5%", "KGS")).toEqual({ error: expect.stringMatching(/is a percentage/) });
    expect(parseMetricInput("1234567890123456", "KGS")).toEqual({ error: expect.stringMatching(/Too many digits|too large/) });
    expect(formatMetricInput(85.125)).toBe("85.1250");
    expect(parseMetricInput(formatMetricInput(85.125), "KGS")).toEqual({ value: 85.125 });
  });

  it("dates: midnight exports are dates, other times are refused; month labels keep month precision", () => {
    expect(parseDateCell("31.10.2026 0:00:00")).toEqual({ date: "2026-10-31", precision: "day" });
    expect(parseDateCell("2026-10-31 00:00")).toEqual({ date: "2026-10-31", precision: "day" });
    expect(parseDateCell("2026-10-31T00:00:00Z")).toBeNull();
    expect(parseDateCell("2026-10-31 14:00")).toBeNull();
    expect(hasTimePart("2026-10-31T00:00:00Z")).toBe(true);
    expect(parseDateCell("Oct 2026")).toEqual({ date: "2026-10-01", precision: "month" });
    expect(parseDateCell("2026-10")).toEqual({ date: "2026-10-01", precision: "month" });
  });

  it("week / month numbers only for finished periods; daily may take today", () => {
    expect(periodProblem("2026-11-01", "month", "2026-11-02")).toBe("This month isn't finished yet");
    expect(periodProblem("2026-11-02", "week", "2026-11-02")).toBe("This week isn't finished yet");
    expect(periodProblem("2026-11-02", "day", "2026-11-02")).toBeNull();
    expect(periodProblem("2026-11-03", "day", "2026-11-02")).toBe("That period is in the future");
    expect(lastEnterablePeriod("2026-11-02", "month")).toBe("2026-10-01");
    expect(lastEnterablePeriod("2026-11-02", "week")).toBe("2026-10-26");
    expect(lastEnterablePeriod("2026-11-02", "day")).toBe("2026-11-02");
  });

  it("gap window: 7 days / 4 weeks / 3 months; periods before the first value are not gaps", () => {
    const f = metricFreshness(
      { granularity: "month", latestPeriod: "2026-09-01", firstPeriod: "2026-07-01", periods: ["2026-07-01", "2026-09-01"] },
      "2026-11-02",
    );
    expect(f).toMatchObject({ status: "stale", missingPeriods: ["2026-08-01"], waitingFor: "2026-08-01" });
    const young = metricFreshness(
      { granularity: "day", latestPeriod: "2026-10-31", firstPeriod: "2026-10-30", periods: ["2026-10-30", "2026-10-31"] },
      "2026-11-02",
    );
    expect(young.status).toBe("fresh");
    expect(GAP_WINDOW).toEqual({ day: 7, week: 4, month: 3 });
    expect(
      defaultEntryPeriod({ granularity: "month", freshness: metricFreshness({ granularity: "month", latestPeriod: "2026-10-01" }, "2026-11-02"), latestPeriod: "2026-10-01" }, "2026-11-02"),
    ).toBe("2026-10-01");
  });

  it("aggregation: sum, avg (4 decimals), last", () => {
    const pts = [
      { day: "2026-10-02", value: 2 },
      { day: "2026-10-01", value: 1 },
      { day: "2026-10-03", value: 2 },
    ];
    expect(aggregateValues(pts, "sum")).toBe(5);
    expect(aggregateValues(pts, "avg")).toBe(1.6667);
    expect(aggregateValues(pts, "last")).toBe(2);
    expect(aggregateValues([{ day: "2026-10-01", value: 0.1 }, { day: "2026-10-02", value: 0.2 }], "sum")).toBe(0.3);
  });

  it("morning summary: late numbers daily; never-entered and waiting-for-source only on Mondays, one line each", () => {
    const items = [
      { companyName: "Kiwi Go", label: "Revenue", hasData: true, awaitingSource: null },
      { companyName: "Alura Brand", label: "Sales", hasData: false, awaitingSource: null },
      ...Array.from({ length: 18 }, (_, i) => ({ companyName: "Kiwi Go", label: `C${i}`, hasData: false, awaitingSource: i < 15 ? "Edil's APIs" : "WB token" })),
    ];
    const monday = numbersWaitingSection(items, "2026-11-02").map((l) => l.text);
    expect(monday).toEqual([
      "Numbers waiting (20)",
      "Kiwi Go: Revenue",
      "Never entered yet: Sales (Alura Brand)",
      "18 numbers wait for data sources (Edil's APIs, WB token)",
    ]);
    const tuesday = numbersWaitingSection(items, "2026-11-03").map((l) => l.text);
    expect(tuesday).toEqual(["Numbers waiting (1)", "Kiwi Go: Revenue"]);
    expect(numbersWaitingSection(items.slice(1), "2026-11-03")).toEqual([]);
  });
});
