/**
 * The per-task chase control (0032), as plain data for the task form and the task page: the
 * segmented choices, how they map onto the stored override (`tasks.staff_chase`, see
 * staff-schemas.ts) and the live plain-language summary. Pure (client and server).
 *
 * Global defaults stay in Settings → Team on Telegram (and each person's own settings); a task
 * either follows them ("Default") or says explicitly how it is chased.
 */
import { DEFAULT_STAFF_SETTINGS, type FounderNudgeMode, type StaffSettings, type StaffTaskOverride } from "./staff-schemas";

export type ChaseChoice = "default" | "off" | "once" | "every";
export type EscalationChoice = "default" | "off" | "days";
export type EveryUnit = "hours" | "days";

/** What the form shows (and posts). */
export interface ChaseFormValue {
  chase: ChaseChoice;
  everyN: number;
  everyUnit: EveryUnit;
  escalation: EscalationChoice;
  escalateDays: number;
  founderNudge: FounderNudgeMode;
  shareNotes: boolean;
  paused: boolean;
}

export const CHASE_CHOICES: { value: ChaseChoice; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "off", label: "Don't chase" },
  { value: "once", label: "Remind once on the due date" },
  { value: "every", label: "Remind every…" },
];

export const ESCALATION_CHOICES: { value: EscalationChoice; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "off", label: "Never tell founders" },
  { value: "days", label: "If still open N days after due" },
];

export const FOUNDER_NUDGE_CHOICES: { value: FounderNudgeMode; label: string }[] = [
  { value: "usual", label: "Usual reminders" },
  { value: "due_day", label: "Only on the due date" },
  { value: "off", label: "Don't nudge" },
];

/** The stored override → the form's value. */
export function chaseFormValue(o: StaffTaskOverride): ChaseFormValue {
  const legacyOff = o.chaseEnabled === false && !o.chaseMode;
  const mode = o.chaseMode ?? (legacyOff ? "off" : undefined);
  const custom = mode === "every" || (!mode && o.chaseEveryMinutes !== undefined);
  const byDays = !!o.chaseEveryDays;
  return {
    chase: mode ?? (custom ? "every" : "default"),
    everyN: byDays ? o.chaseEveryDays! : o.chaseEveryMinutes ? Math.max(1, Math.round(o.chaseEveryMinutes / 60)) : 2,
    everyUnit: byDays ? "days" : "hours",
    escalation: o.escalateAfterDays === undefined ? "default" : o.escalateAfterDays === null ? "off" : "days",
    escalateDays: typeof o.escalateAfterDays === "number" ? o.escalateAfterDays : 2,
    founderNudge: o.founderNudge ?? "usual",
    shareNotes: o.shareNotes === true,
    paused: o.chasePaused === true,
  };
}

export class ChaseFormError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The form's value → the override to store (null = everything default). The old 0028 fields are
 * replaced by the explicit choice. Throws ChaseFormError for an out-of-range number.
 */
export function overrideFromForm(v: ChaseFormValue): StaffTaskOverride | null {
  const out: StaffTaskOverride = {};
  if (v.chase !== "default") out.chaseMode = v.chase;
  if (v.chase === "every") {
    const n = Math.floor(Number(v.everyN));
    if (v.everyUnit === "days") {
      if (!(n >= 1 && n <= 30)) throw new ChaseFormError("everyN", "Every 1 to 30 days");
      out.chaseEveryDays = n;
    } else {
      if (!(n >= 1 && n <= 12)) throw new ChaseFormError("everyN", "Every 1 to 12 hours");
      out.chaseEveryMinutes = n * 60;
    }
  }
  if (v.escalation === "off") out.escalateAfterDays = null;
  if (v.escalation === "days") {
    const d = Math.floor(Number(v.escalateDays));
    if (!(d >= 0 && d <= 60)) throw new ChaseFormError("escalateDays", "0 to 60 days");
    out.escalateAfterDays = d;
  }
  if (v.founderNudge !== "usual") out.founderNudge = v.founderNudge;
  if (v.shareNotes) out.shareNotes = true;
  if (v.paused) out.chasePaused = true;
  return Object.keys(out).length ? out : null;
}

/** Reads the form fields (FormData entries as strings). */
export function chaseFormFromFields(f: Record<string, string | undefined>, fallback: ChaseFormValue): ChaseFormValue {
  const pick = <T extends string>(value: string | undefined, allowed: readonly T[], d: T): T =>
    allowed.includes(value as T) ? (value as T) : d;
  return {
    chase: pick(f.chase, ["default", "off", "once", "every"] as const, fallback.chase),
    everyN: f.everyN !== undefined && f.everyN !== "" ? Number(f.everyN) : fallback.everyN,
    everyUnit: pick(f.everyUnit, ["hours", "days"] as const, fallback.everyUnit),
    escalation: pick(f.escalation, ["default", "off", "days"] as const, fallback.escalation),
    escalateDays: f.escalateDays !== undefined && f.escalateDays !== "" ? Number(f.escalateDays) : fallback.escalateDays,
    founderNudge: pick(f.founderNudge, ["usual", "due_day", "off"] as const, fallback.founderNudge),
    shareNotes: f.shareNotes === undefined ? fallback.shareNotes : f.shareNotes === "on" || f.shareNotes === "1" || f.shareNotes === "true",
    paused: f.paused === undefined ? fallback.paused : f.paused === "1" || f.paused === "true",
  };
}

/** The bits of a person's own chase settings the summary needs (global default ← their settings). */
export type PersonChaseSettings = Pick<StaffSettings, "workStart" | "workEnd" | "chaseEveryMinutes" | "escalateAfterChases" | "escalateAt">;

export interface ChaseSummaryInput {
  value: ChaseFormValue;
  /** Who is chased: a person (staff on Telegram), a founder, or nobody yet. */
  assignee: { kind: "person" | "user"; name: string } | null;
  /** The founder who gets the founder nudges (the assignee founder, else the task's creator). */
  nudgedFounder: string;
  person?: PersonChaseSettings | null;
  dueDate: string | null;
  /** The person cannot be messaged right now (not linked, switched off, paused). */
  unreachable?: string | null;
}

const hours = (m: number) => (m % 60 === 0 ? `${m / 60} h` : `${m} min`);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Live plain-language sentences under the control ("Elmurat is reminded every 2 h …"). */
export function chaseSummary(i: ChaseSummaryInput): string[] {
  const s = i.person ?? DEFAULT_STAFF_SETTINGS;
  const v = i.value;
  const out: string[] = [];
  const nudge =
    v.founderNudge === "off"
      ? `${i.nudgedFounder} gets no reminder pushes about it (it is still listed in the morning summary).`
      : v.founderNudge === "due_day"
        ? `${i.nudgedFounder} gets one nudge at 12:00 on the due date, nothing after — within the daily budget and quiet hours.`
        : `${i.nudgedFounder} gets the usual nudges: 12:00 on the due date, then overdue on day 1, 3, 7 and weekly — within the daily budget and quiet hours.`;
  if (i.assignee?.kind !== "person") {
    out.push(i.dueDate ? nudge : `No due date: no reminders until one is set. ${nudge}`);
    return out;
  }
  const who = i.assignee.name;
  const hoursText = `${s.workStart}–${s.workEnd}`;
  if (v.paused) out.push(`Chasing is paused: ${who} gets no reminders until you resume it.`);
  else if (v.chase === "off") out.push(`${who} is not reminded about this task (only the new-task message is sent).`);
  else if (!i.dueDate) out.push(`No due date: ${who} gets the new-task message, reminders start once a due date is set.`);
  else if (v.chase === "once") out.push(`${who} gets one reminder on the due date, between ${hoursText}.`);
  else if (v.chase === "every" && v.everyUnit === "days") {
    out.push(`${who} is reminded once every ${plural(v.everyN, "day", "days")} from the due date (between ${hoursText}) until it is done.`);
  } else {
    const every = v.chase === "every" ? v.everyN * 60 : s.chaseEveryMinutes;
    out.push(
      `${who} is reminded every ${hours(every)} between ${hoursText}, from the due date until it is done${v.chase === "default" ? ` (${who}'s settings)` : ""}.`,
    );
  }
  if (v.escalation === "off") out.push("The founders are never told, however long it stays open.");
  else if (v.escalation === "days") {
    out.push(
      v.escalateDays === 0
        ? "If it is still open on the due date, both founders are told (reminders go on)."
        : `If it is still open ${plural(v.escalateDays, "day", "days")} after the due date, both founders are told (reminders go on).`,
    );
  } else {
    const bits: string[] = [];
    if (s.escalateAfterChases > 0) bits.push(`after ${plural(s.escalateAfterChases, "unanswered reminder", "unanswered reminders")} the task's founder is told and reminders pause until ${who} answers`);
    if (s.escalateAt) bits.push(`at ${s.escalateAt} on the due day the founder gets a heads-up`);
    out.push(bits.length ? `${bits.join("; ")[0]!.toUpperCase()}${bits.join("; ").slice(1)}.` : "The founders are never told (default).");
  }
  if (i.unreachable) out.push(`Right now nothing reaches ${who}: ${i.unreachable}.`);
  out.push(nudge);
  return out;
}
