/**
 * One number per month from a metric's stored values, exactly (decimal strings, no floats).
 * Pure: used by the AI roles service to decide whether a month's data is complete and to
 * feed the finance rules.
 *
 * - monthly numbers: the value stored for that month;
 * - daily numbers: complete only when EVERY day of the month has a value, then combined by
 *   the metric's aggregation (sum for orders and money, average for %, last for balances
 *   and head counts) — a month with gaps is never treated as a total;
 * - weekly numbers: the weeks whose Monday falls in the month, all of them needed, same
 *   aggregation (a week belongs to the month of its Monday).
 */
import { addDays, type IsoDate } from "@/lib/dates";
import { dec, divInt, sum, toText } from "@/lib/decimal";

export type Granularity = "day" | "week" | "month";
export type Aggregation = "sum" | "avg" | "last";

export type MonthValue = { value: string } | { missing: number; total: number };

/** The periods (period starts) of a metric that make up one month. */
export function periodsInMonth(month: IsoDate, g: Granularity): IsoDate[] {
  if (g === "month") return [month];
  const prefix = month.slice(0, 7);
  const out: IsoDate[] = [];
  let d = month;
  if (g === "week") {
    // First Monday on or after the 1st.
    while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1);
  }
  const step = g === "day" ? 1 : 7;
  for (; d.slice(0, 7) === prefix; d = addDays(d, step)) out.push(d);
  return out;
}

export function monthValue(
  metric: { granularity: Granularity; aggregation: Aggregation },
  values: ReadonlyMap<IsoDate, string>,
  month: IsoDate,
): MonthValue {
  const periods = periodsInMonth(month, metric.granularity);
  const present = periods.filter((p) => values.has(p));
  if (present.length < periods.length) return { missing: periods.length - present.length, total: periods.length };
  if (metric.granularity === "month") return { value: values.get(month)! };
  const vals = periods.map((p) => dec(values.get(p)!));
  if (metric.aggregation === "last") return { value: toText(vals.at(-1)!) };
  const total = sum(vals);
  return { value: toText(metric.aggregation === "avg" ? divInt(total, vals.length) : total) };
}

export function isComplete(v: MonthValue): v is { value: string } {
  return "value" in v;
}
