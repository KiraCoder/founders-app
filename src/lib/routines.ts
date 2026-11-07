/**
 * Routines: recurring jobs assigned to a person (staff, on Telegram) or a founder — e.g. "Elmurat:
 * daily 1C entries for all companies, Mon–Sat 15:00, confirm per company". Pure (schedule maths,
 * chase settings, form schemas), shared by the server, the forms and tests.
 *
 * Every timing is a setting: global staff defaults (Settings → Team on Telegram) → the person's
 * override → the routine's own chase override.
 */
import { z } from "zod";
import { addDays, hmToMinutes, isHmTime, isoWeekday, type IsoDate } from "./dates";
import type { StaffSettings } from "./staff-schemas";

export const ROUTINE_TIMEZONE = "Asia/Bishkek";
export const ROUTINE_STATUSES = ["active", "paused", "archived"] as const;
export type RoutineStatus = (typeof ROUTINE_STATUSES)[number];
export const ROUTINE_CONFIRMATIONS = ["button", "checklist", "number"] as const;
export type RoutineConfirmation = (typeof ROUTINE_CONFIRMATIONS)[number];
export const RUN_STATUSES = ["open", "escalated", "done", "partly", "missed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
/** Runs still waiting for the assignee (they can tick until the day ends). */
export const OPEN_RUN_STATUSES: readonly RunStatus[] = ["open", "escalated"];

export const WEEKDAYS_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const WEEKDAYS_RU = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"] as const;

export type RoutineSchedule =
  | { kind: "weekly"; days: number[]; time: string }
  | { kind: "monthly"; monthDay: number; time: string };

export interface ChecklistItem {
  key: string;
  label: string;
}

function daysInMonth(iso: IsoDate): number {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Is `day` (a local date in the routine's time zone) a scheduled day? Monthly 31 → the last day of short months. */
export function isScheduledOn(s: RoutineSchedule, day: IsoDate): boolean {
  if (s.kind === "weekly") return s.days.includes(isoWeekday(day));
  const dom = Number(day.slice(8, 10));
  return dom === Math.min(s.monthDay, daysInMonth(day));
}

/** The next scheduled day on or after `from` (within a year), or null. */
export function nextScheduledDay(s: RoutineSchedule, from: IsoDate): IsoDate | null {
  for (let i = 0; i < 370; i++) {
    const d = addDays(from, i);
    if (isScheduledOn(s, d)) return d;
  }
  return null;
}

/** "Mon–Sat 15:00", "Tue, Wed, Sat 10:00", "Monthly on the 5th, 10:00". */
export function describeSchedule(s: RoutineSchedule): string {
  if (s.kind === "monthly") return `Monthly on day ${s.monthDay}${s.monthDay >= 29 ? " (or the month's last day)" : ""}, ${s.time}`;
  const days = [...new Set(s.days)].sort((a, b) => a - b);
  if (days.length === 7) return `Every day ${s.time}`;
  const contiguous = days.length >= 3 && days.every((d, i) => i === 0 || d === days[i - 1]! + 1);
  const label = contiguous ? `${WEEKDAYS_EN[days[0]! - 1]}–${WEEKDAYS_EN[days[days.length - 1]! - 1]}` : days.map((d) => WEEKDAYS_EN[d - 1]).join(", ");
  return `${label} ${s.time}`;
}

// ---------------------------------------------------------------------------
// Chase settings
// ---------------------------------------------------------------------------

/** Per-routine override (every field optional: blank = the person's / global default). */
export interface RoutineChaseOverride {
  chaseEveryMinutes?: number;
  /** No reminders after this time (the run stays open until the day ends). Default: end of working hours. */
  chaseUntil?: string;
  /** Tell the founders if still not done at this time (null = off). */
  escalateAt?: string | null;
  /** Tell the founders after this many reminders without it being done (0 = never by count). */
  escalateAfterChases?: number;
  /** At most this many messages about this routine per day (the ask included). */
  maxPerDay?: number;
}

export interface RoutineChase {
  chaseEveryMinutes: number;
  chaseUntil: string;
  escalateAt: string | null;
  escalateAfterChases: number;
  maxPerDay: number;
}

/** The person's (or global) staff settings ← the routine's override. */
export function effectiveRoutineChase(
  s: Pick<StaffSettings, "chaseEveryMinutes" | "workEnd" | "escalateAt" | "escalateAfterChases" | "maxPerDay">,
  o: RoutineChaseOverride,
): RoutineChase {
  return {
    chaseEveryMinutes: o.chaseEveryMinutes ?? s.chaseEveryMinutes,
    chaseUntil: o.chaseUntil ?? s.workEnd,
    escalateAt: o.escalateAt === undefined ? s.escalateAt : o.escalateAt,
    escalateAfterChases: o.escalateAfterChases ?? s.escalateAfterChases,
    maxPerDay: o.maxPerDay ?? s.maxPerDay,
  };
}

/**
 * Founder routines do not use the staff chase (every 120 min, up to 12 a day): a founder gets the
 * ask and at most ONE reminder (3 hours later, before the end of the staff working day), and no
 * escalation unless the routine sets one. Every field can still be set per routine.
 */
export const FOUNDER_ROUTINE_CHASE: Omit<RoutineChase, "chaseUntil"> = {
  chaseEveryMinutes: 180,
  escalateAt: null,
  escalateAfterChases: 0,
  maxPerDay: 2,
};

/** The founder routine defaults ← the routine's override (`s`: global staff defaults, for "until"). */
export function effectiveFounderRoutineChase(s: Pick<StaffSettings, "workEnd">, o: RoutineChaseOverride): RoutineChase {
  return effectiveRoutineChase({ ...FOUNDER_ROUTINE_CHASE, workEnd: s.workEnd }, o);
}

/**
 * Reminder slots of one run: slot 0 is the ask at `time`, slot k ≥ 1 at time + k × cadence, while
 * before `chaseUntil` and within `maxPerDay` messages. Returns [slot, start minute, end minute].
 */
export function routineSlots(time: string, c: RoutineChase): { slot: number; start: number; end: number }[] {
  const start = hmToMinutes(time);
  const until = Math.max(hmToMinutes(c.chaseUntil), start + 1);
  const out: { slot: number; start: number; end: number }[] = [];
  for (let k = 0; k < c.maxPerDay; k++) {
    const s = start + k * c.chaseEveryMinutes;
    if (s >= until || s >= 24 * 60) break;
    out.push({ slot: k, start: s, end: Math.min(s + c.chaseEveryMinutes, 24 * 60) });
  }
  return out;
}

export const minutesToHm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// ---------------------------------------------------------------------------
// Form / API input
// ---------------------------------------------------------------------------

const blank = (v: unknown) => (v === "" || v === null || v === undefined ? undefined : v);
const hm = z.string().refine(isHmTime, { message: "Use HH:MM (e.g. 15:00)" });

export const routineChaseOverrideSchema = z
  .object({
    chaseEveryMinutes: z.preprocess(blank, z.coerce.number().int().min(15, "At least 15 minutes").max(1440).optional()),
    chaseUntil: z.preprocess(blank, hm.optional()),
    escalateAt: z.preprocess((v) => (v === "" || v === undefined ? undefined : v === "off" || v === null ? null : v), hm.nullable().optional()),
    escalateAfterChases: z.preprocess(blank, z.coerce.number().int().min(0).max(50).optional()),
    maxPerDay: z.preprocess(blank, z.coerce.number().int().min(1, "At least 1").max(50).optional()),
  })
  .strict();

/** "person:<uuid>" or "user:<uuid>" (a founder). */
export const assigneeRefSchema = z
  .string()
  .regex(/^(person|user):[0-9a-f-]{36}$/i, { message: "Pick who does it" })
  .transform((v) => {
    const [kind, id] = v.split(":") as ["person" | "user", string];
    return kind === "person" ? { personId: id, userId: null } : { personId: null, userId: id };
  });

/** Checklist labels: one per line (blank lines ignored), 1–20 items of at most 60 characters, no duplicates. */
export const checklistLabelsSchema = z.preprocess(
  (v) =>
    (Array.isArray(v) ? v : typeof v === "string" ? v.split(/\r?\n/) : [])
      .map((x) => String(x).trim())
      .filter((x) => x.length > 0),
  z
    .array(z.string().max(60, "An item is at most 60 characters"))
    .max(20, "At most 20 items")
    .refine((a) => new Set(a.map((x) => x.toLowerCase())).size === a.length, { message: "Items must be different" }),
);

export const routineInputSchema = z
  .object({
    title: z.string().trim().min(1, "Give it a title").max(200),
    description: z.preprocess((v) => (typeof v === "string" ? v.trim() : ""), z.string().max(2000)),
    companyId: z.preprocess((v) => (v === "" || v === undefined ? null : v), z.uuid({ message: "Unknown company" }).nullable()),
    assignee: assigneeRefSchema,
    scheduleKind: z.enum(["weekly", "monthly"]),
    days: z.preprocess(
      (v) => (Array.isArray(v) ? v : v === undefined || v === "" ? [] : [v]).map(Number),
      z.array(z.number().int().min(1).max(7)),
    ),
    monthDay: z.preprocess(blank, z.coerce.number().int().min(1, "1–31").max(31, "1–31").optional()),
    time: hm,
    confirmation: z.enum(["button", "checklist"]),
    items: checklistLabelsSchema,
    chase: routineChaseOverrideSchema.default({}),
  })
  .superRefine((v, ctx) => {
    if (v.scheduleKind === "weekly" && v.days.length === 0) ctx.addIssue({ code: "custom", path: ["days"], message: "Pick at least one day" });
    if (v.scheduleKind === "monthly" && !v.monthDay) ctx.addIssue({ code: "custom", path: ["monthDay"], message: "Pick the day of the month" });
    if (v.confirmation === "checklist" && v.items.length === 0) ctx.addIssue({ code: "custom", path: ["items"], message: "Add at least one item" });
    if (v.chase.chaseUntil && hmToMinutes(v.chase.chaseUntil) <= hmToMinutes(v.time)) {
      ctx.addIssue({ code: "custom", path: ["chase", "chaseUntil"], message: "Must be after the ask time" });
    }
  });
export type RoutineInput = z.input<typeof routineInputSchema>;
export type RoutineParsed = z.output<typeof routineInputSchema>;

/** Stable keys for checklist labels: an existing label keeps its key (ticks of open runs stay valid). */
export function checklistItems(labels: readonly string[], previous: readonly ChecklistItem[] = []): ChecklistItem[] {
  const byLabel = new Map(previous.map((p) => [p.label.toLowerCase(), p.key]));
  const used = new Set<string>();
  let n = previous.reduce((m, p) => Math.max(m, Number(p.key.replace(/^i/, "")) || 0), 0);
  return labels.map((label) => {
    let key = byLabel.get(label.toLowerCase());
    if (!key || used.has(key)) key = `i${++n}`;
    used.add(key);
    return { key, label };
  });
}

export function scheduleOf(r: { scheduleKind: string; days: number[] | null; monthDay: number | null; time: string }): RoutineSchedule {
  return r.scheduleKind === "monthly"
    ? { kind: "monthly", monthDay: r.monthDay ?? 1, time: r.time }
    : { kind: "weekly", days: r.days ?? [], time: r.time };
}

/**
 * How a closed run went, for the history: done on time (before chaseUntil and before any
 * escalation), done late, partly (which items were missing), missed.
 */
export function runOutcome(run: { status: RunStatus; doneAt: Date | null; escalatedAt: Date | null }, untilAt: Date): "on_time" | "late" | "partly" | "missed" | "open" {
  if (run.status === "done") {
    return run.escalatedAt || (run.doneAt && run.doneAt.getTime() > untilAt.getTime()) ? "late" : "on_time";
  }
  if (run.status === "partly") return "partly";
  if (run.status === "missed") return "missed";
  return "open";
}
