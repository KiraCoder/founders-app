/**
 * Staff on Telegram: the chase settings (global defaults, per-person and per-task overrides) and
 * the inputs of the founder-facing forms. Pure (shared by the server, the forms and tests).
 *
 * Staff are chased persistently on purpose (the founders' call: "keep asking until done"), so they
 * have their own cadence instead of the founders' strict 3-per-day budget. Quiet hours, working
 * hours, a daily cap and "one push per task per slot" still apply.
 */
import { z } from "zod";
import { isHmTime, isIsoDate } from "./dates";

export const STAFF_DEFAULTS_KEY = "staff_notification_defaults";

export interface StaffSettings {
  /** No staff message at all inside quiet hours (they wait until the end). */
  quietStart: string;
  quietEnd: string;
  /** Chases go out only inside working hours, on the due day and after. */
  workStart: string;
  workEnd: string;
  /** One chase per task per slot of this many minutes (counted from workStart). */
  chaseEveryMinutes: number;
  /** At most this many bot messages to one person per day (replies to their own commands do not count). */
  maxPerDay: number;
  /** Tell the task's founder after this many chases without any answer (0 = never by count). */
  escalateAfterChases: number;
  /** Tell the task's founder if still open at this time on the due day or later (null = off). */
  escalateAt: string | null;
  /** Morning list of their open tasks (off by default). */
  morningList: boolean;
  morningListTime: string;
}

export const DEFAULT_STAFF_SETTINGS: StaffSettings = {
  quietStart: "21:00",
  quietEnd: "08:00",
  workStart: "09:00",
  workEnd: "20:00",
  chaseEveryMinutes: 120,
  maxPerDay: 12,
  escalateAfterChases: 3,
  escalateAt: null,
  morningList: false,
  morningListTime: "09:00",
};

/** Per-task overrides (task page): chasing off, another cadence or escalation. */
export interface StaffTaskOverride {
  chaseEnabled?: boolean;
  chaseEveryMinutes?: number;
  escalateAfterChases?: number;
  escalateAt?: string | null;
}

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const hm = z.string().refine(isHmTime, { message: "Use HH:MM (e.g. 09:00)" });
const nullableHm = z.preprocess((v) => (v === "" || v === "off" ? null : v), hm.nullable());
const formBool = z.preprocess((v) => v === true || v === "on" || v === "true" || v === "1", z.boolean());
const minutes = z.coerce.number().int().min(15, "At least 15 minutes").max(1440, "At most 1440 minutes (a day)");
const perDay = z.coerce.number().int().min(1, "At least 1").max(50, "At most 50");
const escalateCount = z.coerce.number().int().min(0, "0 (never) or more").max(50, "At most 50");

function checkWindows(p: Partial<StaffSettings>, ctx: z.RefinementCtx) {
  if (p.workStart && p.workEnd && p.workStart >= p.workEnd) {
    ctx.addIssue({ code: "custom", path: ["workEnd"], message: "Working hours must end after they start (same day)" });
  }
}

/** Global defaults (Settings → Team on Telegram). Every field required. */
export const staffDefaultsSchema = z
  .object({
    quietStart: hm,
    quietEnd: hm,
    workStart: hm,
    workEnd: hm,
    chaseEveryMinutes: minutes,
    maxPerDay: perDay,
    escalateAfterChases: escalateCount,
    escalateAt: nullableHm,
    morningList: formBool,
    morningListTime: hm,
  })
  .strict()
  .superRefine(checkWindows);
export type StaffDefaultsInput = z.input<typeof staffDefaultsSchema>;

/** Per-person overrides: every field optional; a blank field means "use the default". */
export const staffPersonOverrideSchema = z
  .object({
    quietStart: z.preprocess(blank, hm.optional()),
    quietEnd: z.preprocess(blank, hm.optional()),
    workStart: z.preprocess(blank, hm.optional()),
    workEnd: z.preprocess(blank, hm.optional()),
    chaseEveryMinutes: z.preprocess(blank, minutes.optional()),
    maxPerDay: z.preprocess(blank, perDay.optional()),
    escalateAfterChases: z.preprocess(blank, escalateCount.optional()),
    escalateAt: z.preprocess((v) => (v === "" ? undefined : v === "off" ? null : v), hm.nullable().optional()),
    morningList: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), formBool.optional()),
    morningListTime: z.preprocess(blank, hm.optional()),
  })
  .strict()
  .superRefine(checkWindows);
export type StaffPersonOverride = z.output<typeof staffPersonOverrideSchema>;

export const staffTaskOverrideSchema = z
  .object({
    chaseEnabled: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), formBool.optional()),
    chaseEveryMinutes: z.preprocess(blank, minutes.optional()),
    escalateAfterChases: z.preprocess(blank, escalateCount.optional()),
    escalateAt: z.preprocess((v) => (v === "" ? undefined : v === "off" ? null : v), hm.nullable().optional()),
  })
  .strict();

/** Drops undefined keys (so an all-blank form clears the override). */
export function compactOverride<T extends object>(o: T): Partial<T> | null {
  const out = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
  return Object.keys(out).length ? out : null;
}

/** Reads stored JSON leniently: unknown or invalid values fall back (one bad value never breaks a tick). */
export function parseStaffDefaults(raw: unknown): StaffSettings {
  const r = staffDefaultsSchema.safeParse({ ...DEFAULT_STAFF_SETTINGS, ...(isObject(raw) ? raw : {}) });
  return r.success ? r.data : { ...DEFAULT_STAFF_SETTINGS };
}

export function parsePersonOverride(raw: unknown): Partial<StaffSettings> {
  if (!isObject(raw)) return {};
  const r = staffPersonOverrideSchema.safeParse(raw);
  return r.success ? (compactOverride(r.data) ?? {}) : {};
}

export function parseTaskOverride(raw: unknown): StaffTaskOverride {
  if (!isObject(raw)) return {};
  const r = staffTaskOverrideSchema.safeParse(raw);
  return r.success ? (compactOverride(r.data) ?? {}) : {};
}

/** Defaults ← person overrides; a person override that makes working hours invalid is ignored. */
export function effectiveStaffSettings(defaults: StaffSettings, person: Partial<StaffSettings>): StaffSettings {
  const merged = { ...defaults, ...person };
  return merged.workStart < merged.workEnd ? merged : { ...merged, workStart: defaults.workStart, workEnd: defaults.workEnd };
}

/** The chase rules for one task: the person's settings ← the task's override. */
export function taskChaseSettings(
  s: StaffSettings,
  task: StaffTaskOverride,
): Pick<StaffSettings, "chaseEveryMinutes" | "escalateAfterChases" | "escalateAt"> & { chaseEnabled: boolean } {
  return {
    chaseEnabled: task.chaseEnabled ?? true,
    chaseEveryMinutes: task.chaseEveryMinutes ?? s.chaseEveryMinutes,
    escalateAfterChases: task.escalateAfterChases ?? s.escalateAfterChases,
    escalateAt: task.escalateAt === undefined ? s.escalateAt : task.escalateAt,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Comment text (app or Telegram). */
export const commentTextSchema = z.string().trim().min(1, "Write something").max(4000, "At most 4000 characters");

/** "Pause until": a date (the whole day) or empty to resume now. */
export const pauseUntilSchema = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z.string().refine(isIsoDate, { message: "Use a valid date" }).nullable(),
);
