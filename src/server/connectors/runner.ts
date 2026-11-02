/**
 * Runs one connector for a date range: run row ("running") → health check → pull (pages,
 * time limit) → plan → write values (source = connector) → finalise the run row.
 * Never throws for a connector problem: the run is finalised as "not_configured" or
 * "error" instead.
 *
 * Rules (numbers founders decide on, so refuse rather than guess):
 * - A connector never overwrites a value a founder entered or uploaded for the same
 *   period. A different number is recorded as a conflict in `connector_runs.details`
 *   and the card shows "source disagrees".
 * - Weekly / monthly numbers are written only for COMPLETE periods (not the current week
 *   or month). Daily points for a weekly / monthly metric are combined with the metric's
 *   aggregation (sum / avg / last), only when the range covers the whole period and every
 *   day was received ("last" needs the period's last day).
 * - A point is kept when its period overlaps the range (so a monthly point labelled
 *   with the 1st is not lost because the range starts later in the month).
 *
 * No "server-only": used by the app ("Check now"), a future scheduled tick, and tests
 * (with a fake connector).
 */
import { and, eq, isNull } from "drizzle-orm";
import { addDays, daysBetween, isIsoDate, todayInTimeZone, type IsoDate } from "@/lib/dates";
import {
  aggregateValues,
  metricValueProblem,
  periodEnd,
  periodProblem,
  periodStart,
  prevPeriod,
  type Aggregation,
  type Granularity,
} from "@/lib/metrics";
import type { Db } from "@/server/db/connect";
import {
  companies,
  companyUnits,
  connectorRuns,
  metricDefinitions,
  type ConnectorRun,
  type ConnectorRunConflict,
  type ConnectorRunDetails,
} from "@/server/db/schema";
import { byMetricThenPeriod, writeMetricValueTx } from "@/server/services/metrics";
import { defaultRegistry, type ConnectorRegistry } from "./registry";
import type { Connector, DateRange, MetricPoint, PullPage } from "./types";

export const MAX_RANGE_DAYS = 366;
/** Whole pull (all pages) must finish within this time; the signal aborts it. */
export const PULL_TIMEOUT_MS = 60_000;
export const HEALTH_TIMEOUT_MS = 15_000;
export const MAX_PULL_PAGES = 50;
export const MAX_PULL_POINTS = 50_000;
/** A run still "running" after this long was interrupted (crash, deploy). */
export const RUN_STALE_MS = 10 * 60_000;
const MAX_REASONS = 20;

export interface RunOptions {
  registry?: ConnectorRegistry;
  now?: Date;
  timeZone?: string;
  triggeredBy?: string | null;
  /** Override the pull time limit (tests). */
  timeoutMs?: number;
}

export interface RunResult {
  runId: string | null;
  status: ConnectorRun["status"];
  message: string;
  pointsReceived: number;
  valuesWritten: number;
  skipped: number;
  conflicts: number;
}

export function validateRange(range: DateRange): string | null {
  if (!isIsoDate(range.from) || !isIsoDate(range.to)) return "Range dates must be YYYY-MM-DD";
  if (range.from > range.to) return "Range starts after it ends";
  if (daysBetween(range.from, range.to) > MAX_RANGE_DAYS) return `Range is longer than ${MAX_RANGE_DAYS} days`;
  return null;
}

/** The last `days` days up to yesterday (Asia/Bishkek). */
export function recentRange(now: Date, days = 7, timeZone = "Asia/Bishkek"): DateRange {
  const today = todayInTimeZone(now, timeZone);
  return { from: addDays(today, -days), to: addDays(today, -1) };
}

/**
 * Range for "Check now": from the 1st of the previous month (or 7 days back, whichever is
 * earlier) to yesterday, so the last complete week and month are always covered.
 */
export function checkRange(now: Date, timeZone = "Asia/Bishkek"): DateRange {
  const today = todayInTimeZone(now, timeZone);
  const prevMonth = prevPeriod(periodStart(today, "month"), "month");
  const weekBack = addDays(today, -7);
  return { from: prevMonth < weekBack ? prevMonth : weekBack, to: addDays(today, -1) };
}

const RANK: Record<Granularity, number> = { day: 0, week: 1, month: 2 };

function abortable<T>(p: Promise<T>, signal: AbortSignal, what: string): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(`${what} timed out`));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(`${what} timed out`));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** All pages of a pull, bounded by MAX_PULL_PAGES / MAX_PULL_POINTS and the signal. */
async function pullAll(connector: Connector, range: DateRange, signal: AbortSignal): Promise<MetricPoint[]> {
  const points: MetricPoint[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PULL_PAGES; page++) {
    const res: MetricPoint[] | PullPage = await abortable(connector.pull(range, { signal, cursor }), signal, "Pull");
    const list = Array.isArray(res) ? res : res.points;
    points.push(...list);
    if (points.length > MAX_PULL_POINTS) throw new Error(`More than ${MAX_PULL_POINTS} points`);
    const next = Array.isArray(res) ? null : (res.nextCursor ?? null);
    if (!next) return points;
    if (next === cursor) throw new Error("The source returned the same page cursor twice");
    cursor = next;
  }
  throw new Error(`More than ${MAX_PULL_PAGES} pages`);
}

interface DefRow {
  id: string;
  key: string;
  unit: string;
  granularity: Granularity;
  aggregation: Aggregation;
  unitSlug: string | null;
}

interface PlannedWrite {
  metricId: string;
  period: IsoDate;
  value: number;
}

/** Turns points into one value per metric + period (pure). */
export function planConnectorWrites(
  points: readonly MetricPoint[],
  defs: readonly DefRow[],
  allowedKeys: ReadonlySet<string>,
  range: DateRange,
  today: IsoDate,
): { writes: PlannedWrite[]; skipped: number; reasons: string[] } {
  const defByKey = new Map(defs.map((d) => [`${d.key}|${d.unitSlug ?? ""}`, d]));
  const reasons: string[] = [];
  let skipped = 0;
  const skip = (n: number, why: string) => {
    skipped += n;
    if (reasons.length < MAX_REASONS) reasons.push(why);
  };
  // metricId|period → points (direct ones and daily ones to aggregate are kept apart)
  const direct = new Map<string, { def: DefRow; period: IsoDate; values: number[] }>();
  const daily = new Map<string, { def: DefRow; period: IsoDate; byDay: Map<IsoDate, number[]> }>();

  for (const p of points) {
    const key = `${p.metricKey}|${p.unitSlug ?? ""}`;
    const def = defByKey.get(key);
    const label = `${p.metricKey}${p.unitSlug ? `/${p.unitSlug}` : ""} ${p.periodStart}`;
    if (!def || !allowedKeys.has(key)) {
      skip(1, `${label}: not a metric of this source`);
      continue;
    }
    if (!isIsoDate(p.periodStart)) {
      skip(1, `${label}: bad date`);
      continue;
    }
    if (typeof p.value !== "number" || metricValueProblem(p.value, def.unit)) {
      skip(1, `${label}: ${typeof p.value === "number" ? metricValueProblem(p.value, def.unit) : "not a number"}`);
      continue;
    }
    const pg: Granularity = p.granularity ?? "day";
    if (RANK[pg] > RANK[def.granularity]) {
      skip(1, `${label}: a ${pg} value can't fill a ${def.granularity} number`);
      continue;
    }
    if (pg === "week" && def.granularity === "month") {
      skip(1, `${label}: weeks don't fit into months`);
      continue;
    }
    if (pg === def.granularity) {
      const period = periodStart(p.periodStart, pg);
      if (period > range.to || periodEnd(period, pg) < range.from) {
        skip(1, `${label}: outside the range`);
        continue;
      }
      const k = `${def.id}|${period}`;
      const e = direct.get(k) ?? { def, period, values: [] };
      e.values.push(p.value);
      direct.set(k, e);
    } else {
      if (p.periodStart < range.from || p.periodStart > range.to) {
        skip(1, `${label}: outside the range`);
        continue;
      }
      const period = periodStart(p.periodStart, def.granularity);
      const k = `${def.id}|${period}`;
      const e = daily.get(k) ?? { def, period, byDay: new Map() };
      e.byDay.set(p.periodStart, [...(e.byDay.get(p.periodStart) ?? []), p.value]);
      daily.set(k, e);
    }
  }

  const writes: PlannedWrite[] = [];
  for (const { def, period, values } of direct.values()) {
    const label = `${def.key} ${period}`;
    const problem = periodProblem(period, def.granularity, today);
    if (problem) skip(values.length, `${label}: ${problem}`);
    else if (values.length > 1) skip(values.length, `${label}: ${values.length} values for one period`);
    else writes.push({ metricId: def.id, period, value: values[0]! });
  }
  for (const { def, period, byDay } of daily.values()) {
    const n = [...byDay.values()].reduce((a, v) => a + v.length, 0);
    const label = `${def.key} ${period}`;
    const end = periodEnd(period, def.granularity);
    const problem = periodProblem(period, def.granularity, today);
    if (problem) {
      skip(n, `${label}: ${problem}`);
      continue;
    }
    if (period < range.from || end > range.to) {
      skip(n, `${label}: the range covers only part of this ${def.granularity}`);
      continue;
    }
    if ([...byDay.values()].some((v) => v.length > 1)) {
      skip(n, `${label}: two values for the same day`);
      continue;
    }
    const days = daysBetween(period, end) + 1;
    if (def.aggregation === "last" ? !byDay.has(end) : byDay.size !== days) {
      skip(n, `${label}: ${def.aggregation === "last" ? "no value for the last day" : `${byDay.size} of ${days} days received`}`);
      continue;
    }
    const value = aggregateValues(
      [...byDay.entries()].map(([day, v]) => ({ day, value: v[0]! })),
      def.aggregation,
    );
    const valueProblem = metricValueProblem(value, def.unit);
    if (valueProblem) skip(n, `${label}: ${valueProblem}`);
    else writes.push({ metricId: def.id, period, value });
  }
  writes.sort(byMetricThenPeriod);
  return { writes, skipped, reasons };
}

export async function runConnector(db: Db, id: string, range: DateRange, opts: RunOptions = {}): Promise<RunResult> {
  const registry = opts.registry ?? defaultRegistry();
  const now = opts.now ?? new Date();
  const tz = opts.timeZone ?? (process.env.APP_TIMEZONE || "Asia/Bishkek");
  const none = { pointsReceived: 0, valuesWritten: 0, skipped: 0, conflicts: 0 };
  const connector = registry.get(id);
  if (!connector) return { runId: null, status: "error", message: `Unknown connector: ${id}`, ...none };
  const rangeProblem = validateRange(range);
  if (rangeProblem) return { runId: null, status: "error", message: rangeProblem, ...none };

  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.slug, connector.companySlug), isNull(companies.archivedAt)));

  // The run is visible as "running" from the start and finalised at the end.
  const [run] = await db
    .insert(connectorRuns)
    .values({
      connectorId: id,
      companyId: company?.id ?? null,
      status: "running",
      rangeFrom: range.from,
      rangeTo: range.to,
      triggeredBy: opts.triggeredBy ?? null,
      startedAt: now,
    })
    .returning({ id: connectorRuns.id });
  const runId = run!.id;

  const finish = async (r: Omit<RunResult, "runId">, details?: ConnectorRunDetails): Promise<RunResult> => {
    await db
      .update(connectorRuns)
      .set({
        status: r.status,
        pointsReceived: r.pointsReceived,
        valuesWritten: r.valuesWritten,
        message: r.message.slice(0, 500),
        details: details ?? null,
        finishedAt: new Date(),
      })
      .where(eq(connectorRuns.id, runId));
    return { runId, ...r };
  };

  if (!company) return finish({ status: "error", message: `Company ${connector.companySlug} not found`, ...none });

  const healthSignal = AbortSignal.timeout(HEALTH_TIMEOUT_MS);
  let health;
  try {
    health = await abortable(connector.healthCheck(), healthSignal, "Health check");
  } catch (err) {
    return finish({ status: "error", message: `Health check failed: ${(err as Error).message}`, ...none });
  }
  if (health.state !== "ok") {
    return finish({ status: health.state === "error" ? "error" : "not_configured", message: health.message, ...none });
  }

  let points: MetricPoint[];
  try {
    points = await pullAll(connector, range, AbortSignal.timeout(opts.timeoutMs ?? PULL_TIMEOUT_MS));
  } catch (err) {
    return finish({ status: "error", message: `Pull failed: ${(err as Error).message}`, ...none });
  }

  // Metrics of the connector's company that it declares it can provide.
  const defs = await db
    .select({
      id: metricDefinitions.id,
      key: metricDefinitions.key,
      unit: metricDefinitions.unit,
      granularity: metricDefinitions.granularity,
      aggregation: metricDefinitions.aggregation,
      unitSlug: companyUnits.slug,
    })
    .from(metricDefinitions)
    .leftJoin(companyUnits, eq(companyUnits.id, metricDefinitions.companyUnitId))
    .where(and(eq(metricDefinitions.companyId, company.id), isNull(metricDefinitions.archivedAt)));
  const allowed = new Set(connector.metrics.map((m) => `${m.key}|${m.unitSlug ?? ""}`));
  const today = todayInTimeZone(now, tz);
  const plan = planConnectorWrites(points, defs, allowed, range, today);

  let written = 0;
  const conflicts: ConnectorRunConflict[] = [];
  try {
    await db.transaction(async (tx) => {
      for (const w of plan.writes) {
        const r = await writeMetricValueTx(tx as unknown as Db, w.metricId, w.period, w.value, {
          source: "connector",
          enteredBy: null,
          connectorRunId: runId,
          now,
        });
        if (r.action === "conflict") {
          conflicts.push({
            metricId: w.metricId,
            period: w.period,
            kept: r.previous!,
            keptSource: r.previousSource === "upload" ? "upload" : "manual",
            reported: w.value,
          });
        } else if (r.action !== "unchanged") written++;
      }
    });
  } catch (err) {
    return finish({
      status: "error",
      message: `Write failed: ${(err as Error).message}`,
      pointsReceived: points.length,
      valuesWritten: 0,
      skipped: plan.skipped,
      conflicts: 0,
    });
  }
  const bits = [`${written} value(s) written`];
  if (plan.skipped) bits.push(`${plan.skipped} point(s) skipped`);
  if (conflicts.length) bits.push(`${conflicts.length} differ from numbers entered by hand (kept)`);
  return finish(
    {
      status: "ok",
      message: bits.join(", "),
      pointsReceived: points.length,
      valuesWritten: written,
      skipped: plan.skipped,
      conflicts: conflicts.length,
    },
    { conflicts, skippedReasons: plan.reasons },
  );
}
