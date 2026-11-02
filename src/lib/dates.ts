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
