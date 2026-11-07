import { describe, expect, it } from "vitest";
import {
  askTimesOf,
  checklistItems,
  describeRoutinePlan,
  describeSchedule,
  effectiveFounderRoutineChase,
  effectiveRoutineChase,
  isScheduledOn,
  isWithinDates,
  nextAskAt,
  nextScheduledDay,
  openItems,
  routineInputSchema,
  routineSlots,
  runOutcome,
  runProgress,
  type RoutineChase,
} from "@/lib/routines";
import { DEFAULT_STAFF_SETTINGS } from "@/lib/staff-schemas";
import { buildRoutineMessageRu, buildRoutinePickRu } from "@/server/notifications/messages-ru";
import { renderTelegramText } from "@/server/notifications/render-telegram";

const hours = (c: RoutineChase, times: string | string[]) => routineSlots(times, c).map((s) => `${s.reminder ? "r" : "a"}${s.start / 60}`);

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
    expect(describeSchedule({ kind: "weekly", days: [1, 2, 3, 4, 5], time: "10:00", times: ["10:00", "16:00"] })).toBe("Mon–Fri 10:00, 16:00");
    expect(askTimesOf({ time: "16:00", times: ["16:00", "10:00", "10:00"] })).toEqual(["10:00", "16:00"]);
    expect(askTimesOf({ time: "09:30", times: null })).toEqual(["09:30"]);
  });

  it("slots: the ask then every N minutes before 'until', capped per day; settings fall back routine → person → global", () => {
    const c = effectiveRoutineChase(DEFAULT_STAFF_SETTINGS, { chaseEveryMinutes: 120, chaseUntil: "19:00" });
    expect(routineSlots("15:00", c).map((s) => s.start / 60)).toEqual([15, 17]);
    expect(routineSlots("15:00", { ...c, maxPerDay: 1 })).toHaveLength(1);
    const d = effectiveRoutineChase({ ...DEFAULT_STAFF_SETTINGS, chaseEveryMinutes: 60 }, {});
    expect(d).toMatchObject({ reminderMode: "every", chaseEveryMinutes: 60, chaseUntil: "20:00", escalateAfterChases: 3, escalateAt: null, escalateTo: [] });
    expect(effectiveRoutineChase(DEFAULT_STAFF_SETTINGS, { escalateAt: null }).escalateAt).toBeNull();
  });

  it("several asks a day: each ask is a slot, reminders follow each ask until the next one (one run, slot numbers in time order)", () => {
    const c = effectiveRoutineChase(DEFAULT_STAFF_SETTINGS, { chaseEveryMinutes: 120, chaseUntil: "19:00" });
    expect(hours(c, ["10:00", "16:00"])).toEqual(["a10", "r12", "r14", "a16", "r18"]);
    const slots = routineSlots(["10:00", "16:00"], c);
    expect(slots.map((s) => s.slot)).toEqual([0, 1, 2, 3, 4]);
    expect(slots.map((s) => s.ask)).toEqual([0, 0, 0, 1, 1]);
    // A slot ends where the next one starts (a held message never overlaps the next ask).
    expect(slots[2]!.end / 60).toBe(16);
    // The cap keeps both asks and fills reminders in time order.
    expect(hours({ ...c, maxPerDay: 3 }, ["10:00", "16:00"])).toEqual(["a10", "r12", "a16"]);
    // An ask after "until" still asks (it is not a reminder), but has no reminders.
    expect(hours({ ...c, chaseUntil: "12:00" }, ["10:00", "16:00"])).toEqual(["a10", "a16"]);
  });

  it("reminder modes: once / every N until / N times", () => {
    const base = effectiveRoutineChase(DEFAULT_STAFF_SETTINGS, { chaseEveryMinutes: 60, chaseUntil: "20:00" });
    expect(hours({ ...base, reminderMode: "once" }, ["15:00"])).toEqual(["a15"]);
    expect(hours({ ...base, reminderMode: "once" }, ["10:00", "16:00"])).toEqual(["a10", "a16"]);
    expect(hours({ ...base, reminderMode: "times", remindTimes: 2 }, ["15:00"])).toEqual(["a15", "r16", "r17"]);
    expect(hours({ ...base, reminderMode: "times", remindTimes: 2 }, ["10:00", "11:30"])).toEqual(["a10", "r11", "a11.5", "r12.5", "r13.5"]);
    expect(hours({ ...base, reminderMode: "every" }, ["17:00"])).toEqual(["a17", "r18", "r19"]);
    // Founder defaults: the ask and one reminder 3 h later.
    const f = effectiveFounderRoutineChase(DEFAULT_STAFF_SETTINGS, {});
    expect(f).toMatchObject({ reminderMode: "times", remindTimes: 1, chaseEveryMinutes: 180, escalateAt: null, escalateAfterChases: 0 });
    expect(hours(f, ["10:00"])).toEqual(["a10", "r13"]);
  });

  it("start / end dates and the next ask in Asia/Bishkek (UTC+6: Bishkek's Wednesday starts on Tuesday 18:00 UTC)", () => {
    const s = { kind: "weekly" as const, days: [1, 2, 3, 4, 5, 6, 7], time: "10:00", times: ["10:00", "16:00"] };
    const r = { schedule: s, startsOn: "2026-11-02", endsOn: "2026-11-03", timezone: "Asia/Bishkek" };
    expect(isWithinDates(r, "2026-11-01")).toBe(false);
    expect(isWithinDates(r, "2026-11-03")).toBe(true);
    expect(isWithinDates(r, "2026-11-04")).toBe(false);
    // Monday 12:00 Bishkek (06:00 UTC): the 16:00 ask today.
    expect(nextAskAt(r, new Date("2026-11-02T06:00:00Z"))?.toISOString()).toBe("2026-11-02T10:00:00.000Z");
    // Monday 17:00 Bishkek: Tuesday 10:00.
    expect(nextAskAt(r, new Date("2026-11-02T11:00:00Z"))?.toISOString()).toBe("2026-11-03T04:00:00.000Z");
    // Today's run already closed → no later ask today.
    expect(nextAskAt(r, new Date("2026-11-02T06:00:00Z"), { todayClosed: true })?.toISOString()).toBe("2026-11-03T04:00:00.000Z");
    // Tuesday 18:30 UTC is Wednesday 00:30 in Bishkek: past the end date → nothing.
    expect(nextAskAt(r, new Date("2026-11-03T18:30:00Z"))).toBeNull();
    expect(nextScheduledDay(s, "2026-11-04", r)).toBeNull();
    expect(nextScheduledDay(s, "2026-10-30", r)).toBe("2026-11-02");
  });

  it("input validation: several times, dates, checklist JSON from the editor, legacy one-per-line text; stable keys", () => {
    const base = { title: "X", assignee: `person:${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`, scheduleKind: "weekly", time: "10:00" };
    expect(routineInputSchema.safeParse({ ...base, days: [], confirmation: "button", items: "" }).success).toBe(false);
    expect(routineInputSchema.safeParse({ ...base, days: ["2"], confirmation: "checklist", items: "" }).success).toBe(false);
    const ok = routineInputSchema.parse({ ...base, days: ["2", "3"], confirmation: "checklist", items: "Kiwi Go\n\nJobutify\n", chase: { chaseUntil: "" } });
    expect(ok.items.map((i) => i.label)).toEqual(["Kiwi Go", "Jobutify"]);
    expect(ok.times).toEqual(["10:00"]);
    expect(routineInputSchema.safeParse({ ...base, days: [1], confirmation: "checklist", items: "A\na" }).success).toBe(false);
    expect(routineInputSchema.safeParse({ ...base, days: [1], confirmation: "button", items: "", chase: { chaseUntil: "09:00" } }).success).toBe(false);
    const multi = routineInputSchema.parse({ ...base, time: undefined, times: ["16:00", "10:00"], days: [1], confirmation: "button", items: "" });
    expect(multi.times).toEqual(["16:00", "10:00"]);
    expect(routineInputSchema.safeParse({ ...base, times: ["10:00", "10:00"], days: [1], confirmation: "button", items: "" }).success).toBe(false);
    expect(routineInputSchema.safeParse({ ...base, times: "10:00, 25:00", days: [1], confirmation: "button", items: "" }).success).toBe(false);
    const dated = routineInputSchema.safeParse({ ...base, days: [1], confirmation: "button", items: "", startsOn: "2026-12-10", endsOn: "2026-12-01" });
    expect(dated.success).toBe(false);
    expect(dated.error!.issues[0]!.path).toEqual(["endsOn"]);
    const json = routineInputSchema.parse({
      ...base,
      days: [1],
      confirmation: "checklist",
      items: JSON.stringify([{ key: "i2", label: "Касса", details: "Сверить с банком", needsComment: true }, { label: "Склад" }]),
      chase: { reminderMode: "times", remindTimes: "2", escalateTo: "" },
    });
    expect(json.items).toEqual([
      { key: "i2", label: "Касса", details: "Сверить с банком", needsComment: true },
      { key: undefined, label: "Склад", details: "", needsComment: false },
    ]);
    expect(json.chase).toMatchObject({ reminderMode: "times", remindTimes: 2 });
    const first = checklistItems(["A", "B"]);
    const second = checklistItems(["B", "C"], first);
    expect(second).toEqual([{ key: first[1]!.key, label: "B" }, { key: "i3", label: "C" }]);
    // A renamed item sent with its key keeps it (ticks of today's run stay valid).
    expect(checklistItems([{ key: "i1", label: "A (renamed)", details: "how" }], first)).toEqual([{ key: "i1", label: "A (renamed)", details: "how" }]);
  });

  it("outcome: on time / late / partly / missed / can't", () => {
    const until = new Date("2026-11-02T13:00:00Z");
    expect(runOutcome({ status: "done", doneAt: new Date("2026-11-02T10:00:00Z"), escalatedAt: null }, until)).toBe("on_time");
    expect(runOutcome({ status: "done", doneAt: new Date("2026-11-02T14:00:00Z"), escalatedAt: null }, until)).toBe("late");
    expect(runOutcome({ status: "partly", doneAt: null, escalatedAt: null }, until)).toBe("partly");
    expect(runOutcome({ status: "missed", doneAt: null, escalatedAt: null }, until)).toBe("missed");
    expect(runOutcome({ status: "partly", doneAt: null, escalatedAt: null, itemStates: { i1: { state: "cant", at: "", by: "E" } } }, until)).toBe("cant");
  });

  it("item state: done / partly / can't resolve an item; open = what reminders ask about", () => {
    const run = {
      items: [
        { key: "i1", label: "A" },
        { key: "i2", label: "B" },
        { key: "i3", label: "C" },
      ],
      itemsDone: ["i1"],
      itemStates: { i2: { state: "partly" as const, at: "", by: "E", comment: "half" } },
    };
    expect(openItems(run).map((i) => i.key)).toEqual(["i3"]);
    expect(runProgress(run)).toEqual({ done: 1, total: 3 });
    expect(runProgress({ items: [], itemsDone: [], status: "done" })).toEqual({ done: 1, total: 1 });
  });

  it("the plain-language summary: staff chase, several asks, escalation recipients, founder chased or not, end date", () => {
    const c = effectiveRoutineChase(DEFAULT_STAFF_SETTINGS, { chaseEveryMinutes: 120, chaseUntil: "19:00", escalateAt: "19:00" });
    const s = { kind: "weekly" as const, days: [1, 2, 3, 4, 5, 6], time: "15:00" };
    expect(describeRoutinePlan({ assigneeName: "Asan", forFounder: false, schedule: s, chase: { ...c, escalateAfterChases: 0 }, escalateNames: "Nuraaly" })).toBe(
      "Bot asks Asan Mon–Sat at 15:00, reminds every 2 h until 19:00; if not done by 19:00 it tells Nuraaly.",
    );
    const two = describeRoutinePlan({
      assigneeName: "Asan",
      forFounder: false,
      schedule: { ...s, times: ["10:00", "16:00"] },
      chase: { ...c, reminderMode: "once", escalateAt: null, escalateAfterChases: 0 },
      escalateNames: "both founders",
      endsOn: "2026-12-31",
    });
    expect(two).toBe("Bot asks Asan Mon–Sat at 10:00 and 16:00 (each later ask only about what is still open), no reminders; nobody else is told if it is not done. Ends on 31.12.2026.");
    const f = effectiveFounderRoutineChase(DEFAULT_STAFF_SETTINGS, {});
    expect(describeRoutinePlan({ assigneeName: "Talant", forFounder: true, schedule: s, chase: f, escalateNames: "Nuraaly" })).toContain("Talant will be chased: 1 reminder 3 h later");
    expect(describeRoutinePlan({ assigneeName: "Talant", forFounder: true, schedule: s, chase: { ...f, reminderMode: "once" }, escalateNames: "Nuraaly" })).toContain(
      "Talant is asked once and not chased",
    );
  });

  it("the Russian message: header, company, until, progress, the whole checklist with states, buttons for open items; the final state", () => {
    const items = [
      { key: "i1", label: "Kiwi Go" },
      { key: "i2", label: "Jobutify", details: "Сверить кассу" },
      { key: "i3", label: "Alura Brand" },
    ];
    const base = { runId: "r", title: "1C", description: "", confirmation: "checklist" as const, items, companyName: "Kiwi Go", until: "19:00" };
    const ask = buildRoutineMessageRu({ ...base, itemsDone: [] }, "ask");
    expect(ask.title).toBe("📋 Рутина: 1C");
    expect(ask.actions!.map((a) => a.label)).toEqual(["✓ Kiwi Go", "✓ Jobutify", "✓ Alura Brand", "✅ Всё готово", "💬 Комментарий", "🟡 Частично", "❌ Не могу"]);
    const text = renderTelegramText(ask);
    expect(text).toContain("🏢 Kiwi Go · ⏰ сегодня до 19:00");
    expect(text).toContain("<b>Прогресс: 0/3</b>");
    expect(text).toContain("⬜ Jobutify\n<i>    Сверить кассу</i>");
    const re = buildRoutineMessageRu(
      { ...base, itemsDone: ["i1"], itemStates: { i3: { state: "cant", at: "", by: "E", comment: "нет доступа" } } },
      true,
    );
    expect(re.title).toBe("⏰ Напоминание: 1C");
    expect(re.actions!.map((a) => a.label)).toEqual(["✓ Jobutify", "💬 Комментарий", "🟡 Частично", "❌ Не могу"]);
    const reText = renderTelegramText(re);
    expect(reText).toContain("✅ Kiwi Go");
    expect(reText).toContain("❌ Alura Brand — «нет доступа»");
    expect(reText).toContain("Осталось: 1 из 3.");
    const fin = buildRoutineMessageRu({ ...base, status: "done", itemsDone: ["i1", "i2", "i3"] }, "ask");
    expect(fin.title).toBe("✅ 1C");
    expect(fin.actions).toEqual([]);
    expect(renderTelegramText(fin)).toContain("Готово, спасибо! 3/3 ✅");
    const btn = buildRoutineMessageRu({ runId: "r", title: "Возвраты", description: "", confirmation: "button", items: [], itemsDone: [] }, false);
    expect(btn.actions!.map((a) => a.label)).toEqual(["✅ Готово", "💬 Комментарий", "🟡 Частично", "❌ Не могу"]);
    // «Какой пункт?»: open items for «Частично», plus all of them and «Назад».
    const pick = buildRoutinePickRu({ ...base, itemsDone: ["i1"] }, "partly");
    expect(pick.actions!.map((a) => a.label)).toEqual(["→ Jobutify", "→ Alura Brand", "Все оставшиеся", "← Назад"]);
    expect(pick.actions![0]!.payload).toEqual({ kind: "partly" });
  });
});
