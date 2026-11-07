/**
 * Routines: recurring jobs assigned to a person (staff, on Telegram) or a founder — e.g. "Elmurat:
 * daily 1C entries for all companies, Mon–Sat 15:00, confirm per company". Pure (schedule maths,
 * chase settings, checklist state, form schemas, the plain-language summary), shared by the server,
 * the forms and tests.
 *
 * Every timing is a setting: global staff defaults (Settings → Team on Telegram) → the person's
 * override → the routine's own chase override (founder routines: their own defaults ← override).
 *
 * A day has ONE run. A routine can ask several times a day ("10:00 and 16:00"): every ask after the
 * first re-asks only what is still open on that run, and reminders follow each ask.
 */
import { z } from "zod";
import { addDays, hmToMinutes, isHmTime, isIsoDate, isoWeekday, localMinutesOfDay, todayInTimeZone, zonedTimeToUtc, type IsoDate } from "./dates";
import type { StaffSettings } from "./staff-schemas";

export const ROUTINE_TIMEZONE = "Asia/Bishkek";
/** "ended": past its "Ends on" date (no new runs; set by the planner, shown in the list). */
export const ROUTINE_STATUSES = ["active", "paused", "ended", "archived"] as const;
export type RoutineStatus = (typeof ROUTINE_STATUSES)[number];
export const ROUTINE_CONFIRMATIONS = ["button", "checklist", "number"] as const;
export type RoutineConfirmation = (typeof ROUTINE_CONFIRMATIONS)[number];
export const RUN_STATUSES = ["open", "escalated", "done", "partly", "missed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
/** Runs still waiting for the assignee (they can tick until the day ends). */
export const OPEN_RUN_STATUSES: readonly RunStatus[] = ["open", "escalated"];

export const WEEKDAYS_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const WEEKDAYS_RU = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"] as const;

/** At most this many asks a day. */
export const MAX_ASK_TIMES = 6;

export type RoutineSchedule =
  | { kind: "weekly"; days: number[]; time: string; times?: string[] }
  | { kind: "monthly"; monthDay: number; time: string; times?: string[] };

export interface ChecklistItem {
  key: string;
  label: string;
  /** Optional instructions, shown in italics under the item. */
  details?: string;
  /** The bot asks for a comment when this item is ticked. */
  needsComment?: boolean;
}

// ---------------------------------------------------------------------------
// Item state on a run
// ---------------------------------------------------------------------------

export const ITEM_STATES = ["done", "partly", "cant"] as const;
export type ItemState = (typeof ITEM_STATES)[number];
/** The state key of a routine without a checklist (one "Готово" button): the run itself. */
export const RUN_ITEM_KEY = "_run";

export interface ItemStateRecord {
  state: ItemState;
  /** ISO instant it was ticked / marked. */
  at: string;
  /** Who did it (display name) and their id. */
  by: string;
  byPersonId?: string | null;
  byUserId?: string | null;
  comment?: string | null;
}
export type ItemStates = Record<string, ItemStateRecord>;

/** What the assignee's next text message is for: a comment on an item (or the whole run, item null). */
export interface AwaitingComment {
  item: string | null;
  kind: "comment" | "done" | "partly" | "cant";
  /** ISO instant the bot asked (a prompt older than AWAIT_COMMENT_MINUTES is ignored). */
  since: string;
  /** The Telegram message to update once the comment arrives. */
  chatId?: number | string | null;
  messageId?: number | null;
}
/** A comment prompt is answered by the next text within this many minutes. */
export const AWAIT_COMMENT_MINUTES = 60;

interface RunLike {
  items: readonly ChecklistItem[];
  itemsDone: readonly string[];
  itemStates?: ItemStates | null;
}

/** The state of an item (or RUN_ITEM_KEY): done (also from the older itemsDone list), partly, can't or open. */
export function itemStateOf(run: RunLike, key: string): ItemState | "open" {
  const s = run.itemStates?.[key]?.state;
  if (s) return s;
  return run.itemsDone.includes(key) ? "done" : "open";
}

/** Checklist items not resolved yet (not done, not marked partly / can't): what a reminder asks about. */
export function openItems(run: RunLike): ChecklistItem[] {
  return run.items.filter((i) => itemStateOf(run, i.key) === "open");
}

/** "3/5": items done of all (a button routine: 0/1 or 1/1). */
export function runProgress(run: RunLike & { status?: string }): { done: number; total: number } {
  if (!run.items.length) return { done: run.status === "done" ? 1 : 0, total: 1 };
  return { done: run.items.filter((i) => itemStateOf(run, i.key) === "done").length, total: run.items.length };
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

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

/** Within the routine's optional start / end dates (both inclusive)? */
export function isWithinDates(r: { startsOn?: string | null; endsOn?: string | null }, day: IsoDate): boolean {
  if (r.startsOn && day < r.startsOn) return false;
  if (r.endsOn && day > r.endsOn) return false;
  return true;
}

/** The next scheduled day on or after `from` (within a year, and not after `endsOn`), or null. */
export function nextScheduledDay(s: RoutineSchedule, from: IsoDate, dates: { startsOn?: string | null; endsOn?: string | null } = {}): IsoDate | null {
  for (let i = 0; i < 370; i++) {
    const d = addDays(from, i);
    if (dates.endsOn && d > dates.endsOn) return null;
    if (isScheduledOn(s, d) && isWithinDates(dates, d)) return d;
  }
  return null;
}

/**
 * When the bot asks next: a later ask time today (a scheduled day, within the dates, today's run
 * not closed), else the first ask time of the next scheduled day. Null when there is none (ended).
 */
export function nextAskAt(
  r: { schedule: RoutineSchedule; startsOn?: string | null; endsOn?: string | null; timezone: string },
  now: Date,
  opts: { todayClosed?: boolean } = {},
): Date | null {
  const times = askTimesOf({ time: r.schedule.time, times: r.schedule.times });
  const today = todayInTimeZone(now, r.timezone);
  const minutes = localMinutesOfDay(now, r.timezone);
  if (!opts.todayClosed && isScheduledOn(r.schedule, today) && isWithinDates(r, today)) {
    const later = times.find((t) => hmToMinutes(t) > minutes);
    if (later) return zonedTimeToUtc(today, later, r.timezone);
  }
  const next = nextScheduledDay(r.schedule, addDays(today, 1), r);
  return next ? zonedTimeToUtc(next, times[0]!, r.timezone) : null;
}

/** The ask times of a routine, sorted (older rows: just `time`). */
export function askTimesOf(r: { time: string; times?: readonly string[] | null }): string[] {
  const list = r.times && r.times.length ? [...r.times] : [r.time];
  return [...new Set(list)].sort((a, b) => hmToMinutes(a) - hmToMinutes(b));
}

function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "Mon–Sat", "Tue, Wed, Sat", "Every day", "Monthly on day 5". */
export function describeDays(s: RoutineSchedule): string {
  if (s.kind === "monthly") return `Monthly on day ${s.monthDay}${s.monthDay >= 29 ? " (or the month's last day)" : ""}`;
  const days = [...new Set(s.days)].sort((a, b) => a - b);
  if (days.length === 7) return "Every day";
  const contiguous = days.length >= 3 && days.every((d, i) => i === 0 || d === days[i - 1]! + 1);
  return contiguous ? `${WEEKDAYS_EN[days[0]! - 1]}–${WEEKDAYS_EN[days[days.length - 1]! - 1]}` : days.map((d) => WEEKDAYS_EN[d - 1]).join(", ");
}

/** "Mon–Sat 15:00", "Tue, Wed, Sat 10:00, 16:00", "Monthly on day 5, 10:00". */
export function describeSchedule(s: RoutineSchedule): string {
  const times = (s.times?.length ? s.times : [s.time]).join(", ");
  if (s.kind === "monthly") return `${describeDays(s)}, ${times}`;
  return `${describeDays(s)} ${times}`;
}

// ---------------------------------------------------------------------------
// Chase settings
// ---------------------------------------------------------------------------

/**
 * How reminders go after each ask: "once" = no reminders; "every" = every N minutes until the
 * "remind until" time; "times" = N reminders, N minutes apart (still not after "until").
 */
export const REMINDER_MODES = ["once", "every", "times"] as const;
export type ReminderMode = (typeof REMINDER_MODES)[number];

/** Per-routine override (every field optional: blank = the person's / global default). */
export interface RoutineChaseOverride {
  reminderMode?: ReminderMode;
  /** "times" mode: how many reminders after each ask. */
  remindTimes?: number;
  chaseEveryMinutes?: number;
  /** No reminders after this time (the run stays open until the day ends). Default: end of working hours. */
  chaseUntil?: string;
  /** Tell the founders if still not done at this time (null = off). */
  escalateAt?: string | null;
  /** Tell the founders after this many reminders without it being done (0 = never by count). */
  escalateAfterChases?: number;
  /** Which founders (users.id) are told; empty / absent = both (a founder's own routine: the other one). */
  escalateTo?: string[];
  /** At most this many messages about this routine per day (the asks included). */
  maxPerDay?: number;
}

export interface RoutineChase {
  reminderMode: ReminderMode;
  remindTimes: number;
  chaseEveryMinutes: number;
  chaseUntil: string;
  escalateAt: string | null;
  escalateAfterChases: number;
  escalateTo: string[];
  maxPerDay: number;
}

/** The person's (or global) staff settings ← the routine's override. Staff default: remind every N until the end of the day. */
export function effectiveRoutineChase(
  s: Pick<StaffSettings, "chaseEveryMinutes" | "workEnd" | "escalateAt" | "escalateAfterChases" | "maxPerDay"> & {
    reminderMode?: ReminderMode;
    remindTimes?: number;
  },
  o: RoutineChaseOverride,
): RoutineChase {
  return {
    reminderMode: o.reminderMode ?? s.reminderMode ?? "every",
    remindTimes: o.remindTimes ?? s.remindTimes ?? 1,
    chaseEveryMinutes: o.chaseEveryMinutes ?? s.chaseEveryMinutes,
    chaseUntil: o.chaseUntil ?? s.workEnd,
    escalateAt: o.escalateAt === undefined ? s.escalateAt : o.escalateAt,
    escalateAfterChases: o.escalateAfterChases ?? s.escalateAfterChases,
    escalateTo: o.escalateTo ?? [],
    maxPerDay: o.maxPerDay ?? s.maxPerDay,
  };
}

/**
 * Founder routines do not use the staff chase (every 120 min, up to 12 a day): a founder gets the
 * ask and at most ONE reminder (3 hours later, before the end of the staff working day), and no
 * escalation unless the routine sets one. Every field can still be set per routine.
 */
export const FOUNDER_ROUTINE_CHASE: Omit<RoutineChase, "chaseUntil" | "escalateTo"> = {
  reminderMode: "times",
  remindTimes: 1,
  chaseEveryMinutes: 180,
  escalateAt: null,
  escalateAfterChases: 0,
  maxPerDay: 2,
};

/** The founder routine defaults ← the routine's override (`s`: global staff defaults, for "until"). */
export function effectiveFounderRoutineChase(s: Pick<StaffSettings, "workEnd">, o: RoutineChaseOverride): RoutineChase {
  return effectiveRoutineChase({ ...FOUNDER_ROUTINE_CHASE, workEnd: s.workEnd }, o);
}

export interface RoutineSlot {
  /** 0, 1, 2 … in time order (one message per run per slot). */
  slot: number;
  start: number;
  end: number;
  /** A reminder (counts towards "escalate after N reminders") rather than an ask. */
  reminder: boolean;
  /** Which ask of the day (0 = the first) it belongs to. */
  ask: number;
}

/**
 * The message slots of one run: an ask at each ask time; after each ask the reminders of the
 * chosen mode, before the next ask and before `chaseUntil`. At most `maxPerDay` messages — the asks
 * always count first, reminders fill what is left in time order. Minutes of the local day.
 */
export function routineSlots(times: string | readonly string[], c: RoutineChase): RoutineSlot[] {
  const asks = (typeof times === "string" ? [times] : askTimesOf({ time: times[0] ?? "00:00", times })).map(hmToMinutes);
  if (!asks.length) return [];
  const until = Math.max(hmToMinutes(c.chaseUntil), asks[0]! + 1);
  const raw: Omit<RoutineSlot, "slot" | "end">[] = [];
  asks.forEach((a, i) => {
    raw.push({ start: a, reminder: false, ask: i });
    if (c.reminderMode === "once") return;
    const next = asks[i + 1] ?? 24 * 60;
    for (let k = 1; k <= 200; k++) {
      if (c.reminderMode === "times" && k > c.remindTimes) break;
      const s = a + k * c.chaseEveryMinutes;
      if (s >= next || s >= until || s >= 24 * 60) break;
      raw.push({ start: s, reminder: true, ask: i });
    }
  });
  let room = Math.max(0, c.maxPerDay - asks.length);
  const kept = raw.filter((r) => {
    if (!r.reminder) return true;
    if (room <= 0) return false;
    room--;
    return true;
  });
  return kept.map((r, i) => {
    const following = kept[i + 1]?.start ?? 24 * 60;
    const end = Math.min(following, r.start + Math.max(c.chaseEveryMinutes, 1), 24 * 60);
    return { ...r, slot: i, end: Math.max(end, r.start + 1) };
  });
}

export const minutesToHm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** "2 h", "90 min". */
export function describeMinutes(m: number): string {
  return m % 60 === 0 ? `${m / 60} h` : `${m} min`;
}

// ---------------------------------------------------------------------------
// The plain-language summary (form, detail page)
// ---------------------------------------------------------------------------

export interface RoutinePlanText {
  assigneeName: string;
  forFounder: boolean;
  schedule: RoutineSchedule;
  chase: RoutineChase;
  /** Names of who is told on escalation ("Nuraaly", "both founders"). */
  escalateNames: string;
  startsOn?: string | null;
  endsOn?: string | null;
}

const ddmm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/**
 * "Bot asks Asan Mon–Sat at 15:00, reminds every 2 h until 19:00; if not done by 19:00 it tells
 * Nuraaly." A founder's routine says whether the founder will be chased.
 */
export function describeRoutinePlan(p: RoutinePlanText): string {
  const times = askTimesOf({ time: p.schedule.time, times: p.schedule.times });
  const days = describeDays(p.schedule);
  const when = `${p.schedule.kind === "monthly" ? days.replace(/^Monthly/, "monthly") : days} at ${joinAnd(times)}`;
  const c = p.chase;
  const reAsk = times.length > 1 ? " (each later ask only about what is still open)" : "";
  let remind: string;
  if (c.reminderMode === "once") remind = "no reminders";
  else if (c.reminderMode === "times") {
    remind = `${c.remindTimes === 1 ? "1 reminder" : `${c.remindTimes} reminders`} ${describeMinutes(c.chaseEveryMinutes)} apart${times.length > 1 ? " after each ask" : ""}, not after ${c.chaseUntil}`;
  } else remind = `reminds every ${describeMinutes(c.chaseEveryMinutes)} until ${c.chaseUntil}`;
  const esc =
    c.escalateAt && c.escalateAfterChases
      ? `if not done by ${c.escalateAt} (or after ${c.escalateAfterChases} reminders) it tells ${p.escalateNames}`
      : c.escalateAt
        ? `if not done by ${c.escalateAt} it tells ${p.escalateNames}`
        : c.escalateAfterChases
          ? `if still not done after ${c.escalateAfterChases} reminders it tells ${p.escalateNames}`
          : "nobody else is told if it is not done";
  const dates =
    p.startsOn && p.endsOn
      ? ` Runs from ${ddmm(p.startsOn)} to ${ddmm(p.endsOn)}.`
      : p.endsOn
        ? ` Ends on ${ddmm(p.endsOn)}.`
        : p.startsOn
          ? ` Starts on ${ddmm(p.startsOn)}.`
          : "";
  const name = p.assigneeName || "the person";
  if (p.forFounder) {
    const chased = c.reminderMode === "once" ? `${name} is asked once and not chased` : `${name} will be chased: ${remind.replace(/^reminds/, "a reminder")}`;
    return `${name} gets the ask ${when}${reAsk} in their own channel; ${chased}; ${esc}.${dates}`;
  }
  return `Bot asks ${name} ${when}${reAsk}, ${remind}; ${esc}.${dates}`;
}

// ---------------------------------------------------------------------------
// Form / API input
// ---------------------------------------------------------------------------

const blank = (v: unknown) => (v === "" || v === null || v === undefined ? undefined : v);
const hm = z.string().refine(isHmTime, { message: "Use HH:MM (e.g. 15:00)" });
const isoDate = z.string().refine(isIsoDate, { message: "Use a date (YYYY-MM-DD)" });
const uuidLike = /^[0-9a-f-]{36}$/i;

export const routineChaseOverrideSchema = z
  .object({
    reminderMode: z.preprocess(blank, z.enum(REMINDER_MODES).optional()),
    remindTimes: z.preprocess(blank, z.coerce.number().int().min(1, "At least 1").max(20, "At most 20").optional()),
    chaseEveryMinutes: z.preprocess(blank, z.coerce.number().int().min(15, "At least 15 minutes").max(1440).optional()),
    chaseUntil: z.preprocess(blank, hm.optional()),
    escalateAt: z.preprocess((v) => (v === "" || v === undefined ? undefined : v === "off" || v === null ? null : v), hm.nullable().optional()),
    escalateAfterChases: z.preprocess(blank, z.coerce.number().int().min(0).max(50).optional()),
    escalateTo: z.preprocess(
      (v) => {
        if (v === undefined || v === null || v === "") return undefined;
        const list = Array.isArray(v) ? v : String(v).split(",");
        return list.map((x) => String(x).trim()).filter(Boolean);
      },
      z.array(z.string().regex(uuidLike, { message: "Unknown founder" })).max(10).optional(),
    ),
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

/** One checklist item as the form / API sends it (a key only for an existing item). */
export interface ChecklistItemInput {
  key?: string;
  label: string;
  details?: string;
  needsComment?: boolean;
}

function toItemInputs(v: unknown): ChecklistItemInput[] {
  let list: unknown = v;
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("[")) {
      try {
        list = JSON.parse(s);
      } catch {
        list = [];
      }
    } else list = s.split(/\r?\n/);
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((x): ChecklistItemInput => {
      if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        return {
          key: typeof o.key === "string" && o.key ? o.key : undefined,
          label: String(o.label ?? "").trim(),
          details: typeof o.details === "string" ? o.details.trim() : "",
          needsComment: o.needsComment === true || o.needsComment === "true",
        };
      }
      return { label: String(x ?? "").trim(), details: "", needsComment: false };
    })
    .filter((x) => x.label.length > 0);
}

/**
 * Checklist items: one per line (blank lines ignored), an array of labels, or the checklist editor's
 * JSON ([{ key?, label, details?, needsComment? }]). 1–20 items, a label at most 60 characters,
 * no duplicates.
 */
export const checklistItemsSchema = z.preprocess(
  toItemInputs,
  z
    .array(
      z.object({
        key: z.string().max(20).optional(),
        label: z.string().max(60, "An item is at most 60 characters"),
        details: z.string().max(500, "Details are at most 500 characters").optional(),
        needsComment: z.boolean().optional(),
      }),
    )
    .max(20, "At most 20 items")
    .refine((a) => new Set(a.map((x) => x.label.toLowerCase())).size === a.length, { message: "Items must be different" }),
);
/** @deprecated name kept for callers of the one-label-per-line version. */
export const checklistLabelsSchema = checklistItemsSchema;

const timesSchema = z
  .array(hm)
  .min(1, "Add at least one time")
  .max(MAX_ASK_TIMES, `At most ${MAX_ASK_TIMES} times a day`)
  .refine((a) => new Set(a).size === a.length, { message: "Times must be different" });

export const routineInputSchema = z
  .preprocess(
    (raw) => {
      if (!raw || typeof raw !== "object") return raw;
      const o = { ...(raw as Record<string, unknown>) };
      // `times` (a list, or "10:00, 16:00") wins; else the single `time`.
      let times = o.times;
      if (typeof times === "string") times = times.split(/[,\s]+/).filter(Boolean);
      if (!Array.isArray(times) || !times.length) times = typeof o.time === "string" && o.time ? [o.time] : [];
      o.times = (times as unknown[]).map((x) => String(x).trim());
      return o;
    },
    z.object({
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
      times: timesSchema,
      startsOn: z.preprocess(blank, isoDate.optional()),
      endsOn: z.preprocess(blank, isoDate.optional()),
      confirmation: z.enum(["button", "checklist"]),
      items: checklistItemsSchema,
      chase: routineChaseOverrideSchema.default({}),
      /** Editing while today's run is already done: also add the new items to today's run (reopens it). */
      applyToToday: z.preprocess((v) => v === true || v === "true" || v === "on" || v === "1", z.boolean()).default(false),
    }),
  )
  .superRefine((v, ctx) => {
    if (v.scheduleKind === "weekly" && v.days.length === 0) ctx.addIssue({ code: "custom", path: ["days"], message: "Pick at least one day" });
    if (v.scheduleKind === "monthly" && !v.monthDay) ctx.addIssue({ code: "custom", path: ["monthDay"], message: "Pick the day of the month" });
    if (v.confirmation === "checklist" && v.items.length === 0) ctx.addIssue({ code: "custom", path: ["items"], message: "Add at least one item" });
    const first = v.times.filter(isHmTime).sort((a, b) => hmToMinutes(a) - hmToMinutes(b))[0];
    if (first && v.chase.chaseUntil && isHmTime(v.chase.chaseUntil) && hmToMinutes(v.chase.chaseUntil) <= hmToMinutes(first)) {
      ctx.addIssue({ code: "custom", path: ["chase", "chaseUntil"], message: "Must be after the first ask time" });
    }
    if (v.startsOn && v.endsOn && v.endsOn < v.startsOn) ctx.addIssue({ code: "custom", path: ["endsOn"], message: "Must be on or after the start date" });
  });
export type RoutineInput = z.input<typeof routineInputSchema>;
export type RoutineParsed = z.output<typeof routineInputSchema>;

/**
 * Stable keys for checklist items: an item sent with an existing key keeps it, else an existing
 * label keeps its key (ticks of open runs stay valid); new items get the next free key.
 */
export function checklistItems(input: readonly (string | ChecklistItemInput)[], previous: readonly ChecklistItem[] = []): ChecklistItem[] {
  const prevKeys = new Set(previous.map((p) => p.key));
  const byLabel = new Map(previous.map((p) => [p.label.toLowerCase(), p.key]));
  const used = new Set<string>();
  let n = previous.reduce((m, p) => Math.max(m, Number(p.key.replace(/^i/, "")) || 0), 0);
  return input.map((raw) => {
    const it: ChecklistItemInput = typeof raw === "string" ? { label: raw } : raw;
    let key = it.key && prevKeys.has(it.key) && !used.has(it.key) ? it.key : byLabel.get(it.label.toLowerCase());
    if (!key || used.has(key)) key = `i${++n}`;
    used.add(key);
    const out: ChecklistItem = { key, label: it.label };
    if (it.details) out.details = it.details;
    if (it.needsComment) out.needsComment = true;
    return out;
  });
}

export function scheduleOf(r: { scheduleKind: string; days: number[] | null; monthDay: number | null; time: string; times?: string[] | null }): RoutineSchedule {
  const times = askTimesOf(r);
  return r.scheduleKind === "monthly"
    ? { kind: "monthly", monthDay: r.monthDay ?? 1, time: times[0]!, times }
    : { kind: "weekly", days: r.days ?? [], time: times[0]!, times };
}

/**
 * How a run went, for the history: done on time (before chaseUntil and before any escalation),
 * done late, partly (which items were missing), missed, or "cant" (closed with an item the person
 * said they cannot do).
 */
export function runOutcome(
  run: { status: RunStatus; doneAt: Date | null; escalatedAt: Date | null; itemStates?: ItemStates | null },
  untilAt: Date,
): "on_time" | "late" | "partly" | "missed" | "cant" | "open" {
  if (run.status === "done") {
    return run.escalatedAt || (run.doneAt && run.doneAt.getTime() > untilAt.getTime()) ? "late" : "on_time";
  }
  const cant = Object.values(run.itemStates ?? {}).some((s) => s.state === "cant");
  if ((run.status === "partly" || run.status === "missed") && cant) return "cant";
  if (run.status === "partly") return "partly";
  if (run.status === "missed") return "missed";
  return "open";
}
