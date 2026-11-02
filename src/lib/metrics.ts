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

/** How precise a typed date is: a calendar day, or only a month ("2026-10", "Oct 2026"). */
export type DatePrecision = "day" | "month";

/**
 * Parses a date typed in a form or a spreadsheet cell: "2026-10-31", "31.10.2026",
 * "31/10/2026", "2026-10", "10.2026", "Oct 2026", or an Excel serial day number.
 * A time is accepted only when it is exactly midnight without a time zone
 * ("2026-10-31 00:00", "31.10.2026 0:00:00": how spreadsheets export plain dates);
 * any other time, "T…" or a zone is refused (null): which day it means depends on the
 * time zone, and we never guess.
 */
export function parseDateCell(raw: string): { date: IsoDate; precision: DatePrecision } | null {
  let s = raw.trim();
  if (!s) return null;
  const midnight = /\s+0?0:00(:00(\.0+)?)?$/;
  if (midnight.test(s)) s = s.replace(midnight, "");
  let iso: string | null = null;
  let precision: DatePrecision = "day";
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) iso = `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  else if ((m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s))) iso = `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  else if ((m = /^(\d{4})-(\d{1,2})$/.exec(s))) {
    iso = `${m[1]}-${m[2]!.padStart(2, "0")}-01`;
    precision = "month";
  } else if ((m = /^(\d{1,2})[./](\d{4})$/.exec(s))) {
    iso = `${m[2]}-${m[1]!.padStart(2, "0")}-01`;
    precision = "month";
  } else if ((m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{4})$/.exec(s))) {
    const idx = MONTHS.findIndex((x) => x.toLowerCase() === m![1]!.toLowerCase());
    if (idx >= 0) iso = `${m[2]}-${String(idx + 1).padStart(2, "0")}-01`;
    precision = "month";
  } else if (/^\d{5}$/.test(s)) {
    const serial = Number(s);
    // Excel day numbers (1900 system) between 1990 and 2100.
    if (serial > 32_000 && serial < 73_000) iso = addDays("1899-12-30", serial);
  }
  if (!iso || !isIsoDate(iso)) return null;
  return { date: iso, precision };
}

/** True when the text carries a time of day (other than plain midnight) or a time zone. */
export function hasTimePart(raw: string): boolean {
  return /^\d{4}-\d{1,2}-\d{1,2}[T ]/.test(raw.trim()) && parseDateCell(raw) === null;
}

/** Start of the period containing a typed date (see `parseDateCell`). Null when it is not a date. */
export function parsePeriodInput(raw: string, g: Granularity): IsoDate | null {
  const d = parseDateCell(raw);
  return d ? periodStart(d.date, g) : null;
}

/**
 * Latest period a value may be entered for at `today`: today for daily numbers, the last
 * COMPLETED week / month otherwise (a month-to-date total is not the month's number).
 */
export function lastEnterablePeriod(today: IsoDate, g: Granularity): IsoDate {
  return g === "day" ? today : prevPeriod(periodStart(today, g), g);
}

/** Why a value can't be entered for this period at `today` (null = fine). */
export function periodProblem(start: IsoDate, g: Granularity, today: IsoDate): string | null {
  const current = periodStart(today, g);
  if (start > current) return "That period is in the future";
  if (g !== "day" && start === current) return g === "week" ? "This week isn't finished yet" : "This month isn't finished yet";
  return null;
}

/** A period is complete once its last day is before `today`. */
export function isPeriodComplete(start: IsoDate, g: Granularity, today: IsoDate): boolean {
  return periodEnd(start, g) < today;
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

export type FreshnessStatus = "fresh" | "stale" | "very_stale" | "missing";

/**
 * How many recent periods are checked for gaps: 7 days, 4 weeks, 3 months. A missing
 * value inside this window is chased even when a later period already has a value.
 */
export const GAP_WINDOW: Record<Granularity, number> = { day: 7, week: 4, month: 3 };

export interface Freshness {
  status: FreshnessStatus;
  /** Number of due periods without a value inside the gap window (0 when fresh). */
  overduePeriods: number;
  /** Those periods, oldest first. */
  missingPeriods: IsoDate[];
  /** True when the latest value is older than the whole window (more may be missing). */
  moreBeforeWindow: boolean;
  /** Oldest period we are waiting for (null when fresh). */
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
 * Fresh: every due period in the gap window (GAP_WINDOW) has a value. Stale (warn): one
 * is missing. Very stale (risk): two or more are missing. Missing (risk): no value at all.
 * Periods before the metric's first value are not gaps (it was not tracked yet).
 *
 * `periods` are the periods that have a current value (at least those inside the window);
 * when omitted, every period up to `latestPeriod` counts as present (only trailing gaps).
 * All dates are Asia/Bishkek calendar days, so "after the 10th" switches at local midnight.
 */
export function metricFreshness(
  input: {
    granularity: Granularity;
    dueDays?: number | null;
    latestPeriod: IsoDate | null;
    firstPeriod?: IsoDate | null;
    periods?: Iterable<IsoDate>;
  },
  today: IsoDate,
): Freshness {
  const g = input.granularity;
  const expected = expectedPeriod(today, g, input.dueDays);
  if (!input.latestPeriod) {
    return {
      status: "missing",
      overduePeriods: GAP_WINDOW[g],
      missingPeriods: [],
      moreBeforeWindow: false,
      waitingFor: expected,
      dueOn: periodDueDate(expected, g, input.dueDays),
      expectedPeriod: expected,
    };
  }
  const latest = periodStart(input.latestPeriod, g);
  const first = input.firstPeriod ? periodStart(input.firstPeriod, g) : null;
  const have = input.periods ? new Set([...input.periods].map((p) => periodStart(p, g))) : null;
  const window = lastPeriods(expected, g, GAP_WINDOW[g]);
  const missing = window.filter((p) => {
    if (first && p < first) return false;
    if (have) return !have.has(p);
    return p > latest;
  });
  const waitingFor = missing[0] ?? null;
  return {
    status: missing.length === 0 ? "fresh" : missing.length === 1 ? "stale" : "very_stale",
    overduePeriods: missing.length,
    missingPeriods: missing,
    moreBeforeWindow: latest < window[0]!,
    waitingFor,
    dueOn: waitingFor ? periodDueDate(waitingFor, g, input.dueDays) : null,
    expectedPeriod: expected,
  };
}

/**
 * Period the "Enter value" form opens with: the oldest missing period in the gap window;
 * otherwise the period after the latest value (when it may be entered already); otherwise
 * the latest enterable period.
 */
export function defaultEntryPeriod(
  m: { granularity: Granularity; freshness: Freshness; latestPeriod: IsoDate | null },
  today: IsoDate,
): IsoDate {
  const g = m.granularity;
  const max = lastEnterablePeriod(today, g);
  if (m.freshness.status === "missing") return m.freshness.expectedPeriod <= max ? m.freshness.expectedPeriod : max;
  if (m.freshness.waitingFor) return m.freshness.waitingFor;
  if (m.latestPeriod) {
    const next = nextPeriod(periodStart(m.latestPeriod, g), g);
    return next <= max ? next : max;
  }
  return max;
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
/** A double keeps 15 significant digits exactly; longer numbers would be changed silently. */
export const MAX_SIGNIFICANT_DIGITS = 15;
export const MAX_DECIMALS = 4;

/**
 * Removes binary floating-point noise from a number that came from a spreadsheet or a
 * calculation (0.955 * 100 = 95.49999999999999 → 95.5). Keeps 15 significant digits,
 * which is exactly what Excel stores and shows; it never rounds a typed value.
 */
export function cleanFloat(n: number): number {
  return Number.isFinite(n) ? Number(n.toPrecision(15)) : n;
}

/** Digits after the decimal point, from the number's shortest exact text (not by multiplying). */
export function decimalPlaces(n: number): number {
  const s = String(Math.abs(n));
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/i.exec(s);
  if (!m) return Number.POSITIVE_INFINITY;
  const frac = m[2]?.length ?? 0;
  const exp = m[3] ? Number(m[3]) : 0;
  return Math.max(0, frac - exp);
}

function significantDigits(digits: string): number {
  return digits.replace(/[^0-9]/g, "").replace(/^0+/, "").length;
}

/**
 * Parses a number typed in a form, a grid cell or a CSV: "1 234,5", "1,234.5",
 * "85 000 сом", "12.5%", "-300". Refuses (with a message) what could mean two things:
 * "85.000" / "12,345" (thousands or decimals?), a "%" for a number that is not a
 * percentage, more than 15 significant digits.
 */
export function parseMetricInput(raw: unknown, unit: string): { value: number } | { error: string } {
  if (typeof raw === "number") {
    const problem = metricValueProblem(raw, unit);
    return problem ? { error: problem } : { value: raw };
  }
  if (typeof raw !== "string") return { error: "Not a number" };
  const shown = raw.trim();
  let s = shown.replace(/[\s\u00a0\u202f]/g, "");
  const percent = /%$/.test(s);
  s = s.replace(/(сом|kgs|som|шт|pcs|%)\.?$/i, "");
  if (s === "" || s === "-") return { error: `Not a number: “${shown}”` };
  if (percent && unit !== "%") return { error: `“${shown}” is a percentage, but this number is in ${unit}` };
  if (/^-?[1-9]\d{0,2}[.,]\d{3}$/.test(s)) {
    const neg = s.startsWith("-") ? "-" : "";
    const [a, b] = s.replace(/^-/, "").split(/[.,]/);
    const asDecimal = `${neg}${String(Number(`${a}.${b}`))}`;
    const asThousands = `${neg}${a}${b}`;
    const decimalHint = Number(b) === 0 ? asDecimal : `${neg}${a}.${b}0`;
    return {
      error: `“${shown}” is ambiguous: ${asDecimal} or ${asThousands}? Write ${asThousands} if you mean thousands, or ${decimalHint} for a decimal`,
    };
  }
  if (/^-?[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return { error: `Not a number: “${shown}”` };
  if (significantDigits(s) > MAX_SIGNIFICANT_DIGITS) return { error: `Too many digits (at most ${MAX_SIGNIFICANT_DIGITS})` };
  const frac = s.split(".")[1]?.length ?? 0;
  if (frac > MAX_DECIMALS) return { error: `At most ${MAX_DECIMALS} decimals` };
  const value = Number(s);
  const problem = metricValueProblem(value, unit);
  return problem ? { error: problem } : { value };
}

/** Number or NaN (no unit checks). Prefer `parseMetricInput`, which explains refusals. */
export function parseMetricNumber(v: unknown): number {
  if (typeof v === "number") return v;
  const r = parseMetricInput(v, "%");
  if ("value" in r) return r.value;
  // Range problems of "%" still mean "a number": re-parse as money (negatives allowed).
  const n = parseMetricInput(v, "KGS");
  return "value" in n ? n.value : Number.NaN;
}

/**
 * A stored number as text for an input (grid prefill) that `parseMetricInput` reads back
 * as the same number: "85.125" would be ambiguous, so it becomes "85.1250".
 */
export function formatMetricInput(n: number): string {
  const s = String(n);
  return /^-?[1-9]\d{0,2}\.\d{3}$/.test(s) ? `${s}0` : s;
}

/** User-facing validation message, or null when the value is fine for this unit. */
export function metricValueProblem(value: number, unit: string): string | null {
  if (!Number.isFinite(value)) return "Not a number";
  if (Math.abs(value) >= MAX_METRIC_ABS) return "Number is too large";
  if (unit === "%" && (value < 0 || value > 100)) return "A percentage must be between 0 and 100";
  if (unit !== "KGS" && value < 0) return "Can't be negative";
  if (decimalPlaces(value) > MAX_DECIMALS) return `At most ${MAX_DECIMALS} decimals`;
  return null;
}

// ---------------------------------------------------------------------------
// Aggregation (connector points finer than the metric's period)
// ---------------------------------------------------------------------------

export type Aggregation = "sum" | "avg" | "last";

/**
 * One value for a week/month from its daily points: sum (orders, money), avg
 * (percentages; rounded to 4 decimals, the stored precision) or last (the latest day).
 */
export function aggregateValues(points: readonly { day: IsoDate; value: number }[], how: Aggregation): number {
  if (points.length === 0) return Number.NaN;
  if (how === "last") return [...points].sort((a, b) => (a.day < b.day ? -1 : 1)).at(-1)!.value;
  const sum = points.reduce((n, p) => n + p.value, 0);
  if (how === "sum") return cleanFloat(sum);
  return Math.round((sum / points.length) * 10_000) / 10_000;
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
