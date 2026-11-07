import { describe, expect, it } from "vitest";
import { todayInTimeZone } from "@/lib/dates";
import { daysOverdue, dueBucket, isOverdue, nextCompletedAt, thisWeekRange } from "@/server/services/tasks-rules";

const at = (iso: string) => todayInTimeZone(new Date(iso), "Asia/Bishkek");

describe("isOverdue", () => {
  it("is overdue when open and due before today", () => {
    expect(isOverdue({ status: "todo", dueDate: "2026-11-01" }, "2026-11-02")).toBe(true);
    expect(isOverdue({ status: "in_review", dueDate: "2026-10-01" }, "2026-11-02")).toBe(true);
  });
  it("is not overdue on the due date itself", () => {
    expect(isOverdue({ status: "todo", dueDate: "2026-11-02" }, "2026-11-02")).toBe(false);
  });
  it("is never overdue when done or cancelled", () => {
    expect(isOverdue({ status: "done", dueDate: "2020-01-01" }, "2026-11-02")).toBe(false);
    expect(isOverdue({ status: "cancelled", dueDate: "2020-01-01" }, "2026-11-02")).toBe(false);
  });
  it("is never overdue without a due date", () => {
    expect(isOverdue({ status: "todo", dueDate: null }, "2026-11-02")).toBe(false);
  });
  it("stays overdue as days pass (no auto-clearing)", () => {
    const task = { status: "in_progress" as const, dueDate: "2026-11-01" };
    for (const today of ["2026-11-02", "2026-12-01", "2027-06-01"]) expect(isOverdue(task, today)).toBe(true);
    expect(daysOverdue(task, "2026-11-11")).toBe(10);
  });

  describe("midnight in Bishkek (GMT+6)", () => {
    const task = { status: "todo" as const, dueDate: "2026-11-02" };
    it("23:59:59 Bishkek on the due date -> not overdue (UTC is 17:59)", () => {
      expect(isOverdue(task, at("2026-11-02T17:59:59Z"))).toBe(false);
    });
    it("00:00 Bishkek next day -> overdue (UTC is still 2 Nov 18:00)", () => {
      expect(isOverdue(task, at("2026-11-02T18:00:00Z"))).toBe(true);
    });
    it("05:30 Bishkek is still the previous day in UTC", () => {
      // 05:30 Bishkek on 3 Nov is 23:30 UTC on 2 Nov. Due 2 Nov -> overdue in Bishkek.
      expect(isOverdue(task, at("2026-11-02T23:30:00Z"))).toBe(true);
      // A task due 3 Nov is due *today* in Bishkek even though UTC still says 2 Nov.
      expect(dueBucket({ status: "todo", dueDate: "2026-11-03" }, at("2026-11-02T23:30:00Z"))).toBe("today");
    });
  });
});

describe("dueBucket / thisWeekRange", () => {
  const today = "2026-11-02";
  it("buckets tasks", () => {
    expect(dueBucket({ status: "todo", dueDate: "2026-11-01" }, today)).toBe("overdue");
    expect(dueBucket({ status: "todo", dueDate: today }, today)).toBe("today");
    expect(dueBucket({ status: "todo", dueDate: "2026-11-09" }, today)).toBe("this_week");
    expect(dueBucket({ status: "todo", dueDate: "2026-11-10" }, today)).toBe("later");
    expect(dueBucket({ status: "todo", dueDate: null }, today)).toBe("no_date");
    expect(dueBucket({ status: "done", dueDate: "2026-11-01" }, today)).toBe("closed");
  });
  it("this week = tomorrow .. today+7", () => {
    expect(thisWeekRange(today)).toEqual({ from: "2026-11-03", to: "2026-11-09" });
  });
});

describe("nextCompletedAt", () => {
  const now = new Date("2026-11-02T06:00:00Z");
  const earlier = new Date("2026-10-01T06:00:00Z");
  it("sets completed_at when moving to done", () => {
    expect(nextCompletedAt({ status: "todo", completedAt: null }, "done", now)).toBe(now);
  });
  it("keeps the original completed_at when it stays done", () => {
    expect(nextCompletedAt({ status: "done", completedAt: earlier }, "done", now)).toBe(earlier);
  });
  it("clears completed_at when reopened", () => {
    expect(nextCompletedAt({ status: "done", completedAt: earlier }, "todo", now)).toBeNull();
  });
});
