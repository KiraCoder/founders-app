/**
 * Pure rules for the numbers layer: periods, freshness (staleness), change vs the
 * previous period, number parsing and formatting. No DB, no clock: callers pass `today`
 * (the calendar day in Asia/Bishkek, see dates.ts), so every rule is testable.
 */
import { addDays, daysBetween, isIsoDate, isoWeekday, type IsoDate } from "./dates";

export type Granularity = "day" | "week" | "month";
export type Direction = "higher_is_better" | "lower_is_better" | "neutral";

/**
 * Data for a period is due this many days after the period ends:
 * daily → the next day (stale once the latest day is more than 2 days old),
 * weekly → Wednesday after the week, monthly → the 10th of the next month.
 */
export const DEFAULT_DUE_DAYS: Record<Granularity, number> = { day: 1, week: 3, month: 10 };

export const GRANULARITY_LABELS: Record<Granularity, string> = { day: "Daily", week: "Weekly", month: "Monthly" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------------------------------------------------------------------------
// Periods. A period is identified by its first day.
// ---------------------------------------------------------------------------

export function periodStart(date: IsoDate, g: Granularity): IsoDate {
  if (g === "day") return date;
  if (g === "week") return addDays(date, 1 - isoWeekday(date));
  return `${date.slice(0, 7)}-01`;
}

export function nextPeriod(start: IsoDate, g: Granularity): IsoDate {
  if (g === "day") return addDays(start, 1);
  if (g === "week") return addDays(start, 7);
  const y = Number(start.slice(0, 4));
  const m = Number(start.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

export function prevPeriod(start: IsoDate, g: Granularity): IsoDate {
  if (g === "day") return addDays(start, -1);
  if (g === "week") return addDays(start, -7);
  const y = Number(start.slice(0, 4));
  const m = Number(start.slice(5, 7));
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
}

/** Last day of the period that starts on `start`. */
export function periodEnd(start: IsoDate, g: Granularity): IsoDate {
  return addDays(nextPeriod(start, g), -1);
}

/** The last `n` periods up to and including the one containing `until`, oldest first. */
export function lastPeriods(until: IsoDate, g: Granularity, n: number): IsoDate[] {
  const out: IsoDate[] = [];
  let p = periodStart(until, g);
  for (let i = 0; i < n; i++) {
    out.unshift(p);
    p = prevPeriod(p, g);
  }
  return out;
}

/** "31 Oct", "Week of 27 Oct", "Oct 2026". */
export function formatPeriod(start: IsoDate, g: Granularity): string {
  const d = Number(start.slice(8, 10));
  const mon = MONTHS[Number(start.slice(5, 7)) - 1];
  if (g === "month") return `${mon} ${start.slice(0, 4)}`;
  if (g === "week") return `Week of ${d} ${mon}`;
  return `${d} ${mon}`;
}

/** Short label for grid rows and sparkline tooltips. */
export function formatPeriodShort(start: IsoDate, g: Granularity): string {
  const d = Number(start.slice(8, 10));
  const mon = MONTHS[Number(start.slice(5, 7)) - 1];
  if (g === "month") return `${mon} ${start.slice(2, 4)}`;
  return `${d} ${mon}`;
}

/**
 * Parses a period typed in a form or a spreadsheet cell and returns the start of the
 * period containing it: "2026-10-31", "31.10.2026", "31/10/2026", "2026-10", "10.2026",
 * "Oct 2026", or an Excel serial day number. Null when it is not a date.
 */
export function parsePeriodInput(raw: string, g: Granularity): IsoDate | null {
  const s = raw.trim();
  if (!s) return null;
  let iso: string | null = null;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s))) iso = `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  else if ((m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s))) iso = `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  else if ((m = /^(\d{4})-(\d{1,2})$/.exec(s))) iso = `${m[1]}-${m[2]!.padStart(2, "0")}-01`;
  else if ((m = /^(\d{1,2})[./](\d{4})$/.exec(s))) iso = `${m[2]}-${m[1]!.padStart(2, "0")}-01`;
  else if ((m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{4})$/.exec(s))) {
    const idx = MONTHS.findIndex((x) => x.toLowerCase() === m![1]!.toLowerCase());
    if (idx >= 0) iso = `${m[2]}-${String(idx + 1).padStart(2, "0")}-01`;
  } else if (/^\d{5}$/.test(s)) {
    const serial = Number(s);
    // Excel day numbers (1900 system) between 1990 and 2100.
    if (serial > 32_000 && serial < 73_000) iso = addDays("1899-12-30", serial);
  }
  if (!iso || !isIsoDate(iso)) return null;
  return periodStart(iso, g);
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

export type FreshnessStatus = "fresh" | "stale" | "very_stale" | "missing";

export interface Freshness {
  status: FreshnessStatus;
  /** Periods whose data is overdue (capped at 3; 3 means "3 or more"). */
  overduePeriods: number;
  /** First period we are waiting for (null when fresh). */
  waitingFor: IsoDate | null;
  /** Day the data for `waitingFor` was due. */
  dueOn: IsoDate | null;
  /** Most recent period whose data is already due (the one a fresh metric has). */
  expectedPeriod: IsoDate;
}

export function dueDaysFor(g: Granularity, dueDays: number | null | undefined): number {
  return dueDays ?? DEFAULT_DUE_DAYS[g];
}

/** Last day on which a missing value for this period is still fine. */
export function periodDueDate(start: IsoDate, g: Granularity, dueDays?: number | null): IsoDate {
  return addDays(periodEnd(start, g), dueDaysFor(g, dueDays));
}

/** Most recent period whose due date has passed at `today`. */
export function expectedPeriod(today: IsoDate, g: Granularity, dueDays?: number | null): IsoDate {
  let p = periodStart(today, g);
  while (!(periodDueDate(p, g, dueDays) < today)) p = prevPeriod(p, g);
  return p;
}

/**
 * Fresh: we have the latest period that is due. Stale (warn): one period overdue.
 * Very stale (risk): two or more overdue. Missing (risk): no value at all.
 * All dates are Asia/Bishkek calendar days, so "after the 10th" switches at local midnight.
 */
export function metricFreshness(
  input: { granularity: Granularity; dueDays?: number | null; latestPeriod: IsoDate | null },
  today: IsoDate,
): Freshness {
  const g = input.granularity;
  const expected = expectedPeriod(today, g, input.dueDays);
  if (!input.latestPeriod) {
    return { status: "missing", overduePeriods: 3, waitingFor: expected, dueOn: periodDueDate(expected, g, input.dueDays), expectedPeriod: expected };
  }
  const latest = periodStart(input.latestPeriod, g);
  if (latest >= expected) {
    return { status: "fresh", overduePeriods: 0, waitingFor: null, dueOn: null, expectedPeriod: expected };
  }
  const waitingFor = nextPeriod(latest, g);
  let overdue = 0;
  for (let p = waitingFor; p <= expected && overdue < 3; p = nextPeriod(p, g)) overdue++;
  return {
    status: overdue >= 2 ? "very_stale" : "stale",
    overduePeriods: overdue,
    waitingFor,
    dueOn: periodDueDate(waitingFor, g, input.dueDays),
    expectedPeriod: expected,
  };
}

export type FreshnessTone = "ok" | "warn" | "risk";

export function freshnessTone(status: FreshnessStatus): FreshnessTone {
  return status === "fresh" ? "ok" : status === "stale" ? "warn" : "risk";
}

/** "today", "yesterday", "3 days ago", "5 weeks ago". */
export function agoText(fromDay: IsoDate, today: IsoDate): string {
  const d = daysBetween(fromDay, today);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 14) return `${d} days ago`;
  if (d < 60) return `${Math.floor(d / 7)} weeks ago`;
  return `${Math.floor(d / 30)} months ago`;
}

// ---------------------------------------------------------------------------
// Change vs previous period
// ---------------------------------------------------------------------------

export interface PeriodValue {
  period: IsoDate;
  value: number;
}

export interface Change {
  previousPeriod: IsoDate;
  previous: number;
  delta: number;
  /** Null when the previous value is 0. */
  pct: number | null;
  /** good / bad according to the metric's direction; flat when equal or neutral. */
  tone: "good" | "bad" | "flat";
}

/**
 * Latest value compared with the value of the period right before it. Null when there
 * is no value for that previous period (a gap is not compared across).
 */
export function changeVsPrevious(values: readonly PeriodValue[], g: Granularity, direction: Direction): Change | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => (a.period < b.period ? -1 : 1));
  const latest = sorted[sorted.length - 1]!;
  const prevKey = prevPeriod(periodStart(latest.period, g), g);
  const prev = sorted.find((v) => v.period === prevKey);
  if (!prev) return null;
  const delta = latest.value - prev.value;
  const pct = prev.value === 0 ? null : (delta / Math.abs(prev.value)) * 100;
  let tone: Change["tone"] = "flat";
  if (delta !== 0 && direction !== "neutral") {
    tone = (delta > 0) === (direction === "higher_is_better") ? "good" : "bad";
  }
  return { previousPeriod: prev.period, previous: prev.value, delta, pct, tone };
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export const MAX_METRIC_ABS = 1_000_000_000_000;

/**
 * Parses "1 234,5", "1,234.5", "85 000 сом", "12.5%", "-300". NaN when not a number.
 */
export function parseMetricNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return Number.NaN;
  let s = v.replace(/[\s  ]/g, "").replace(/(сом|kgs|som|шт|pcs|%)\.?$/i, "");
  if (s === "" || s === "-") return Number.NaN;
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return Number.NaN;
  return Number(s);
}

/** User-facing validation message, or null when the value is fine for this unit. */
export function metricValueProblem(value: number, unit: string): string | null {
  if (!Number.isFinite(value)) return "Not a number";
  if (Math.abs(value) >= MAX_METRIC_ABS) return "Number is too large";
  if (unit === "%" && (value < 0 || value > 100)) return "A percentage must be between 0 and 100";
  if (unit !== "KGS" && value < 0) return "Can't be negative";
  if (Math.abs(Math.round(value * 10_000) - value * 10_000) > 1e-6) return "At most 4 decimals";
  return null;
}

/** "12 345 KGS", "96.5%", "120 orders". */
export function formatMetricValue(value: number, unit: string): string {
  const n = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: unit === "%" ? 1 : 2 })
    .format(value)
    .replace(/[  ]/g, " ")
    .replace(",", ".");
  if (unit === "%") return `${n}%`;
  if (unit === "count") return n;
  return `${n} ${unit}`;
}

export function formatDelta(change: Change, unit: string): string {
  const sign = change.delta > 0 ? "+" : change.delta < 0 ? "−" : "±";
  const abs = formatMetricValue(Math.abs(change.delta), unit === "%" ? "pp" : unit).replace(/ pp$/, " pp");
  const pct = change.pct === null || unit === "%" ? "" : ` (${sign}${Math.abs(change.pct).toFixed(Math.abs(change.pct) < 10 ? 1 : 0)}%)`;
  return `${sign}${abs}${pct}`;
}

// ---------------------------------------------------------------------------
// Upload header matching
// ---------------------------------------------------------------------------

/** Lowercase, ё→е, units in brackets and punctuation removed, single spaces. */
export function normalizeHeader(h: string): string {
  return h
    .normalize("NFC")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\((kgs|сом|шт|pcs|%|orders|people|count)\)/g, " ")
    .replace(/[_:·•|/\\,.;()[\]{}"'«»-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const DATE_HEADERS = ["date", "дата", "day", "день", "period", "период", "month", "месяц", "week", "неделя"];
