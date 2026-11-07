import { describe, expect, it } from "vitest";
import { isTimeInWindow, isWithinWindow, localMinutesOfDay, windowEndAfter, zonedTimeToUtc } from "@/lib/dates";
import { isChaseDay, planForUser, type PlanTask } from "@/server/notifications/planner";
import { DEFAULT_PREFERENCES } from "@/server/notifications/preferences";
import { taskTouchKey } from "@/server/notifications/types";

const TZ = "Asia/Bishkek";
const NOW = new Date("2026-11-02T06:00:00Z"); // 12:00 in Bishkek

describe("wall-clock helpers (Asia/Bishkek, GMT+6)", () => {
  it("converts local times to UTC instants", () => {
    expect(zonedTimeToUtc("2026-11-02", "08:30", TZ).toISOString()).toBe("2026-11-02T02:30:00.000Z");
    expect(zonedTimeToUtc("2026-11-02", "00:00", TZ).toISOString()).toBe("2026-11-01T18:00:00.000Z");
    expect(localMinutesOfDay(NOW, TZ)).toBe(12 * 60);
  });

  it("handles quiet hours that wrap midnight", () => {
    const at = (utc: string) => new Date(utc);
    expect(isWithinWindow(at("2026-11-02T15:30:00Z"), "21:00", "08:00", TZ)).toBe(true); // 21:30
    expect(isWithinWindow(at("2026-11-02T01:59:00Z"), "21:00", "08:00", TZ)).toBe(true); // 07:59
    expect(isWithinWindow(at("2026-11-02T02:00:00Z"), "21:00", "08:00", TZ)).toBe(false); // 08:00
    expect(isWithinWindow(NOW, "21:00", "08:00", TZ)).toBe(false);
    expect(isWithinWindow(NOW, "09:00", "09:00", TZ)).toBe(false); // disabled
    // 22:00 on 2 Nov -> quiet ends 08:00 on 3 Nov.
    expect(windowEndAfter(at("2026-11-02T16:00:00Z"), "21:00", "08:00", TZ).toISOString()).toBe("2026-11-03T02:00:00.000Z");
    // 03:00 -> ends 08:00 same day.
    expect(windowEndAfter(at("2026-11-02T21:00:00Z"), "21:00", "08:00", TZ).toISOString()).toBe("2026-11-03T02:00:00.000Z");
  });

  it("handles a quiet window that does not cross midnight (13:00–15:00)", () => {
    const at = (utc: string) => new Date(utc);
    expect(isWithinWindow(at("2026-11-02T06:59:00Z"), "13:00", "15:00", TZ)).toBe(false); // 12:59
    expect(isWithinWindow(at("2026-11-02T07:00:00Z"), "13:00", "15:00", TZ)).toBe(true); // 13:00
    expect(isWithinWindow(at("2026-11-02T08:59:00Z"), "13:00", "15:00", TZ)).toBe(true); // 14:59
    expect(isWithinWindow(at("2026-11-02T09:00:00Z"), "13:00", "15:00", TZ)).toBe(false); // 15:00
    expect(isWithinWindow(at("2026-11-02T16:00:00Z"), "13:00", "15:00", TZ)).toBe(false); // 22:00
    expect(isWithinWindow(at("2026-11-02T00:00:00Z"), "13:00", "15:00", TZ)).toBe(false); // 06:00
    // 14:00 -> ends 15:00 the same day; outside the window nothing is held.
    expect(windowEndAfter(at("2026-11-02T08:00:00Z"), "13:00", "15:00", TZ).toISOString()).toBe("2026-11-02T09:00:00.000Z");
    expect(windowEndAfter(NOW, "13:00", "15:00", TZ)).toBe(NOW);
    expect(isTimeInWindow("14:00", "13:00", "15:00")).toBe(true);
    expect(isTimeInWindow("15:00", "13:00", "15:00")).toBe(false);
    expect(isTimeInWindow("22:00", "21:00", "08:00")).toBe(true);
  });
});

describe("overdue chase cadence", () => {
  it("chases on day 1, 3, 7, then weekly", () => {
    const days = Array.from({ length: 30 }, (_, i) => i).filter(isChaseDay);
    expect(days).toEqual([1, 3, 7, 14, 21, 28]);
  });
});

const task = (id: string, dueDate: string | null, priority: PlanTask["priority"] = "medium"): PlanTask => ({
  id,
  title: `Task ${id}`,
  dueDate,
  priority,
  company: { name: "Kiwi Go" },
  visibility: "shared",
});

describe("planForUser", () => {
  const base = {
    userId: "u1",
    now: NOW,
    timeZone: TZ,
    prefs: DEFAULT_PREFERENCES,
    overdue: [] as PlanTask[],
    dueToday: [] as PlanTask[],
    snoozedTaskIds: new Set<string>(),
  };

  it("plans a morning summary and evening check at the founder's local times", () => {
    const items = planForUser(base);
    const morning = items.find((i) => i.kind === "morning_summary")!;
    expect(morning.dedupeKey).toBe("morning:2026-11-02");
    expect(morning.scheduledFor.toISOString()).toBe("2026-11-02T02:30:00.000Z");
    const evening = items.find((i) => i.kind === "evening_check")!;
    expect(evening.scheduledFor.toISOString()).toBe("2026-11-02T13:00:00.000Z");
    expect(planForUser({ ...base, prefs: { ...DEFAULT_PREFERENCES, eveningCheckEnabled: false } }).map((i) => i.kind)).toEqual([
      "morning_summary",
    ]);
  });

  it("chases only on cadence days, once per task per day, and skips snoozed tasks", () => {
    const overdue = [
      task("d1", "2026-11-01"), // 1 day
      task("d2", "2026-10-31"), // 2 days -> no chase
      task("d3", "2026-10-30"), // 3 days
      task("d7", "2026-10-26"), // 7 days
      task("d10", "2026-10-23"), // 10 days -> no chase
      task("d14", "2026-10-19", "urgent"), // 14 days
    ];
    const items = planForUser({ ...base, overdue, snoozedTaskIds: new Set(["d3"]) });
    const chases = items.filter((i) => i.kind === "overdue_chase");
    expect(chases.map((c) => c.taskId)).toEqual(["d1", "d7", "d14"]);
    expect(chases[0]!.dedupeKey).toBe("touch:d1:2026-11-02");
    expect(chases.find((c) => c.taskId === "d14")!.priority).toBe("urgent");
    expect(new Set(items.map((i) => i.dedupeKey)).size).toBe(items.length);
  });

  it("plans a due-today nudge under the task's one-push-per-day key", () => {
    const items = planForUser({ ...base, dueToday: [task("t1", "2026-11-02")] });
    const due = items.find((i) => i.kind === "task_due_today")!;
    expect(due.dedupeKey).toBe(taskTouchKey("t1", "2026-11-02"));
    expect(due.dedupeKey).toBe("touch:t1:2026-11-02");
    expect(due.scheduledFor.toISOString()).toBe("2026-11-02T06:00:00.000Z");
  });
});
