/**
 * Runs one connector for a date range: health check → pull → write values
 * (source = connector) → log the attempt in `connector_runs`. Never throws for a
 * connector problem: the run is logged as "not_configured" or "error" instead.
 *
 * No "server-only": used by the app (Settings / company page "Check now"), a future
 * scheduled tick, and tests (with a fake connector).
 */
import { and, eq, isNull } from "drizzle-orm";
import { addDays, daysBetween, isIsoDate, todayInTimeZone } from "@/lib/dates";
import { metricValueProblem, parsePeriodInput, periodStart, type Granularity } from "@/lib/metrics";
import type { Db } from "@/server/db/connect";
import { companies, companyUnits, connectorRuns, metricDefinitions, type ConnectorRun } from "@/server/db/schema";
import { writeMetricValueTx } from "@/server/services/metrics";
import { defaultRegistry, type ConnectorRegistry } from "./registry";
import type { DateRange } from "./types";

export const MAX_RANGE_DAYS = 366;

export interface RunOptions {
  registry?: ConnectorRegistry;
  now?: Date;
  timeZone?: string;
  triggeredBy?: string | null;
}

export interface RunResult {
  runId: string | null;
  status: ConnectorRun["status"];
  message: string;
  pointsReceived: number;
  valuesWritten: number;
  skipped: number;
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

export async function runConnector(db: Db, id: string, range: DateRange, opts: RunOptions = {}): Promise<RunResult> {
  const registry = opts.registry ?? defaultRegistry();
  const now = opts.now ?? new Date();
  const tz = opts.timeZone ?? (process.env.APP_TIMEZONE || "Asia/Bishkek");
  const connector = registry.get(id);
  if (!connector) return { runId: null, status: "error", message: `Unknown connector: ${id}`, pointsReceived: 0, valuesWritten: 0, skipped: 0 };
  const rangeProblem = validateRange(range);
  if (rangeProblem) return { runId: null, status: "error", message: rangeProblem, pointsReceived: 0, valuesWritten: 0, skipped: 0 };

  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.slug, connector.companySlug), isNull(companies.archivedAt)));

  const log = async (r: Omit<RunResult, "runId">): Promise<RunResult> => {
    const [row] = await db
      .insert(connectorRuns)
      .values({
        connectorId: id,
        companyId: company?.id ?? null,
        status: r.status,
        rangeFrom: range.from,
        rangeTo: range.to,
        pointsReceived: r.pointsReceived,
        valuesWritten: r.valuesWritten,
        message: r.message.slice(0, 500),
        triggeredBy: opts.triggeredBy ?? null,
        startedAt: now,
        finishedAt: new Date(),
      })
      .returning({ id: connectorRuns.id });
    return { runId: row!.id, ...r };
  };

  if (!company) return log({ status: "error", message: `Company ${connector.companySlug} not found`, pointsReceived: 0, valuesWritten: 0, skipped: 0 });

  let health;
  try {
    health = await connector.healthCheck();
  } catch (err) {
    return log({ status: "error", message: `Health check failed: ${(err as Error).message}`, pointsReceived: 0, valuesWritten: 0, skipped: 0 });
  }
  if (health.state !== "ok") {
    return log({ status: health.state === "error" ? "error" : "not_configured", message: health.message, pointsReceived: 0, valuesWritten: 0, skipped: 0 });
  }

  let points;
  try {
    points = await connector.pull(range);
  } catch (err) {
    return log({ status: "error", message: `Pull failed: ${(err as Error).message}`, pointsReceived: 0, valuesWritten: 0, skipped: 0 });
  }

  // Metrics of the connector's company that it declares it can provide.
  const defs = await db
    .select({ id: metricDefinitions.id, key: metricDefinitions.key, unit: metricDefinitions.unit, granularity: metricDefinitions.granularity, unitSlug: companyUnits.slug })
    .from(metricDefinitions)
    .leftJoin(companyUnits, eq(companyUnits.id, metricDefinitions.companyUnitId))
    .where(and(eq(metricDefinitions.companyId, company.id), isNull(metricDefinitions.archivedAt)));
  const allowed = new Set(connector.metrics.map((m) => `${m.key}|${m.unitSlug ?? ""}`));
  const defByKey = new Map(defs.map((d) => [`${d.key}|${d.unitSlug ?? ""}`, d]));
  const today = todayInTimeZone(now, tz);

  // Insert the run first so values can point at it.
  const [run] = await db
    .insert(connectorRuns)
    .values({ connectorId: id, companyId: company.id, status: "ok", rangeFrom: range.from, rangeTo: range.to, triggeredBy: opts.triggeredBy ?? null, startedAt: now })
    .returning({ id: connectorRuns.id });
  let written = 0;
  let skipped = 0;
  try {
    await db.transaction(async (tx) => {
      for (const p of points) {
        const key = `${p.metricKey}|${p.unitSlug ?? ""}`;
        const def = defByKey.get(key);
        const period = def ? parsePeriodInput(p.periodStart, def.granularity as Granularity) : null;
        if (
          !def ||
          !allowed.has(key) ||
          !period ||
          p.periodStart < range.from ||
          p.periodStart > range.to ||
          period > periodStart(today, def.granularity as Granularity) ||
          metricValueProblem(p.value, def.unit)
        ) {
          skipped++;
          continue;
        }
        const r = await writeMetricValueTx(tx as unknown as Db, def.id, period, p.value, {
          source: "connector",
          enteredBy: null,
          connectorRunId: run!.id,
          now,
        });
        if (r.action !== "unchanged") written++;
      }
    });
  } catch (err) {
    const message = `Write failed: ${(err as Error).message}`.slice(0, 500);
    await db.update(connectorRuns).set({ status: "error", message, pointsReceived: points.length, finishedAt: new Date() }).where(eq(connectorRuns.id, run!.id));
    return { runId: run!.id, status: "error", message, pointsReceived: points.length, valuesWritten: 0, skipped };
  }
  const message = `${written} value(s) written${skipped ? `, ${skipped} point(s) skipped` : ""}`;
  await db
    .update(connectorRuns)
    .set({ pointsReceived: points.length, valuesWritten: written, message, finishedAt: new Date() })
    .where(eq(connectorRuns.id, run!.id));
  return { runId: run!.id, status: "ok", message, pointsReceived: points.length, valuesWritten: written, skipped };
}
