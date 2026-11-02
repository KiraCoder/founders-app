import { describe, expect, it } from "vitest";
import { todayInTimeZone } from "@/lib/dates";
import {
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
    expect(f("2026-01-01", "2026-11-02")).toMatchObject({ status: "very_stale", overduePeriods: 3 });
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
