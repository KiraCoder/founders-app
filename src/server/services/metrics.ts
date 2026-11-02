import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { todayInTimeZone, type IsoDate } from "@/lib/dates";
import { metricGridInputSchema, metricValueInputSchema, type MetricValueInput } from "@/lib/metric-schemas";
import {
  changeVsPrevious,
  dueDaysFor,
  lastPeriods,
  metricFreshness,
  metricValueProblem,
  parseMetricNumber,
  parsePeriodInput,
  periodStart,
  type Change,
  type Direction,
  type Freshness,
  type FreshnessStatus,
  type Granularity,
  type PeriodValue,
} from "@/lib/metrics";
import type { Db } from "@/server/db/connect";
import {
  companies,
  companyUnits,
  metricDefinitions,
  metricValues,
  users,
  type MetricSource,
} from "@/server/db/schema";
import { assertCompanyAccess, assertMetricAccess, visibleMetricsWhere } from "./access";
import { today, type ServiceContext } from "./context";
import { ServiceError } from "./errors";

/**
 * Numbers layer: metric definitions per company, values with history, freshness.
 * Every read composes `visibleMetricsWhere` (access.ts); every write first checks
 * `assertMetricAccess`. Values are append-only: a correction clears `is_current` on the
 * old row and inserts a new one (latest wins, history kept).
 */

export const SPARK_PERIODS = 12;

export interface MetricView {
  id: string;
  companyId: string;
  companySlug: string;
  companyName: string;
  companySort: number;
  companyUnitId: string | null;
  unitName: string | null;
  unitSlug: string | null;
  key: string;
  name: string;
  /** Name plus factory, e.g. "Output per day · ХБК". */
  label: string;
  aliases: string[];
  unit: string;
  granularity: Granularity;
  direction: Direction;
  /** Effective "due N days after the period" (default per granularity when not set). */
  dueDays: number;
  target: number | null;
  sourceKind: MetricSource;
  connectorId: string | null;
  sort: number;
}

export interface MetricLatest {
  period: IsoDate;
  value: number;
  source: MetricSource;
  enteredAt: string;
  /** Calendar day (Asia/Bishkek) the value was entered. */
  enteredDay: IsoDate;
  enteredByName: string | null;
  note: string | null;
}

export interface MetricCard extends MetricView {
  latest: MetricLatest | null;
  /** Current values of the last 12 periods (null = no value), oldest first. */
  series: { period: IsoDate; value: number | null }[];
  change: Change | null;
  freshness: Freshness;
}

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

async function loadDefinitions(ctx: ServiceContext, extra?: ReturnType<typeof eq>): Promise<MetricView[]> {
  const rows = await ctx.db
    .select({
      d: metricDefinitions,
      companySlug: companies.slug,
      companyName: companies.name,
      companySort: companies.sort,
      unitName: companyUnits.name,
      unitSlug: companyUnits.slug,
    })
    .from(metricDefinitions)
    .innerJoin(companies, eq(companies.id, metricDefinitions.companyId))
    .leftJoin(companyUnits, eq(companyUnits.id, metricDefinitions.companyUnitId))
    .where(and(visibleMetricsWhere(ctx), extra))
    .orderBy(asc(companies.sort), asc(metricDefinitions.sort), asc(metricDefinitions.name));
  return rows.map(({ d, companySlug, companyName, companySort, unitName, unitSlug }) => ({
    id: d.id,
    companyId: d.companyId,
    companySlug,
    companyName,
    companySort,
    companyUnitId: d.companyUnitId,
    unitName: unitName ?? null,
    unitSlug: unitSlug ?? null,
    key: d.key,
    name: d.name,
    label: unitName ? `${d.name} · ${unitName}` : d.name,
    aliases: d.aliases ?? [],
    unit: d.unit,
    granularity: d.granularity,
    direction: d.direction,
    dueDays: dueDaysFor(d.granularity, d.dueDays),
    target: num(d.target),
    sourceKind: d.sourceKind,
    connectorId: d.connectorId,
    sort: d.sort,
  }));
}

export async function listMetricDefinitions(ctx: ServiceContext, companyId?: string): Promise<MetricView[]> {
  if (companyId) await assertCompanyAccess(ctx, companyId);
  return loadDefinitions(ctx, companyId ? eq(metricDefinitions.companyId, companyId) : undefined);
}

export async function getMetric(ctx: ServiceContext, metricId: string): Promise<MetricView> {
  await assertMetricAccess(ctx, metricId);
  const [m] = await loadDefinitions(ctx, eq(metricDefinitions.id, metricId));
  if (!m) throw new ServiceError("not_found", "Metric not found");
  return m;
}

/** Latest current value period per metric (for freshness). */
async function latestPeriods(db: Db, metricIds: string[]): Promise<Map<string, IsoDate>> {
  if (metricIds.length === 0) return new Map();
  const rows = await db
    .select({ metricId: metricValues.metricId, period: sql<string>`max(${metricValues.periodStart})::text` })
    .from(metricValues)
    .where(and(inArray(metricValues.metricId, metricIds), eq(metricValues.isCurrent, true)))
    .groupBy(metricValues.metricId);
  return new Map(rows.map((r) => [r.metricId, r.period]));
}

/** Definitions + latest value, sparkline series, change and freshness. */
export async function buildMetricCards(ctx: ServiceContext, defs: MetricView[]): Promise<MetricCard[]> {
  if (defs.length === 0) return [];
  const ids = defs.map((d) => d.id);
  const ranked = ctx.db
    .select({
      metricId: metricValues.metricId,
      period: metricValues.periodStart,
      value: metricValues.value,
      source: metricValues.source,
      createdAt: metricValues.createdAt,
      note: metricValues.note,
      enteredByName: users.shortName,
      rn: sql<number>`row_number() over (partition by ${metricValues.metricId} order by ${metricValues.periodStart} desc)`.as("rn"),
    })
    .from(metricValues)
    .leftJoin(users, eq(users.id, metricValues.enteredBy))
    .where(and(inArray(metricValues.metricId, ids), eq(metricValues.isCurrent, true)))
    .as("ranked");
  const rows = await ctx.db.select().from(ranked).where(sql`${ranked.rn} <= ${SPARK_PERIODS + 1}`);
  const byMetric = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byMetric.get(r.metricId) ?? [];
    list.push(r);
    byMetric.set(r.metricId, list);
  }
  const t = today(ctx);
  return defs.map((d) => {
    const vals = (byMetric.get(d.id) ?? []).sort((a, b) => (a.period < b.period ? 1 : -1));
    const top = vals[0];
    const points: PeriodValue[] = vals.map((v) => ({ period: v.period, value: Number(v.value) }));
    const byPeriod = new Map(points.map((p) => [p.period, p.value]));
    const end = top && top.period > periodStart(t, d.granularity) ? top.period : t;
    const latest: MetricLatest | null = top
      ? {
          period: top.period,
          value: Number(top.value),
          source: top.source,
          enteredAt: top.createdAt.toISOString(),
          enteredDay: todayInTimeZone(top.createdAt, ctx.timeZone),
          enteredByName: top.enteredByName ?? null,
          note: top.note,
        }
      : null;
    return {
      ...d,
      latest,
      series: lastPeriods(end, d.granularity, SPARK_PERIODS).map((p) => ({ period: p, value: byPeriod.get(p) ?? null })),
      change: changeVsPrevious(points, d.granularity, d.direction),
      freshness: metricFreshness({ granularity: d.granularity, dueDays: d.dueDays, latestPeriod: top?.period ?? null }, t),
    };
  });
}

export async function listCompanyMetricCards(ctx: ServiceContext, companyId: string): Promise<MetricCard[]> {
  return buildMetricCards(ctx, await listMetricDefinitions(ctx, companyId));
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface MetricValueRow {
  id: string;
  period: IsoDate;
  value: number;
  source: MetricSource;
  isCurrent: boolean;
  note: string | null;
  enteredByName: string | null;
  createdAt: string;
}

/** All rows (current and corrected ones), newest period first, then newest entry first. */
export async function listMetricValues(
  ctx: ServiceContext,
  metricId: string,
  opts: { limit?: number; includeHistory?: boolean } = {},
): Promise<MetricValueRow[]> {
  await assertMetricAccess(ctx, metricId);
  const rows = await ctx.db
    .select({ v: metricValues, enteredByName: users.shortName })
    .from(metricValues)
    .leftJoin(users, eq(users.id, metricValues.enteredBy))
    .where(and(eq(metricValues.metricId, metricId), opts.includeHistory ? undefined : eq(metricValues.isCurrent, true)))
    .orderBy(desc(metricValues.periodStart), desc(metricValues.isCurrent), desc(metricValues.createdAt))
    .limit(Math.min(Math.max(opts.limit ?? 200, 1), 1000));
  return rows.map(({ v, enteredByName }) => ({
    id: v.id,
    period: v.periodStart,
    value: Number(v.value),
    source: v.source,
    isCurrent: v.isCurrent,
    note: v.note,
    enteredByName: enteredByName ?? null,
    createdAt: v.createdAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type WriteAction = "created" | "updated" | "unchanged";

export interface WriteMeta {
  source: MetricSource;
  enteredBy: string | null;
  note?: string | null;
  connectorRunId?: string | null;
  now: Date;
}

const sameNumber = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/**
 * Writes one value. MUST run inside a transaction (`db` is the transaction): the metric
 * row is locked so two writers for the same metric never both become "current".
 * Same value (and no new note) → unchanged, nothing written.
 */
export async function writeMetricValueTx(
  tx: Db,
  metricId: string,
  period: IsoDate,
  value: number,
  meta: WriteMeta,
): Promise<{ action: WriteAction; id: string | null; previous: number | null }> {
  await tx.select({ id: metricDefinitions.id }).from(metricDefinitions).where(eq(metricDefinitions.id, metricId)).for("update");
  const [current] = await tx
    .select({ id: metricValues.id, value: metricValues.value, note: metricValues.note })
    .from(metricValues)
    .where(and(eq(metricValues.metricId, metricId), eq(metricValues.periodStart, period), eq(metricValues.isCurrent, true)));
  const previous = current ? Number(current.value) : null;
  const note = meta.note?.trim() || null;
  if (current && previous !== null && sameNumber(previous, value) && (note === null || note === current.note)) {
    return { action: "unchanged", id: current.id, previous };
  }
  if (current) await tx.update(metricValues).set({ isCurrent: false }).where(eq(metricValues.id, current.id));
  const [row] = await tx
    .insert(metricValues)
    .values({
      metricId,
      periodStart: period,
      value: String(value),
      source: meta.source,
      isCurrent: true,
      enteredBy: meta.enteredBy,
      connectorRunId: meta.connectorRunId ?? null,
      note,
      createdAt: meta.now,
    })
    .returning({ id: metricValues.id });
  return { action: current ? "updated" : "created", id: row!.id, previous };
}

/** Validates a period for a metric: parsed, normalized to its start, not in the future. */
export function resolvePeriod(raw: string, g: Granularity, todayIso: IsoDate): IsoDate {
  const p = parsePeriodInput(raw, g);
  if (!p) throw new ServiceError("validation", "Period not recognised (use e.g. 2026-10-31 or 2026-10)", { period: ["Not a date"] });
  if (p > periodStart(todayIso, g)) throw new ServiceError("validation", "That period is in the future", { period: ["In the future"] });
  if (p < "2000-01-01") throw new ServiceError("validation", "That period is too far back", { period: ["Too old"] });
  return p;
}

export function resolveValue(raw: unknown, unit: string): number {
  const n = parseMetricNumber(raw);
  const problem = metricValueProblem(n, unit);
  if (problem) throw new ServiceError("validation", problem, { value: [problem] });
  return n;
}

/** Manual entry (Overview "Enter value", REST POST). */
export async function recordMetricValue(
  ctx: ServiceContext,
  metricId: string,
  input: MetricValueInput,
  source: Extract<MetricSource, "manual" | "upload"> = "manual",
): Promise<{ action: WriteAction; period: IsoDate; value: number }> {
  const metric = await getMetric(ctx, metricId);
  const data = metricValueInputSchema.parse(input);
  const period = resolvePeriod(data.period, metric.granularity, today(ctx));
  const value = resolveValue(data.value, metric.unit);
  const res = await ctx.db.transaction((tx) =>
    writeMetricValueTx(tx as unknown as Db, metric.id, period, value, {
      source,
      enteredBy: ctx.user.id,
      note: data.note ?? null,
      now: ctx.now,
    }),
  );
  return { action: res.action, period, value };
}

export interface GridResult {
  created: number;
  updated: number;
  unchanged: number;
  errors: { metricId: string; period: string; message: string }[];
}

/**
 * The Numbers grid: saves the given cells of one company in one transaction. Cells with an
 * error are reported and skipped; the others are saved. Empty cells are ignored (values
 * are never deleted from the grid).
 */
export async function saveMetricGrid(ctx: ServiceContext, companyId: string, rawCells: unknown): Promise<GridResult> {
  const cells = metricGridInputSchema.parse(rawCells);
  const defs = new Map((await listMetricDefinitions(ctx, companyId)).map((d) => [d.id, d]));
  const t = today(ctx);
  const result: GridResult = { created: 0, updated: 0, unchanged: 0, errors: [] };
  const valid: { metricId: string; period: IsoDate; value: number }[] = [];
  for (const c of cells) {
    if (c.value === "") continue;
    const def = defs.get(c.metricId);
    if (!def) {
      result.errors.push({ metricId: c.metricId, period: c.period, message: "Metric not found in this company" });
      continue;
    }
    try {
      valid.push({ metricId: def.id, period: resolvePeriod(c.period, def.granularity, t), value: resolveValue(c.value, def.unit) });
    } catch (err) {
      if (!(err instanceof ServiceError)) throw err;
      result.errors.push({ metricId: c.metricId, period: c.period, message: `${def.label}: ${err.message}` });
    }
  }
  await ctx.db.transaction(async (tx) => {
    for (const v of valid) {
      const r = await writeMetricValueTx(tx as unknown as Db, v.metricId, v.period, v.value, {
        source: "manual",
        enteredBy: ctx.user.id,
        now: ctx.now,
      });
      result[r.action]++;
    }
  });
  return result;
}

/** Current values for a set of metrics and periods (grid prefill, import preview). */
export async function currentValues(db: Db, metricIds: string[], periods?: { from: IsoDate; to: IsoDate }): Promise<Map<string, number>> {
  if (metricIds.length === 0) return new Map();
  const rows = await db
    .select({ metricId: metricValues.metricId, period: metricValues.periodStart, value: metricValues.value })
    .from(metricValues)
    .where(
      and(
        inArray(metricValues.metricId, metricIds),
        eq(metricValues.isCurrent, true),
        periods ? sql`${metricValues.periodStart} between ${periods.from} and ${periods.to}` : undefined,
      ),
    );
  return new Map(rows.map((r) => [`${r.metricId}|${r.period}`, Number(r.value)]));
}

// ---------------------------------------------------------------------------
// Freshness across companies
// ---------------------------------------------------------------------------

export interface CompanyFreshness {
  companyId: string;
  companySlug: string;
  companyName: string;
  total: number;
  fresh: number;
  stale: number;
  missing: number;
}

async function freshnessOfAll(ctx: ServiceContext): Promise<{ def: MetricView; freshness: Freshness }[]> {
  const defs = await loadDefinitions(ctx);
  const latest = await latestPeriods(ctx.db, defs.map((d) => d.id));
  const t = today(ctx);
  return defs.map((def) => ({
    def,
    freshness: metricFreshness({ granularity: def.granularity, dueDays: def.dueDays, latestPeriod: latest.get(def.id) ?? null }, t),
  }));
}

/** One row per company with metrics: how many numbers are fresh, stale (overdue) or missing. */
export async function companyFreshness(ctx: ServiceContext): Promise<CompanyFreshness[]> {
  const out = new Map<string, CompanyFreshness>();
  for (const { def, freshness } of await freshnessOfAll(ctx)) {
    const row =
      out.get(def.companyId) ??
      ({ companyId: def.companyId, companySlug: def.companySlug, companyName: def.companyName, total: 0, fresh: 0, stale: 0, missing: 0 } as CompanyFreshness);
    row.total++;
    if (freshness.status === "fresh") row.fresh++;
    else if (freshness.status === "missing") row.missing++;
    else row.stale++;
    out.set(def.companyId, row);
  }
  return [...out.values()];
}

export interface StaleMetric {
  metricId: string;
  companyId: string;
  companySlug: string;
  companyName: string;
  label: string;
  unit: string;
  granularity: Granularity;
  sourceKind: MetricSource;
  connectorId: string | null;
  status: Exclude<FreshnessStatus, "fresh">;
  waitingFor: IsoDate;
  dueOn: IsoDate;
  overduePeriods: number;
}

/**
 * Hook for the notification planner: metrics whose data is overdue for this user at
 * `ctx.now` (company data is shared, so both founders get the same list). Ordered by
 * company, then metric. Pure read; it never queues anything itself.
 */
export async function staleMetricsFor(ctx: ServiceContext): Promise<StaleMetric[]> {
  const out: StaleMetric[] = [];
  for (const { def, freshness } of await freshnessOfAll(ctx)) {
    if (freshness.status === "fresh" || !freshness.waitingFor || !freshness.dueOn) continue;
    out.push({
      metricId: def.id,
      companyId: def.companyId,
      companySlug: def.companySlug,
      companyName: def.companyName,
      label: def.label,
      unit: def.unit,
      granularity: def.granularity,
      sourceKind: def.sourceKind,
      connectorId: def.connectorId,
      status: freshness.status,
      waitingFor: freshness.waitingFor,
      dueOn: freshness.dueOn,
      overduePeriods: freshness.overduePeriods,
    });
  }
  return out;
}

/** Metric definitions of a company by slug (REST). */
export async function companyIdBySlug(ctx: ServiceContext, slug: string): Promise<string> {
  const [row] = await ctx.db.select({ id: companies.id }).from(companies).where(eq(companies.slug, slug));
  if (!row) throw new ServiceError("not_found", "Company not found");
  await assertCompanyAccess(ctx, row.id);
  return row.id;
}
