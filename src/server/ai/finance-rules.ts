/**
 * The AI Financial Analyst's analysis: pure, deterministic rules over one company's monthly
 * numbers. No AI, no DB, no clock, no floats: every number is an exact decimal string
 * (`numeric(…, 4)`) and all maths uses src/lib/decimal.ts. Each finding carries a severity,
 * the metrics and numbers it is about and a plain-English sentence built from templates.
 *
 * Rules (thresholds are the hire's tuned settings, default warn ±20 %, risk ±50 %):
 * 1. change     — a number moved ≥ threshold vs the month before and/or vs the average of
 *                 the 3 months before. Each comparison is judged on its own: bad direction →
 *                 warn (risk past the risk threshold); good direction or a neutral number →
 *                 info. The worse comparison sets the severity and leads the sentence.
 *                 Percentage metrics are phrased in percentage points ("rose 1.5 pp").
 * 2. ratio      — margin-like ratios when both numbers exist (same factory): revenue per
 *                 order, piecework pay per piece, returns rate, shipment error rate; same
 *                 thresholds month over month. Plus COD: the share of COD collected that
 *                 was paid out to shops (a gap ≥ threshold → warn / risk).
 * 3. missing    — a number with no value for this month and the month before (2+ months);
 *                 numbers never entered are listed in one info line.
 * 4. debt_trend — intercompany debt (the Holding's derived number) grew 3 months in a row.
 * 5. target     — this month missed the number's target (risk when missed by ≥ the risk threshold).
 *
 * Defect rate is itself a percentage: it is covered by "change" and "target".
 */
import { addMonths, monthLabel, monthName } from "@/lib/ai-roles";
import type { IsoDate } from "@/lib/dates";
import {
  abs,
  changeAtLeast,
  cmp,
  dec,
  div,
  divInt,
  formatDec,
  formatPct,
  pctChange,
  pctOf,
  sub,
  sum,
  toFixed,
  type Dec,
} from "@/lib/decimal";

export type Severity = "risk" | "warn" | "info";
export type FindingRule = "change" | "ratio" | "cod_payout" | "missing" | "never_entered" | "debt_trend" | "target";
export type Direction = "higher_is_better" | "lower_is_better" | "neutral";

export const SEVERITY_ORDER: Severity[] = ["risk", "warn", "info"];
export const SEVERITY_LABELS: Record<Severity, string> = { risk: "Risk", warn: "Warning", info: "Info" };

/** One metric's monthly values (month start → exact decimal text, null = no complete value). */
export interface MonthSeries {
  metricId: string;
  key: string;
  /** "Output per day" */
  name: string;
  /** The month value's label: "Output (month total) · ХБК" */
  label: string;
  /** The number as founders enter it ("Output per day · ХБК"), for "missing" sentences. Default: label. */
  entryLabel?: string;
  unitSlug: string | null;
  unit: string;
  direction: Direction;
  target: string | null;
  months: Record<IsoDate, string | null>;
  /** The metric had a value at some point before (for "missing" vs "never entered"). */
  everHadData: boolean;
}

export interface FinanceInput {
  companyName: string;
  /** The month analysed (first day). */
  period: IsoDate;
  series: MonthSeries[];
  thresholds: { changePct: number; riskChangePct: number };
}

export interface FindingNumber {
  label: string;
  value: string;
}

export interface Finding {
  /** Stable within a run: rule + metric keys + factory. */
  id: string;
  rule: FindingRule;
  severity: Severity;
  company: string;
  /** Metric labels the finding is about. */
  metrics: string[];
  metricKeys: string[];
  numbers: FindingNumber[];
  sentence: string;
  /** Set when a founder created a shared task from this finding. */
  taskId?: string | null;
}

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortMonth = (p: IsoDate) => SHORT[Number(p.slice(5, 7)) - 1]!;

function value(s: MonthSeries, p: IsoDate): Dec | null {
  const v = s.months[p];
  return v === null || v === undefined ? null : dec(v);
}

function severityFor(direction: Direction, up: boolean, riskHit: boolean): Severity {
  const bad = (direction === "higher_is_better" && !up) || (direction === "lower_is_better" && up);
  if (!bad) return "info";
  return riskHit ? "risk" : "warn";
}

const verb = (up: boolean) => (up ? "rose" : "fell");

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<Severity, number> = { risk: 0, warn: 1, info: 2 };

/** "3.0%" — a percentage metric's value, always one decimal (for pp sentences). */
const pct1 = (v: Dec) => `${toFixed(v, 1)}%`;

/**
 * How a move is phrased. Money / counts: "fell 32.5% vs September". A metric that is itself a
 * percentage (defect rate, returns rate): percentage points, "rose 1.5 pp vs September, from
 * 3.0% to 4.5%" — a relative "+50%" of a rate reads wrong.
 */
function movePhrase(cur: Dec, base: Dec, unit: string, basis: string): string {
  const up = cmp(cur, base) > 0;
  if (unit === "%") return `${verb(up)} ${toFixed(abs(sub(cur, base)), 1)} pp vs ${basis}, from ${pct1(base)} to ${pct1(cur)}`;
  return `${verb(up)} ${formatPct(pctChange(cur, base)!)} vs ${basis}`;
}

interface Comparison {
  basis: "prev" | "avg";
  base: Dec;
  severity: Severity;
  phrase: string;
}

/**
 * Change vs the month before and vs the 3-month average. Each comparison is judged on its own
 * (its own direction and thresholds) and the worse one sets the severity; the sentence starts
 * with that comparison and its numbers. E.g. 10, 10, 100 → 75 is a warning ("fell 25% vs
 * September"), not a risk because it is +87.5% vs the average; 100, 100, 10 → 30 is a risk
 * ("fell 57.1% vs the 3-month average"), not info because it rose vs September.
 */
function changeRule(s: MonthSeries, input: FinanceInput): Finding | null {
  const p = input.period;
  const cur = value(s, p);
  if (cur === null) return null;
  const T = dec(input.thresholds.changePct);
  const R = dec(input.thresholds.riskChangePct);
  const prevP = addMonths(p, -1);
  const prev = value(s, prevP);
  const hist = [1, 2, 3].map((n) => value(s, addMonths(p, -n)));
  const avg = hist.every((v) => v !== null) ? divInt(sum(hist as Dec[]), 3) : null;

  const hits: Comparison[] = [];
  for (const [basis, base, label] of [
    ["prev", prev, monthName(prevP)],
    ["avg", avg, "the 3-month average"],
  ] as const) {
    if (base === null || !changeAtLeast(cur, base, T)) continue;
    hits.push({
      basis,
      base,
      severity: severityFor(s.direction, cmp(cur, base) > 0, changeAtLeast(cur, base, R)),
      phrase: movePhrase(cur, base, s.unit, label),
    });
  }
  if (!hits.length) return null;
  // Worst first; on a tie the month before comes first (stable sort).
  hits.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const trigger = hits[0]!;

  const shown =
    trigger.basis === "prev"
      ? `${shortMonth(prevP)}: ${formatDec(prev!, s.unit)}, ${shortMonth(p)}: ${formatDec(cur, s.unit)}`
      : `3-month average: ${formatDec(avg!, s.unit)}, ${shortMonth(p)}: ${formatDec(cur, s.unit)}`;
  const numbers: FindingNumber[] = [{ label: `${s.label} · ${monthLabel(p)}`, value: formatDec(cur, s.unit) }];
  if (prev !== null) numbers.push({ label: `${s.label} · ${monthLabel(prevP)}`, value: formatDec(prev, s.unit) });
  if (avg !== null) numbers.push({ label: `${s.label} · 3-month average`, value: formatDec(avg, s.unit) });
  const sentence =
    s.unit === "%"
      ? `${s.label} ${hits.map((h) => h.phrase).join("; ")}.`
      : `${s.label} ${hits.map((h) => h.phrase).join(" and ")} (${shown}).`;
  return {
    id: `change:${s.key}:${s.unitSlug ?? ""}`,
    rule: "change",
    severity: trigger.severity,
    company: input.companyName,
    metrics: [s.label],
    metricKeys: [s.key],
    numbers,
    sentence,
  };
}

interface RatioDef {
  id: string;
  name: string;
  numerator: string;
  denominator: string;
  /** "%": numerator / denominator × 100; otherwise a per-unit amount in this unit. */
  unit: string;
  direction: Direction;
}

/** Margin-like ratios checked when both numbers exist for the same company (and factory). */
export const RATIO_RULES: RatioDef[] = [
  { id: "revenue_per_order", name: "Revenue per order", numerator: "revenue", denominator: "orders_day", unit: "KGS", direction: "higher_is_better" },
  { id: "piecework_per_piece", name: "Piecework pay per piece", numerator: "piecework_total", denominator: "output_pcs", unit: "KGS", direction: "lower_is_better" },
  { id: "returns_rate", name: "Returns rate", numerator: "wb_returns", denominator: "wb_orders", unit: "%", direction: "lower_is_better" },
  { id: "shipment_error_rate", name: "Shipment error rate", numerator: "wms_shipment_errors", denominator: "wms_orders_day", unit: "%", direction: "lower_is_better" },
];

function ratioAt(num: MonthSeries, den: MonthSeries, p: IsoDate, unit: string): Dec | null {
  const n = value(num, p);
  const d = value(den, p);
  if (n === null || d === null || d === 0n) return null;
  return unit === "%" ? pctOf(n, d) : div(n, d);
}

function ratioRules(input: FinanceInput): Finding[] {
  const out: Finding[] = [];
  const p = input.period;
  const prevP = addMonths(p, -1);
  const T = dec(input.thresholds.changePct);
  const R = dec(input.thresholds.riskChangePct);
  for (const r of RATIO_RULES) {
    for (const num of input.series.filter((s) => s.key === r.numerator)) {
      const den = input.series.find((s) => s.key === r.denominator && s.unitSlug === num.unitSlug);
      if (!den) continue;
      const cur = ratioAt(num, den, p, r.unit);
      const prev = ratioAt(num, den, prevP, r.unit);
      if (cur === null || prev === null || !changeAtLeast(cur, prev, T)) continue;
      const up = cmp(cur, prev) > 0;
      const unitName = num.label.includes(" · ") ? ` · ${num.label.split(" · ").slice(1).join(" · ")}` : "";
      const label = `${r.name}${unitName}`;
      out.push({
        id: `ratio:${r.id}:${num.unitSlug ?? ""}`,
        rule: "ratio",
        severity: severityFor(r.direction, up, changeAtLeast(cur, prev, R)),
        company: input.companyName,
        metrics: [num.label, den.label],
        metricKeys: [num.key, den.key],
        numbers: [
          { label: `${label} · ${monthLabel(p)}`, value: formatDec(cur, r.unit) },
          { label: `${label} · ${monthLabel(prevP)}`, value: formatDec(prev, r.unit) },
        ],
        sentence:
          r.unit === "%"
            ? `${label} ${movePhrase(cur, prev, r.unit, monthName(prevP))}.`
            : `${label} ${movePhrase(cur, prev, r.unit, monthName(prevP))} (${formatDec(prev, r.unit)} → ${formatDec(cur, r.unit)}).`,
      });
    }
  }
  return out;
}

function codPayoutRule(input: FinanceInput): Finding | null {
  const collected = input.series.find((s) => s.key === "cod_collected");
  const paid = input.series.find((s) => s.key === "cod_paid_out");
  if (!collected || !paid) return null;
  const p = input.period;
  const c = value(collected, p);
  const o = value(paid, p);
  if (c === null || o === null || c <= 0n) return null;
  const share = pctOf(o, c)!;
  const hundred = dec(100);
  const T = dec(input.thresholds.changePct);
  const R = dec(input.thresholds.riskChangePct);
  const numbers = [
    { label: `${collected.label} · ${monthLabel(p)}`, value: formatDec(c, collected.unit) },
    { label: `${paid.label} · ${monthLabel(p)}`, value: formatDec(o, paid.unit) },
    { label: "Paid out / collected", value: formatDec(share, "%") },
  ];
  const base = {
    id: "cod_payout:cod_paid_out+cod_collected:",
    rule: "cod_payout" as const,
    company: input.companyName,
    metrics: [paid.label, collected.label],
    metricKeys: [paid.key, collected.key],
    numbers,
  };
  if (cmp(sub(hundred, share), T) >= 0) {
    return {
      ...base,
      severity: cmp(sub(hundred, share), R) >= 0 ? "risk" : "warn",
      sentence: `Only ${formatDec(share, "%")} of COD collected in ${monthName(p)} was paid out to shops: ${formatDec(c, collected.unit)} collected, ${formatDec(o, paid.unit)} paid out (${formatDec(sub(c, o), collected.unit)} not paid out yet).`,
    };
  }
  if (cmp(sub(share, hundred), T) >= 0) {
    return {
      ...base,
      severity: "info",
      sentence: `COD paid out in ${monthName(p)} was ${formatDec(share, "%")} of COD collected (${formatDec(o, paid.unit)} paid out, ${formatDec(c, collected.unit)} collected) — older balances were paid.`,
    };
  }
  return null;
}

function missingRules(input: FinanceInput): Finding[] {
  const p = input.period;
  const prevP = addMonths(p, -1);
  const out: Finding[] = [];
  const never: MonthSeries[] = [];
  for (const s of input.series) {
    if (value(s, p) !== null || value(s, prevP) !== null) continue;
    if (!s.everHadData) {
      never.push(s);
      continue;
    }
    out.push({
      id: `missing:${s.key}:${s.unitSlug ?? ""}`,
      rule: "missing",
      severity: "warn",
      company: input.companyName,
      metrics: [s.entryLabel ?? s.label],
      metricKeys: [s.key],
      numbers: [],
      sentence: `${s.entryLabel ?? s.label} has no numbers for ${monthName(prevP)} and ${monthLabel(p)} (2+ months missing).`,
    });
  }
  if (never.length) {
    out.push({
      id: "never_entered",
      rule: "never_entered",
      severity: "info",
      company: input.companyName,
      metrics: never.map((s) => s.entryLabel ?? s.label),
      metricKeys: never.map((s) => s.key),
      numbers: [],
      sentence: `Never entered yet, so not analysed: ${never.map((s) => s.entryLabel ?? s.label).join(", ")}.`,
    });
  }
  return out;
}

function debtTrendRule(input: FinanceInput): Finding | null {
  const s = input.series.find((x) => x.key === "intercompany_debt");
  if (!s) return null;
  const months = [3, 2, 1, 0].map((n) => addMonths(input.period, -n));
  const vals = months.map((m) => value(s, m));
  if (vals.some((v) => v === null)) return null;
  const v = vals as Dec[];
  if (!(v[0]! < v[1]! && v[1]! < v[2]! && v[2]! < v[3]!)) return null;
  return {
    id: "debt_trend:intercompany_debt:",
    rule: "debt_trend",
    severity: "risk",
    company: input.companyName,
    metrics: [s.label],
    metricKeys: [s.key],
    numbers: months.map((m, i) => ({ label: `${s.label} · ${monthLabel(m)}`, value: formatDec(v[i]!, s.unit) })),
    sentence: `${s.label} grew 3 months in a row: ${v.map((x) => formatDec(x, s.unit)).join(" → ")} (${shortMonth(months[0]!)}–${shortMonth(months[3]!)}), +${formatDec(sub(v[3]!, v[0]!), s.unit)} in total.`,
  };
}

function targetRule(s: MonthSeries, input: FinanceInput): Finding | null {
  if (s.target === null || s.direction === "neutral") return null;
  const cur = value(s, input.period);
  if (cur === null) return null;
  const target = dec(s.target);
  const missed = s.direction === "higher_is_better" ? cmp(cur, target) < 0 : cmp(cur, target) > 0;
  if (!missed) return null;
  const R = dec(input.thresholds.riskChangePct);
  const where = s.direction === "higher_is_better" ? "below" : "above";
  return {
    id: `target:${s.key}:${s.unitSlug ?? ""}`,
    rule: "target",
    severity: target !== 0n && changeAtLeast(cur, target, R) ? "risk" : "warn",
    company: input.companyName,
    metrics: [s.label],
    metricKeys: [s.key],
    numbers: [
      { label: `${s.label} · ${monthLabel(input.period)}`, value: formatDec(cur, s.unit) },
      { label: `${s.label} · target`, value: formatDec(target, s.unit) },
    ],
    sentence: `${s.label} was ${formatDec(cur, s.unit)} in ${monthName(input.period)}, ${where} the ${formatDec(target, s.unit)} target (off by ${s.unit === "%" ? `${formatDec(abs(sub(cur, target)), undefined, 1)} pp` : formatDec(abs(sub(cur, target)), s.unit)}).`,
  };
}

const RULE_ORDER: FindingRule[] = ["debt_trend", "cod_payout", "target", "change", "ratio", "missing", "never_entered"];

/** All findings for one company and month, most severe first. Deterministic for the same input. */
export function analyseFinance(input: FinanceInput): Finding[] {
  const out: Finding[] = [];
  const debt = debtTrendRule(input);
  if (debt) out.push(debt);
  const cod = codPayoutRule(input);
  if (cod) out.push(cod);
  for (const s of input.series) {
    const t = targetRule(s, input);
    if (t) out.push(t);
  }
  for (const s of input.series) {
    // The debt trend has its own rule; a growing debt is not also a "change".
    if (s.key === "intercompany_debt" && debt) continue;
    const c = changeRule(s, input);
    if (c) out.push(c);
  }
  out.push(...ratioRules(input), ...missingRules(input));
  return out.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule) ||
      a.id.localeCompare(b.id),
  );
}

export function countBySeverity(findings: readonly Pick<Finding, "severity">[]): Record<Severity, number> {
  const out: Record<Severity, number> = { risk: 0, warn: 0, info: 0 };
  for (const f of findings) out[f.severity]++;
  return out;
}

/** "2 risks · 3 warnings · 1 info", or "No findings". */
export function severitySummary(findings: readonly Pick<Finding, "severity">[]): string {
  const c = countBySeverity(findings);
  const bits: string[] = [];
  if (c.risk) bits.push(`${c.risk} risk${c.risk === 1 ? "" : "s"}`);
  if (c.warn) bits.push(`${c.warn} warning${c.warn === 1 ? "" : "s"}`);
  if (c.info) bits.push(`${c.info} info`);
  return bits.length ? bits.join(" · ") : "No findings";
}
