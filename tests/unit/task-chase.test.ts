/** The explicit per-task chase (0032): form ↔ override, the planner's modes, the summary, the card. */
import { describe, expect, it } from "vitest";
import { DEFAULT_STAFF_SETTINGS, parseTaskOverride, staffTaskOverrideSchema, taskChaseSettings } from "@/lib/staff-schemas";
import { chaseFormFromFields, chaseFormValue, chaseSummary, overrideFromForm, ChaseFormError } from "@/lib/task-chase";
import { buildStaffTaskCard, type StaffTaskCard } from "@/server/notifications/messages-ru";
import { planForPerson, type StaffPlanTask } from "@/server/notifications/planner";
import { fitTelegram, renderTelegram, TELEGRAM_MAX_TEXT } from "@/server/notifications/render-telegram";
import { actionKey } from "@/server/notifications/types";

const TZ = "Asia/Bishkek";
const at = (day: string, hm: string) => new Date(`${day}T${hm}:00+06:00`);
const D = "2026-11-02";
const task = (override: StaffPlanTask["override"], over: Partial<StaffPlanTask> = {}): StaffPlanTask => ({
  id: "t1",
  title: "Акт",
  dueDate: D,
  ownerUserId: "u1",
  assignedAt: at("2026-10-20", "10:00"),
  override,
  ...over,
});
const plan = (now: Date, t: StaffPlanTask, chasedAt?: Date) =>
  planForPerson({
    personId: "p1",
    personName: "Edil",
    now,
    timeZone: TZ,
    settings: DEFAULT_STAFF_SETTINGS,
    enabledAt: at("2026-10-01", "10:00"),
    tasks: [t],
    unanswered: new Map(),
    chasedAt: chasedAt ? new Map([["t1", chasedAt]]) : undefined,
  });
const chases = (p: ReturnType<typeof plan>) => p.messages.filter((m) => m.kind === "staff_chase");

describe("form ↔ stored override", () => {
  it("round-trips every choice and stores nothing for all defaults", () => {
    expect(overrideFromForm(chaseFormValue({}))).toBeNull();
    const v = { ...chaseFormValue({}), chase: "every" as const, everyN: 3, everyUnit: "hours" as const, escalation: "days" as const, escalateDays: 2 };
    const o = overrideFromForm(v)!;
    expect(o).toEqual({ chaseMode: "every", chaseEveryMinutes: 180, escalateAfterDays: 2 });
    expect(chaseFormValue(o)).toMatchObject({ chase: "every", everyN: 3, everyUnit: "hours", escalation: "days", escalateDays: 2 });
    const days = overrideFromForm({ ...v, everyUnit: "days", everyN: 4, escalation: "off" })!;
    expect(days).toEqual({ chaseMode: "every", chaseEveryDays: 4, escalateAfterDays: null });
    expect(chaseFormValue(days)).toMatchObject({ everyUnit: "days", everyN: 4, escalation: "off" });
    // Stored JSON passes the (strict) schema and reads back the same.
    expect(parseTaskOverride(staffTaskOverrideSchema.parse(days))).toEqual(days);
    expect(overrideFromForm({ ...chaseFormValue({}), founderNudge: "off", shareNotes: true, paused: true })).toEqual({
      founderNudge: "off",
      shareNotes: true,
      chasePaused: true,
    });
  });

  it("refuses out-of-range numbers with the field", () => {
    expect(() => overrideFromForm({ ...chaseFormValue({}), chase: "every", everyN: 13, everyUnit: "hours" })).toThrow(ChaseFormError);
    expect(() => overrideFromForm({ ...chaseFormValue({}), chase: "every", everyN: 0, everyUnit: "days" })).toThrow("Every 1 to 30 days");
    expect(() => overrideFromForm({ ...chaseFormValue({}), escalation: "days", escalateDays: 61 })).toThrow("0 to 60 days");
  });

  it("reads posted fields, keeping what was not posted", () => {
    const current = chaseFormValue({ chaseMode: "once", chasePaused: true });
    expect(chaseFormFromFields({ escalation: "off" }, current)).toMatchObject({ chase: "once", escalation: "off", paused: true });
    expect(chaseFormFromFields({ chase: "bogus" }, current).chase).toBe("once");
  });

  it("the 0028 'chasing off' override still reads as Don't chase; an explicit escalation replaces count / time", () => {
    expect(chaseFormValue({ chaseEnabled: false }).chase).toBe("off");
    const r = taskChaseSettings({ ...DEFAULT_STAFF_SETTINGS, escalateAt: "18:00" }, { escalateAfterDays: 3 });
    expect(r).toMatchObject({ escalateAfterChases: 0, escalateAt: null, escalateAfterDays: 3, chaseEnabled: true, mode: "every" });
    expect(taskChaseSettings(DEFAULT_STAFF_SETTINGS, { chasePaused: true }).chaseEnabled).toBe(false);
  });
});

describe("planner modes", () => {
  it("once: on the due day only, and only when not chased yet today", () => {
    const t = task({ chaseMode: "once" });
    expect(chases(plan(at(D, "09:10"), t))).toHaveLength(1);
    expect(chases(plan(at(D, "13:10"), t, at(D, "09:10")))).toHaveLength(0);
    expect(chases(plan(at("2026-11-03", "09:10"), t))).toHaveLength(0);
    expect(chases(plan(at("2026-11-01", "09:10"), t))).toHaveLength(0);
  });

  it("every N days: on day 0, N, 2N after the due date; joins the person's current slot", () => {
    const t = task({ chaseMode: "every", chaseEveryDays: 3 });
    const m = chases(plan(at(D, "11:30"), t));
    expect(m.map((x) => x.dedupeKey)).toEqual([`chase:${D}:11:00`]);
    expect(chases(plan(at("2026-11-04", "11:30"), t))).toHaveLength(0);
    expect(chases(plan(at("2026-11-05", "11:30"), t))).toHaveLength(1);
    expect(chases(plan(at("2026-11-05", "15:30"), t, at("2026-11-05", "11:30")))).toHaveLength(0);
  });

  it("every N hours uses its own slots; off and paused plan nothing", () => {
    expect(chases(plan(at(D, "10:30"), task({ chaseMode: "every", chaseEveryMinutes: 60 })))[0]!.dedupeKey).toBe(`chase:${D}:10:00`);
    expect(chases(plan(at(D, "10:30"), task({ chaseMode: "off" })))).toHaveLength(0);
    expect(chases(plan(at(D, "10:30"), task({ chasePaused: true })))).toHaveLength(0);
  });

  it("escalation N days after due: from that day on (inside working hours), never by count; null never escalates", () => {
    const t = task({ escalateAfterDays: 2 });
    expect(plan(at("2026-11-03", "12:00"), t).escalations).toHaveLength(0);
    expect(plan(at("2026-11-04", "08:00"), t).escalations).toHaveLength(0);
    expect(plan(at("2026-11-04", "09:30"), t).escalations).toEqual([expect.objectContaining({ reason: "days", taskId: "t1" })]);
    const never = planForPerson({
      personId: "p1",
      personName: "Edil",
      now: at("2026-11-09", "12:00"),
      timeZone: TZ,
      settings: DEFAULT_STAFF_SETTINGS,
      enabledAt: at("2026-10-01", "10:00"),
      tasks: [task({ escalateAfterDays: null })],
      unanswered: new Map([["t1", 40]]),
    });
    expect(never.escalations).toHaveLength(0);
    // Reminders go on (no stop after N unanswered).
    expect(never.messages.filter((m) => m.kind === "staff_chase")).toHaveLength(1);
  });
});

describe("live summary", () => {
  const base = { assignee: { kind: "person" as const, name: "Elmurat" }, nudgedFounder: "Nuraaly", dueDate: D, person: DEFAULT_STAFF_SETTINGS };
  it("says what happens in plain words", () => {
    const v = chaseFormValue({});
    expect(chaseSummary({ ...base, value: { ...v, chase: "once" } })[0]).toBe("Elmurat gets one reminder on the due date, between 09:00–20:00.");
    expect(chaseSummary({ ...base, value: { ...v, chase: "every", everyN: 3, everyUnit: "hours" } })[0]).toBe(
      "Elmurat is reminded every 3 h between 09:00–20:00, from the due date until it is done.",
    );
    expect(chaseSummary({ ...base, value: { ...v, chase: "every", everyN: 2, everyUnit: "days" } })[0]).toContain("once every 2 days");
    expect(chaseSummary({ ...base, value: { ...v, chase: "off" } })[0]).toContain("not reminded");
    expect(chaseSummary({ ...base, value: { ...v, escalation: "days", escalateDays: 2 } })[1]).toBe(
      "If it is still open 2 days after the due date, both founders are told (reminders go on).",
    );
    expect(chaseSummary({ ...base, value: v })[1]).toContain("After 3 unanswered reminders");
    expect(chaseSummary({ ...base, value: { ...v, paused: true } })[0]).toContain("paused");
    expect(chaseSummary({ ...base, value: v, unreachable: "they stopped the bot (/stop)" }).join(" ")).toContain("nothing reaches Elmurat");
  });

  it("founder-assigned tasks say whether the founder is nudged", () => {
    const v = chaseFormValue({});
    const f = { assignee: { kind: "user" as const, name: "Talant" }, nudgedFounder: "Talant", dueDate: D };
    expect(chaseSummary({ ...f, value: v })[0]).toContain("Talant gets the usual nudges");
    expect(chaseSummary({ ...f, value: { ...v, founderNudge: "off" } })[0]).toContain("no reminder pushes");
    expect(chaseSummary({ ...f, value: { ...v, founderNudge: "due_day" } })[0]).toContain("one nudge at 12:00 on the due date");
  });
});

describe("the task card", () => {
  const card: StaffTaskCard = {
    id: "t1",
    title: "Сдать <акты>",
    dueDate: "2026-11-01",
    priority: "high",
    companyName: "Kiwi Go",
    details: "Оригиналы в офис",
    checklist: [
      { id: "i1", title: "Акт", details: "подписанный", done: true },
      { id: "i2", title: "Счёт", details: null, done: false },
    ],
    status: "open",
    acceptedAt: "02.11 10:05",
  };

  it("overdue chase: header, details, checklist, state and buttons (no Принято once accepted)", () => {
    const m = buildStaffTaskCard(card, D, "chase");
    expect(m.title).toBe("⏰ Задача просрочена: Сдать <акты>");
    const r = renderTelegram(m, Object.fromEntries((m.actions ?? []).map((a, i) => [actionKey(a), `a:${"x".repeat(16)}${i}`])));
    expect(r.text).toContain("Сдать &lt;акты&gt;");
    expect(r.text).toContain("🏢 Kiwi Go");
    expect(r.text).toContain("📅 Просрочено на 1 дн. (срок был 01.11) · ❗ Важно");
    expect(r.text).toContain("📝 Оригиналы в офис");
    expect(r.text).toContain("<b>Чек-лист · 1 из 2 ▰▰▰▱▱</b>");
    expect(r.text).toContain("✅ Акт\n<i>      подписанный</i>\n⬜ Счёт");
    expect(r.text).toContain("<b>👍 Принято 02.11 10:05</b>");
    expect(r.reply_markup!.inline_keyboard.map((row) => row.map((b) => b.text))).toEqual([
      ["✅ Готово"],
      ["💬 Комментарий", "🆘 Нужна помощь"],
      ["📅 Перенести срок"],
      ["⬜ 2. Счёт"],
    ]);
  });

  it("a long checklist still fits Telegram's limit", () => {
    const many: StaffTaskCard = {
      ...card,
      checklist: Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, title: "x".repeat(290), details: "y".repeat(200), done: false })),
    };
    const fitted = fitTelegram(buildStaffTaskCard(many, D, "new")).message;
    expect(renderTelegram(fitted).text.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT);
    // At most 8 tick buttons.
    expect(fitted.actions!.filter((a) => a.action === "staff_check")).toHaveLength(8);
  });
});
