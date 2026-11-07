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
    expect(m9.map((m) => m.dedupeKey)).toEqual([`chase:${D}:09:00`]);
    expect(m9[0]!.payload).toMatchObject({ tasks: [{ id: "t1", dueDate: D }] });
    expect(m9[0]!.expiresAt!.toISOString()).toBe(at(D, "11:00").toISOString());
    expect(plan(at(D, "10:59"), [task()]).messages[0]!.dedupeKey).toBe(`chase:${D}:09:00`);
    expect(plan(at(D, "19:30"), [task()]).messages[0]!.dedupeKey).toBe(`chase:${D}:19:00`);
    // The last slot is cut at the end of working hours.
    expect(plan(at(D, "19:30"), [task()]).messages[0]!.expiresAt!.toISOString()).toBe(at(D, "20:00").toISOString());
    expect(plan(at(D, "20:00"), [task()]).messages).toHaveLength(0);
    // Not before the due day; every day after it.
    expect(plan(at(D, "10:00"), [task({ dueDate: "2026-11-03" })]).messages).toHaveLength(0);
    expect(plan(at("2026-11-09", "13:00"), [task()]).messages[0]!.payload).toMatchObject({ day: "2026-11-09", tasks: [{ id: "t1", dueDate: D }] });
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
    expect(plan(at(D, "10:00"), [task({ override: { chaseEveryMinutes: 30 } })]).messages[0]!.dedupeKey).toBe(`chase:${D}:10:00`);
  });

  it("morning list only when switched on", () => {
    const later = task({ dueDate: "2026-11-20" });
    expect(plan(at(D, "09:00"), [later]).messages).toHaveLength(0);
    const on = plan(at(D, "09:00"), [later], { settings: { ...DEFAULT_STAFF_SETTINGS, morningList: true } }).messages;
    expect(on.map((m) => m.dedupeKey)).toEqual([`list:${D}`]);
  });
});

describe("planForPerson: grouped chase (review A, E)", () => {
  it("8 overdue tasks → ONE chase per slot listing all of them; none in the slot of the switch-on", () => {
    const eight = Array.from({ length: 8 }, (_, i) => task({ id: `t${i}`, dueDate: "2026-10-28" }));
    const m = plan(at(D, "09:10"), eight).messages.filter((x) => x.kind === "staff_chase");
    expect(m).toHaveLength(1);
    expect((m[0]!.payload as { tasks: unknown[] }).tasks).toHaveLength(8);
    // Switched on at 09:05 → nothing in the 09:00 slot, the 11:00 slot chases.
    expect(plan(at(D, "09:10"), eight, { enabledAt: at(D, "09:05") }).messages.filter((x) => x.kind === "staff_chase")).toHaveLength(0);
    expect(plan(at(D, "11:00"), eight, { enabledAt: at(D, "09:05") }).messages.filter((x) => x.kind === "staff_chase")).toHaveLength(1);
  });

  it("a task with its own cadence joins the group of its slot start", () => {
    const p = plan(at(D, "10:00"), [task(), task({ id: "t2", override: { chaseEveryMinutes: 60 } })]).messages;
    expect(p.map((m) => m.dedupeKey).sort()).toEqual([`chase:${D}:09:00`, `chase:${D}:10:00`]);
    const p11 = plan(at(D, "11:00"), [task(), task({ id: "t2", override: { chaseEveryMinutes: 60 } })]).messages;
    expect(p11.map((m) => m.dedupeKey)).toEqual([`chase:${D}:11:00`]);
    expect((p11[0]!.payload as { tasks: unknown[] }).tasks).toHaveLength(2);
  });

  it("escalation by count is keyed by the last answer, so going quiet again escalates again", async () => {
    const { escalationKey } = await import("@/server/notifications/planner");
    const first = plan(at(D, "13:00"), [task()], { unanswered: new Map([["t1", 3]]) }).escalations[0]!;
    const again = plan(at(D, "17:00"), [task()], {
      unanswered: new Map([["t1", 3]]),
      answeredAt: new Map([["t1", at(D, "13:30")]]),
    }).escalations[0]!;
    expect(escalationKey(first)).toBe(`esc:t1:${D}:count:never`);
    expect(escalationKey(again)).not.toBe(escalationKey(first));
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
