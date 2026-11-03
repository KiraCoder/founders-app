/**
 * Pure calendar-date helpers. All business dates are plain "YYYY-MM-DD" strings that
 * mean a calendar day in APP_TIMEZONE (default Asia/Bishkek, GMT+6, no DST).
 * No function here reads the clock: callers pass `now` so everything is testable.
 */

export const DEFAULT_TIMEZONE = "Asia/Bishkek";

/** ISO calendar date, e.g. "2026-11-02". */
export type IsoDate = string;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function appTimeZone(): string {
  return process.env.APP_TIMEZONE || DEFAULT_TIMEZONE;
}

export function isIsoDate(value: string): boolean {
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** The calendar date at instant `now` in the given IANA timezone. */
export function todayInTimeZone(now: Date, timeZone: string = DEFAULT_TIMEZONE): IsoDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function toUtcDate(iso: IsoDate): Date {
  if (!isIsoDate(iso)) throw new Error(`Invalid ISO date: ${iso}`);
  return new Date(`${iso}T00:00:00Z`);
}

export function addDays(iso: IsoDate, days: number): IsoDate {
  const d = toUtcDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtcDate(b).getTime() - toUtcDate(a).getTime()) / 86_400_000);
}

/** ISO dates compare correctly as strings; this just documents intent. */
export function isBefore(a: IsoDate, b: IsoDate): boolean {
  return a < b;
}

/** Day of week, 1 = Monday … 7 = Sunday. */
export function isoWeekday(iso: IsoDate): number {
  const day = toUtcDate(iso).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Sunday that ends the ISO week containing `iso`. */
export function endOfIsoWeek(iso: IsoDate): IsoDate {
  return addDays(iso, 7 - isoWeekday(iso));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Short human label relative to `today`: "Today", "Tomorrow", "Yesterday", "5 Nov", "5 Nov 2027". */
export function formatDueDate(iso: IsoDate, today: IsoDate): string {
  const diff = daysBetween(today, iso);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  const d = toUtcDate(iso);
  const label = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return iso.slice(0, 4) === today.slice(0, 4) ? label : `${label} ${d.getUTCFullYear()}`;
}

// ---------------------------------------------------------------------------
// Wall-clock times ("HH:MM") in APP_TIMEZONE — used by notification scheduling.
// ---------------------------------------------------------------------------

/** "HH:MM" 24h wall-clock time. */
export type HmTime = string;

const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isHmTime(value: string): boolean {
  return HM_RE.test(value);
}

/** Minutes since midnight for "HH:MM". */
export function hmToMinutes(hm: HmTime): number {
  const m = HM_RE.exec(hm);
  if (!m) throw new Error(`Invalid HH:MM time: ${hm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Offset of `timeZone` from UTC at instant `at`, in minutes (Bishkek = +360). */
function tzOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** Minutes since local midnight at instant `now` in `timeZone`. */
export function localMinutesOfDay(now: Date, timeZone: string = DEFAULT_TIMEZONE): number {
  const shifted = new Date(now.getTime() + tzOffsetMinutes(now, timeZone) * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** The UTC instant of local date `iso` at wall-clock `hm` in `timeZone`. */
export function zonedTimeToUtc(iso: IsoDate, hm: HmTime, timeZone: string = DEFAULT_TIMEZONE): Date {
  const guess = new Date(toUtcDate(iso).getTime() + hmToMinutes(hm) * 60_000);
  const first = new Date(guess.getTime() - tzOffsetMinutes(guess, timeZone) * 60_000);
  // Re-check once in case the offset differs at the target instant (DST zones).
  return new Date(guess.getTime() - tzOffsetMinutes(first, timeZone) * 60_000);
}

/**
 * True when local time at `now` is inside [start, end). Windows may wrap midnight
 * (21:00–08:00). start === end means "no quiet hours".
 */
export function isWithinWindow(now: Date, start: HmTime, end: HmTime, timeZone: string = DEFAULT_TIMEZONE): boolean {
  return isTimeInWindow(localMinutesOfDay(now, timeZone), start, end);
}

/** True when the wall-clock time (minutes since midnight or "HH:MM") is inside [start, end). */
export function isTimeInWindow(time: number | HmTime, start: HmTime, end: HmTime): boolean {
  const s = hmToMinutes(start);
  const e = hmToMinutes(end);
  if (s === e) return false;
  const m = typeof time === "number" ? time : hmToMinutes(time);
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/** First instant at/after `now` when the window [start, end) is over. */
export function windowEndAfter(now: Date, start: HmTime, end: HmTime, timeZone: string = DEFAULT_TIMEZONE): Date {
  const todayIso = todayInTimeZone(now, timeZone);
  const endToday = zonedTimeToUtc(todayIso, end, timeZone);
  if (!isWithinWindow(now, start, end, timeZone)) return now;
  return endToday.getTime() > now.getTime() ? endToday : zonedTimeToUtc(addDays(todayIso, 1), end, timeZone);
}

/** "2026-11-02" → "02.11.2026" (how dates are typed and shown in date fields). */
export function formatDisplayDate(iso: string | null | undefined): string {
  if (!iso || !isIsoDate(iso)) return "";
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

/**
 * An instant as the app shows it: "02.11.2026 14:05" in APP_TIMEZONE (pass ctx.timeZone).
 * Same dd.mm.yyyy as the date fields, 24-hour time; no locale-dependent formatting.
 */
export function formatDisplayDateTime(at: Date | string | null | undefined, timeZone: string = appTimeZone()): string {
  if (!at) return "";
  const d = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return "";
  const mins = localMinutesOfDay(d, timeZone);
  const hm = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  return `${formatDisplayDate(todayInTimeZone(d, timeZone))} ${hm}`;
}

/**
 * What a founder typed in a date field → ISO date. Accepts dd.mm.yyyy (also d.m.yyyy and
 * "/" or "-" as separator) and a pasted ISO yyyy-mm-dd. Two-digit years and impossible
 * dates (31.02.2026) are refused. Empty → null; anything else → "invalid".
 */
export function parseDisplayDate(text: string): IsoDate | null | "invalid" {
  const t = text.trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return isIsoDate(t) ? t : "invalid";
  const m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(t);
  if (!m) return "invalid";
  const iso = `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  return isIsoDate(iso) ? iso : "invalid";
}
