import { describe, expect, it } from "vitest";
import {
  checklistItems,
  describeSchedule,
  effectiveRoutineChase,
  isScheduledOn,
  nextScheduledDay,
  routineInputSchema,
  routineSlots,
  runOutcome,
} from "@/lib/routines";
import { DEFAULT_STAFF_SETTINGS } from "@/lib/staff-schemas";
import { buildRoutineMessageRu } from "@/server/notifications/messages-ru";

describe("routine schedule", () => {
  it("weekdays (ISO 1 = Mon … 7 = Sun) and monthly days, the 31st on short months = the last day", () => {
    const tueWedSat = { kind: "weekly" as const, days: [2, 3, 6], time: "10:00" };
    expect(isScheduledOn(tueWedSat, "2026-11-03")).toBe(true); // Tuesday
    expect(isScheduledOn(tueWedSat, "2026-11-02")).toBe(false); // Monday
    expect(isScheduledOn(tueWedSat, "2026-11-07")).toBe(true); // Saturday
    expect(nextScheduledDay(tueWedSat, "2026-11-08")).toBe("2026-11-10");
    const m31 = { kind: "monthly" as const, monthDay: 31, time: "10:00" };
    expect(isScheduledOn(m31, "2026-11-30")).toBe(true);
    expect(isScheduledOn(m31, "2026-12-30")).toBe(false);
    expect(isScheduledOn(m31, "2026-12-31")).toBe(true);
    expect(isScheduledOn(m31, "2027-02-28")).toBe(true);
    expect(isScheduledOn({ kind: "monthly", monthDay: 5, time: "10:00" }, "2026-11-05")).toBe(true);
    expect(describeSchedule({ kind: "weekly", days: [1, 2, 3, 4, 5, 6], time: "15:00" })).toBe("Mon–Sat 15:00");
    expect(describeSchedule(tueWedSat)).toBe("Tue, Wed, Sat 10:00");
  });

  it("slots: the ask then every N minutes before 'until', capped per day; settings fall back routine → person → global", () => {
    const c = effectiveRoutineChase(DEFAULT_STAFF_SETTINGS, { chaseEveryMinutes: 120, chaseUntil: "19:00" });
    expect(routineSlots("15:00", c).map((s) => s.start / 60)).toEqual([15, 17]);
    expect(routineSlots("15:00", { ...c, maxPerDay: 1 })).toHaveLength(1);
    const d = effectiveRoutineChase({ ...DEFAULT_STAFF_SETTINGS, chaseEveryMinutes: 60 }, {});
    expect(d).toMatchObject({ chaseEveryMinutes: 60, chaseUntil: "20:00", escalateAfterChases: 3, escalateAt: null });
    expect(effectiveRoutineChase(DEFAULT_STAFF_SETTINGS, { escalateAt: null }).escalateAt).toBeNull();
  });

  it("input validation and stable checklist keys", () => {
    const base = { title: "X", assignee: `person:${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`, scheduleKind: "weekly", time: "10:00" };
    expect(routineInputSchema.safeParse({ ...base, days: [], confirmation: "button", items: "" }).success).toBe(false);
    expect(routineInputSchema.safeParse({ ...base, days: ["2"], confirmation: "checklist", items: "" }).success).toBe(false);
    const ok = routineInputSchema.parse({ ...base, days: ["2", "3"], confirmation: "checklist", items: "Kiwi Go\n\nJobutify\n", chase: { chaseUntil: "" } });
    expect(ok.items).toEqual(["Kiwi Go", "Jobutify"]);
    expect(routineInputSchema.safeParse({ ...base, days: [1], confirmation: "checklist", items: "A\na" }).success).toBe(false);
    expect(routineInputSchema.safeParse({ ...base, days: [1], confirmation: "button", items: "", chase: { chaseUntil: "09:00" } }).success).toBe(false);
    const first = checklistItems(["A", "B"]);
    const second = checklistItems(["B", "C"], first);
    expect(second).toEqual([{ key: first[1]!.key, label: "B" }, { key: "i3", label: "C" }]);
  });

  it("outcome: on time / late / partly / missed", () => {
    const until = new Date("2026-11-02T13:00:00Z");
    expect(runOutcome({ status: "done", doneAt: new Date("2026-11-02T10:00:00Z"), escalatedAt: null }, until)).toBe("on_time");
    expect(runOutcome({ status: "done", doneAt: new Date("2026-11-02T14:00:00Z"), escalatedAt: null }, until)).toBe("late");
    expect(runOutcome({ status: "partly", doneAt: null, escalatedAt: null }, until)).toBe("partly");
    expect(runOutcome({ status: "missed", doneAt: null, escalatedAt: null }, until)).toBe("missed");
  });

  it("the Russian message lists only unticked items, one button each", () => {
    const items = [
      { key: "i1", label: "Kiwi Go" },
      { key: "i2", label: "Jobutify" },
    ];
    const ask = buildRoutineMessageRu({ runId: "r", title: "1C", description: "", confirmation: "checklist", items, itemsDone: [] }, false);
    expect(ask.title).toBe("Рутина: 1C");
    expect(ask.actions!.map((a) => a.label)).toEqual(["✓ Kiwi Go", "✓ Jobutify", "✓ Всё сделано"]);
    const re = buildRoutineMessageRu({ runId: "r", title: "1C", description: "", confirmation: "checklist", items, itemsDone: ["i1"] }, true);
    expect(re.title).toBe("Напоминание: 1C");
    expect(re.actions!.map((a) => a.label)).toEqual(["✓ Jobutify"]);
    expect(JSON.stringify(re.lines)).not.toContain("Kiwi Go");
    const btn = buildRoutineMessageRu({ runId: "r", title: "Возвраты", description: "", confirmation: "button", items: [], itemsDone: [] }, false);
    expect(btn.actions!.map((a) => a.label)).toEqual(["Готово"]);
  });
});
