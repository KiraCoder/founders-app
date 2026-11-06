import { describe, expect, it } from "vitest";
import {
  DEFAULT_STAFF_SETTINGS,
  effectiveStaffSettings,
  parsePersonOverride,
  parseStaffDefaults,
  staffDefaultsSchema,
  staffPersonOverrideSchema,
  taskChaseSettings,
} from "@/lib/staff-schemas";
import { buildStaffNewTask, buildStaffTaskList, ruDue } from "@/server/notifications/messages-ru";
import { planForPerson, type StaffPlanTask } from "@/server/notifications/planner";
import { renderTelegram } from "@/server/notifications/render-telegram";

const TZ = "Asia/Bishkek";
const at = (day: string, hm: string) => new Date(`${day}T${hm}:00+06:00`);
const D = "2026-11-02";
const task = (over: Partial<StaffPlanTask> = {}): StaffPlanTask => ({
  id: "t1",
  title: "Акт",
  dueDate: D,
  ownerUserId: "u1",
  assignedAt: at("2026-10-20", "10:00"),
  override: {},
  ...over,
});
const plan = (now: Date, tasks: StaffPlanTask[], extra: Partial<Parameters<typeof planForPerson>[0]> = {}) =>
  planForPerson({
    personId: "p1",
    personName: "Edil",
    now,
    timeZone: TZ,
    settings: DEFAULT_STAFF_SETTINGS,
    enabledAt: at("2026-10-01", "10:00"),
    tasks,
    unanswered: new Map(),
    ...extra,
  });

describe("planForPerson", () => {
  it("chases on the due day inside working hours, one key per 120-minute slot", () => {
    expect(plan(at(D, "08:59"), [task()]).messages).toHaveLength(0);
    const m9 = plan(at(D, "09:00"), [task()]).messages;
    expect(m9.map((m) => m.dedupeKey)).toEqual([`chase:t1:${D}:0`]);
    expect(m9[0]!.expiresAt!.toISOString()).toBe(at(D, "11:00").toISOString());
    expect(plan(at(D, "10:59"), [task()]).messages[0]!.dedupeKey).toBe(`chase:t1:${D}:0`);
    expect(plan(at(D, "19:30"), [task()]).messages[0]!.dedupeKey).toBe(`chase:t1:${D}:5`);
    // The last slot is cut at the end of working hours.
    expect(plan(at(D, "19:30"), [task()]).messages[0]!.expiresAt!.toISOString()).toBe(at(D, "20:00").toISOString());
    expect(plan(at(D, "20:00"), [task()]).messages).toHaveLength(0);
    // Not before the due day; every day after it.
    expect(plan(at(D, "10:00"), [task({ dueDate: "2026-11-03" })]).messages).toHaveLength(0);
    expect(plan(at("2026-11-09", "13:00"), [task()]).messages[0]!.payload).toMatchObject({ daysOverdue: 7, dueDate: D });
  });

  it("new-task message once, only for tasks assigned after the switch-on and recently", () => {
    const fresh = task({ dueDate: null, assignedAt: at(D, "09:30") });
    expect(plan(at(D, "09:40"), [fresh]).messages.map((m) => m.dedupeKey)).toEqual(["new:t1"]);
    expect(plan(at(D, "09:40"), [fresh], { enabledAt: at(D, "09:35") }).messages).toHaveLength(0);
    expect(plan(at(D, "09:40"), [fresh], { enabledAt: null }).messages).toHaveLength(0);
    expect(plan(at("2026-11-06", "09:40"), [fresh]).messages).toHaveLength(0);
  });

  it("escalates after N unanswered chases and stops chasing; cut-off time is a heads-up only", () => {
    const p = plan(at(D, "13:00"), [task()], { unanswered: new Map([["t1", 3]]) });
    expect(p.messages).toHaveLength(0);
    expect(p.escalations).toEqual([expect.objectContaining({ reason: "count", chases: 3, ownerUserId: "u1" })]);
    const cut = plan(at(D, "18:00"), [task({ override: { escalateAt: "18:00", escalateAfterChases: 0 } })]);
    expect(cut.escalations.map((e) => e.reason)).toEqual(["time"]);
    expect(cut.messages).toHaveLength(1);
  });

  it("per-task override: chasing off or another cadence", () => {
    expect(plan(at(D, "10:00"), [task({ override: { chaseEnabled: false } })]).messages).toHaveLength(0);
    expect(plan(at(D, "10:00"), [task({ override: { chaseEveryMinutes: 30 } })]).messages[0]!.dedupeKey).toBe(`chase:t1:${D}:2`);
  });

  it("morning list only when switched on", () => {
    const later = task({ dueDate: "2026-11-20" });
    expect(plan(at(D, "09:00"), [later]).messages).toHaveLength(0);
    const on = plan(at(D, "09:00"), [later], { settings: { ...DEFAULT_STAFF_SETTINGS, morningList: true } }).messages;
    expect(on.map((m) => m.dedupeKey)).toEqual([`list:${D}`]);
  });
});

describe("staff settings", () => {
  it("defaults, per-person merge and validation", () => {
    expect(parseStaffDefaults(null)).toEqual(DEFAULT_STAFF_SETTINGS);
    expect(parseStaffDefaults({ chaseEveryMinutes: 5 })).toEqual(DEFAULT_STAFF_SETTINGS);
    expect(staffDefaultsSchema.safeParse({ ...DEFAULT_STAFF_SETTINGS, workStart: "20:00", workEnd: "09:00" }).success).toBe(false);
    const o = staffPersonOverrideSchema.parse({ workStart: "", chaseEveryMinutes: "60", morningList: "on" });
    expect(o).toEqual({ chaseEveryMinutes: 60, morningList: true });
    const s = effectiveStaffSettings(DEFAULT_STAFF_SETTINGS, parsePersonOverride(o));
    expect(s.chaseEveryMinutes).toBe(60);
    expect(taskChaseSettings(s, { escalateAt: null }).escalateAt).toBeNull();
    expect(taskChaseSettings(s, {}).chaseEnabled).toBe(true);
  });
});

describe("Russian messages", () => {
  it("due wording and a new-task message with four buttons", () => {
    expect(ruDue(D, D)).toBe("Срок: сегодня");
    expect(ruDue("2026-10-30", D)).toBe("Просрочено на 3 дн. (срок был 30.10)");
    const m = buildStaffNewTask({ id: "t", title: "A <b>", dueDate: "2026-11-12", priority: "urgent", companyName: "Kiwi Go" }, D);
    expect(m.lines[0]!.text).toBe("Срок: 12.11 · Компания: Kiwi Go · Срочно");
    const r = renderTelegram(m, { "staff_done:t": "a:x" });
    expect(r.text).toContain("A &lt;b&gt;");
  });

  it("a long task list stays under Telegram's limit", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, title: "x".repeat(280), dueDate: D, priority: "normal" as const, companyName: "C" }));
    const r = renderTelegram(buildStaffTaskList(many, D));
    expect(r.text.length).toBeLessThanOrEqual(4096);
    expect(r.text).toContain("…и ещё");
  });
});
