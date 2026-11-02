import { describe, expect, it } from "vitest";
import {
  addDays,
  formatDisplayDate,
  parseDisplayDate,
  daysBetween,
  endOfIsoWeek,
  formatDueDate,
  isIsoDate,
  isoWeekday,
  todayInTimeZone,
} from "@/lib/dates";

describe("todayInTimeZone (Asia/Bishkek, GMT+6)", () => {
  it("is still the previous day at 23:59 Bishkek (17:59 UTC)", () => {
    expect(todayInTimeZone(new Date("2026-11-02T17:59:59Z"), "Asia/Bishkek")).toBe("2026-11-02");
  });
  it("rolls over exactly at 00:00 Bishkek (18:00 UTC)", () => {
    expect(todayInTimeZone(new Date("2026-11-02T18:00:00Z"), "Asia/Bishkek")).toBe("2026-11-03");
  });
  it("differs from the UTC date between 18:00 and 24:00 UTC", () => {
    const now = new Date("2026-12-31T20:30:00Z");
    expect(now.toISOString().slice(0, 10)).toBe("2026-12-31");
    expect(todayInTimeZone(now, "Asia/Bishkek")).toBe("2027-01-01");
  });
  it("defaults to Bishkek", () => {
    expect(todayInTimeZone(new Date("2026-03-01T19:00:00Z"))).toBe("2026-03-02");
  });
});

describe("date arithmetic", () => {
  it("validates ISO dates", () => {
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("2026-1-01")).toBe(false);
  });
  it("adds days across month and year boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("counts days between dates", () => {
    expect(daysBetween("2026-11-01", "2026-11-04")).toBe(3);
    expect(daysBetween("2026-11-04", "2026-11-01")).toBe(-3);
  });
  it("computes ISO weekday and end of week", () => {
    expect(isoWeekday("2026-11-02")).toBe(1); // Monday
    expect(isoWeekday("2026-11-08")).toBe(7);
    expect(endOfIsoWeek("2026-11-04")).toBe("2026-11-08");
  });
  it("formats due dates relative to today", () => {
    expect(formatDueDate("2026-11-02", "2026-11-02")).toBe("Today");
    expect(formatDueDate("2026-11-03", "2026-11-02")).toBe("Tomorrow");
    expect(formatDueDate("2026-11-01", "2026-11-02")).toBe("Yesterday");
    expect(formatDueDate("2026-11-20", "2026-11-02")).toBe("20 Nov");
    expect(formatDueDate("2027-01-05", "2026-11-02")).toBe("5 Jan 2027");
  });
});

describe("date fields: dd.mm.yyyy", () => {
  it("formats ISO dates as dd.mm.yyyy", () => {
    expect(formatDisplayDate("2026-11-02")).toBe("02.11.2026");
    expect(formatDisplayDate("")).toBe("");
    expect(formatDisplayDate(null)).toBe("");
  });
  it("reads dd.mm.yyyy, d.m.yyyy, / or - separators and pasted ISO; refuses the rest", () => {
    expect(parseDisplayDate("02.11.2026")).toBe("2026-11-02");
    expect(parseDisplayDate(" 2.1.2026 ")).toBe("2026-01-02");
    expect(parseDisplayDate("02/11/2026")).toBe("2026-11-02");
    expect(parseDisplayDate("2026-11-02")).toBe("2026-11-02");
    expect(parseDisplayDate("")).toBeNull();
    expect(parseDisplayDate("31.02.2026")).toBe("invalid");
    expect(parseDisplayDate("02.11.26")).toBe("invalid");
    expect(parseDisplayDate("11/31/2026")).toBe("invalid");
    expect(parseDisplayDate("tomorrow")).toBe("invalid");
    expect(parseDisplayDate("2026-02-30")).toBe("invalid");
  });
});
