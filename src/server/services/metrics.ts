import "server-only";
import { and, asc, desc, eq, gte, inArray, isNotNull, notLike, sql } from "drizzle-orm";
import { todayInTimeZone, type IsoDate } from "@/lib/dates";
import { metricGridInputSchema, metricValueInputSchema, type MetricValueInput } from "@/lib/metric-schemas";
import {
  changeVsPrevious,
  dueDaysFor,
  expectedPeriod,
  GAP_WINDOW,
  hasTimePart,
  isPeriodComplete,
  lastPeriods,
  metricFreshness,
  parseMetricInput,
  parsePeriodInput,
  periodProblem,
  periodStart,
  type Aggregation,
  type Change,
  type Direction,
  type Freshness,
  type FreshnessStatus,
  type Granularity,
  type PeriodValue,
} from "@/lib/metrics";
import { defaultRegistry, type ConnectorRegistry } from "@/server/connectors/registry";
import type { Db } from "@/server/db/connect";
import {
  companies,
  companyUnits,
  connectorRuns,
  metricDefinitions,
  metricValues,
  users,
  type ConnectorRunConflict,
  type MetricPeriodKind,
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

/**
 * Rows of the metric's own periods only. Month totals entered for daily numbers
 * (period_kind = month_total) are never part of the series, freshness, cards or the grid's
 * period rows; only AI roles that accept them read them (services/ai-roles.ts).
 */
export const ownPeriodRows = () => eq(metricValues.periodKind, "period");

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
  /** How a connector's daily points are combined into one week / month value. */
  aggregation: Aggregation;
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
  /** The period is not over yet (a daily number entered for today): "so far". */
  inProgress: boolean;
}

/** A data source reported another number than the one a founder entered / uploaded (kept). */
export interface MetricDisagreement {
  period: IsoDate;
  kept: number;
  keptSource: "manual" | "upload";
  reported: number;
  connectorId: string;
  at: string;
}

export interface MetricCard extends MetricView {
  latest: MetricLatest | null;
  /** Current values of the last 12 periods (null = no value), oldest first. */
  series: { period: IsoDate; value: number | null }[];
  /** Latest COMPLETE period vs the one before it (in-progress periods are never compared). */
  change: Change | null;
  freshness: Freshness;
  /** Unresolved "source disagrees" from the latest run of the metric's connector. */
  disagreements: MetricDisagreement[];
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
    aggregation: d.aggregation,
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

interface FreshnessInputs {
  first: IsoDate;
  latest: IsoDate;
  /** Periods with a current value inside (at least) the gap window. */
  periods: Set<IsoDate>;
}

/** First / latest period and the recent periods with a value, per metric (for freshness). */
async function freshnessInputs(db: Db, metricIds: string[], todayIso: IsoDate): Promise<Map<string, FreshnessInputs>> {
  if (metricIds.length === 0) return new Map();
  const bounds = await db
    .select({
      metricId: metricValues.metricId,
      first: sql<string>`min(${metricValues.periodStart})::text`,
      latest: sql<string>`max(${metricValues.periodStart})::text`,
    })
    .from(metricValues)
    .where(and(inArray(metricValues.metricId, metricIds), eq(metricValues.isCurrent, true), ownPeriodRows()))
    .groupBy(metricValues.metricId);
  // Oldest period any gap window can reach (monthly: 3 months before the expected month).
  const since = (["day", "week", "month"] as const)
    .map((g) => lastPeriods(expectedPeriod(todayIso, g), g, GAP_WINDOW[g])[0]!)
    .sort()[0]!;
  const recent = await db
    .select({ metricId: metricValues.metricId, period: metricValues.periodStart })
    .from(metricValues)
    .where(and(inArray(metricValues.metricId, metricIds), eq(metricValues.isCurrent, true), ownPeriodRows(), gte(metricValues.periodStart, since)));
  const out = new Map<string, FreshnessInputs>();
  for (const b of bounds) out.set(b.metricId, { first: b.first, latest: b.latest, periods: new Set() });
  for (const r of recent) out.get(r.metricId)?.periods.add(r.period);
  return out;
}

function freshnessOf(def: MetricView, inputs: FreshnessInputs | undefined, todayIso: IsoDate): Freshness {
  return metricFreshness(
    {
      granularity: def.granularity,
      dueDays: def.dueDays,
      latestPeriod: inputs?.latest ?? null,
      firstPeriod: inputs?.first ?? null,
      periods: inputs?.periods ?? [],
    },
    todayIso,
  );
}

/** Rows of db.execute (PGlite: { rows }, postgres-js: an array). */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | null)?.rows ?? []) as T[];
}

/**
 * Unresolved disagreements, whose kept (founder's) value is still the current one:
 * - connectors: the conflicts of the LATEST finished run of each connector and company
 *   (DISTINCT ON — however many runs there are);
 * - browser extension: per number and period, the NEWEST extension run that mentions it
 *   decides (a conflict, or an agreement with the founder's number that clears it) — so any
 *   number of later calls about other numbers never pushes a disagreement off the card.
 */
async function loadDisagreements(db: Db, defs: MetricView[]): Promise<Map<string, MetricDisagreement[]>> {
  const out = new Map<string, MetricDisagreement[]>();
  if (defs.length === 0) return out;
  const companyIds = [...new Set(defs.map((d) => d.companyId))];
  const defIds = new Set(defs.map((d) => d.id));
  // Any source of the metric's company counts (the metric may be fed by another source than expected).
  const runs = await db
    .selectDistinctOn([connectorRuns.connectorId, connectorRuns.companyId], { connectorId: connectorRuns.connectorId, details: connectorRuns.details, at: connectorRuns.startedAt })
    .from(connectorRuns)
    .where(and(inArray(connectorRuns.companyId, companyIds), eq(connectorRuns.status, "ok"), isNotNull(connectorRuns.finishedAt), notLike(connectorRuns.connectorId, "extension:%")))
    .orderBy(connectorRuns.connectorId, connectorRuns.companyId, desc(connectorRuns.startedAt), desc(connectorRuns.id));
  const conflicts: (ConnectorRunConflict & { connectorId: string; at: Date })[] = [];
  for (const r of runs) {
    for (const c of r.details?.conflicts ?? []) if (defIds.has(c.metricId)) conflicts.push({ ...c, connectorId: r.connectorId, at: r.at });
  }
  const list = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);
  const items = sql`(case when jsonb_typeof(r.details -> 'conflicts') = 'array' then r.details -> 'conflicts' else '[]'::jsonb end)`;
  const agreedItems = sql`(case when jsonb_typeof(r.details -> 'agreed') = 'array' then r.details -> 'agreed' else '[]'::jsonb end)`;
  const ext = rowsOf<{ connectorId: string; at: Date | string; kind: "conflict" | "agreed"; item: ConnectorRunConflict }>(
    await db.execute(sql`
      select distinct on (e.item ->> 'metricId', e.item ->> 'period')
        r.connector_id as "connectorId", r.started_at as "at", e.kind as "kind", e.item as "item"
      from connector_runs r
      cross join lateral (
        select 'conflict' as kind, x as item from jsonb_array_elements(${items}) x
        union all
        select 'agreed' as kind, x as item from jsonb_array_elements(${agreedItems}) x
      ) e
      where r.company_id in (${list(companyIds)}) and r.status = 'ok' and r.finished_at is not null
        and r.connector_id like 'extension:%' and e.item ->> 'metricId' in (${list([...defIds])})
      order by e.item ->> 'metricId', e.item ->> 'period', r.started_at desc, r.id desc`),
  );
  for (const r of ext) {
    if (r.kind !== "conflict") continue;
    const c = r.item;
    conflicts.push({ metricId: c.metricId, period: c.period, kept: Number(c.kept), keptSource: c.keptSource, reported: Number(c.reported), connectorId: r.connectorId, at: new Date(r.at) });
  }
  if (conflicts.length === 0) return out;
  const current = await currentValues(db, [...new Set(conflicts.map((c) => c.metricId))]);
  for (const c of conflicts) {
    const now = current.get(`${c.metricId}|${c.period}`);
    if (now === undefined || !sameNumber(now, c.kept) || sameNumber(now, c.reported)) continue;
    const list = out.get(c.metricId) ?? [];
    list.push({ period: c.period, kept: c.kept, keptSource: c.keptSource, reported: c.reported, connectorId: c.connectorId, at: c.at.toISOString() });
    out.set(c.metricId, list);
  }
  for (const list of out.values()) list.sort((a, b) => (a.period < b.period ? 1 : -1));
  return out;
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
    .where(and(inArray(metricValues.metricId, ids), eq(metricValues.isCurrent, true), ownPeriodRows()))
    .as("ranked");
  const rows = await ctx.db.select().from(ranked).where(sql`${ranked.rn} <= ${SPARK_PERIODS + 1}`);
  const byMetric = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byMetric.get(r.metricId) ?? [];
    list.push(r);
    byMetric.set(r.metricId, list);
  }
  const t = today(ctx);
  const [inputs, disagreements] = await Promise.all([freshnessInputs(ctx.db, ids, t), loadDisagreements(ctx.db, defs)]);
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
          inProgress: !isPeriodComplete(top.period, d.granularity, t),
        }
      : null;
    // A period that is not over (today's daily number) is never compared: partial vs full.
    const complete = points.filter((p) => isPeriodComplete(p.period, d.granularity, t));
    return {
      ...d,
      latest,
      series: lastPeriods(end, d.granularity, SPARK_PERIODS).map((p) => ({ period: p, value: byPeriod.get(p) ?? null })),
      change: latest && !latest.inProgress ? changeVsPrevious(complete, d.granularity, d.direction) : null,
      freshness: freshnessOf(d, inputs.get(d.id), t),
      disagreements: disagreements.get(d.id) ?? [],
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
    .where(and(eq(metricValues.metricId, metricId), ownPeriodRows(), opts.includeHistory ? undefined : eq(metricValues.isCurrent, true)))
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

export type WriteAction = "created" | "updated" | "unchanged" | "conflict";

export interface WriteMeta {
  source: MetricSource;
  enteredBy: string | null;
  /**
   * undefined = leave the note as it is; null or "" = no note (clears an existing one when
   * the value is the same); text = this note.
   */
  note?: string | null;
  connectorRunId?: string | null;
  now: Date;
  /** "month_total": a whole-month value of a daily number (see metricValues.periodKind). Default "period". */
  periodKind?: MetricPeriodKind;
}

const sameNumber = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/**
 * Writes one value. MUST run inside a transaction (`db` is the transaction): the metric
 * row is locked so two writers for the same metric never both become "current". Callers
 * writing several metrics lock them in metric-id order (see `byMetricThenPeriod`), so two
 * transactions never wait on each other in a cycle.
 *
 * Same value and same note → unchanged, nothing written. A connector never replaces a
 * value a founder entered or uploaded: when the numbers differ the result is "conflict"
 * (nothing written; the runner records it so the card shows "source disagrees").
 */
export async function writeMetricValueTx(
  tx: Db,
  metricId: string,
  period: IsoDate,
  value: number,
  meta: WriteMeta,
): Promise<{ action: WriteAction; id: string | null; previous: number | null; previousSource: MetricSource | null }> {
  await tx.select({ id: metricDefinitions.id }).from(metricDefinitions).where(eq(metricDefinitions.id, metricId)).for("update");
  const [current] = await tx
    .select({ id: metricValues.id, value: metricValues.value, note: metricValues.note, source: metricValues.source })
    .from(metricValues)
    .where(
      and(
        eq(metricValues.metricId, metricId),
        eq(metricValues.periodStart, period),
        eq(metricValues.periodKind, meta.periodKind ?? "period"),
        eq(metricValues.isCurrent, true),
      ),
    );
  const previous = current ? Number(current.value) : null;
  const previousSource = current?.source ?? null;
  const keepNote = meta.note === undefined;
  const note = keepNote ? (current?.note ?? null) : meta.note?.trim() || null;
  if (current && previous !== null && sameNumber(previous, value) && (keepNote || note === current.note)) {
    return { action: "unchanged", id: current.id, previous, previousSource };
  }
  // Automatic sources (a connector, a value derived by the app) never replace a founder's number.
  // The browser extension (POST /api/v1/ingest) counts as automatic too: latest wins among
  // automatic values, a founder's typed or uploaded number is never replaced.
  const automatic = (src: MetricSource) => src === "connector" || src === "derived" || src === "extension";
  if (current && automatic(meta.source) && !automatic(current.source)) {
    return { action: sameNumber(previous!, value) ? "unchanged" : "conflict", id: current.id, previous, previousSource };
  }
  // A changed value starts without the old note (it was about the old number) unless one is given.
  const newNote = keepNote ? null : note;
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
      note: newNote,
      periodKind: meta.periodKind ?? "period",
      createdAt: meta.now,
    })
    .returning({ id: metricValues.id });
  return { action: current ? "updated" : "created", id: row!.id, previous, previousSource };
}

/** Sort order for multi-metric writes: metric id, then period (fixed lock order, no deadlocks). */
export function byMetricThenPeriod<T extends { metricId: string; period: string }>(a: T, b: T): number {
  return a.metricId < b.metricId ? -1 : a.metricId > b.metricId ? 1 : a.period < b.period ? -1 : a.period > b.period ? 1 : 0;
}

/**
 * Validates a period for a metric: parsed, normalized to its start, not in the future and,
 * for weekly / monthly numbers, not the current unfinished week / month (a month-to-date
 * total is not the month's number). Daily numbers may be entered for today.
 */
export function resolvePeriod(raw: string, g: Granularity, todayIso: IsoDate): IsoDate {
  if (hasTimePart(raw)) {
    throw new ServiceError("validation", "Give the date without a time (YYYY-MM-DD)", { period: ["Date only, no time"] });
  }
  const p = parsePeriodInput(raw, g);
  if (!p) throw new ServiceError("validation", "Period not recognised (use e.g. 2026-10-31 or 2026-10)", { period: ["Not a date"] });
  const problem = periodProblem(p, g, todayIso);
  if (problem) throw new ServiceError("validation", problem, { period: [problem] });
  if (p < "2000-01-01") throw new ServiceError("validation", "That period is too far back", { period: ["Too old"] });
  return p;
}

export function resolveValue(raw: unknown, unit: string): number {
  const r = parseMetricInput(raw, unit);
  if ("error" in r) throw new ServiceError("validation", r.error, { value: [r.error] });
  return r.value;
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
      // Omitted = keep the note; null or "" = remove it.
      note: data.note === undefined ? undefined : data.note,
      now: ctx.now,
    }),
  );
  if (res.action === "conflict") throw new ServiceError("conflict", "Could not save the value");
  return { action: res.action, period, value };
}

/** Month totals exist only for daily numbers (weekly and monthly numbers have their own periods). */
function assertMonthTotalMetric(def: Pick<MetricView, "granularity" | "label">): void {
  if (def.granularity !== "day") {
    throw new ServiceError("validation", `${def.label} is not a daily number: enter its own periods instead of a month total`, {
      value: ["Month totals are for daily numbers only"],
    });
  }
}

/**
 * A month total (or month average for avg numbers, end-of-month value for last) of a DAILY
 * number, for AI roles that accept monthly totals when the days are incomplete. Stored as a
 * metric value with period_kind = month_total for the 1st of the month: latest wins per
 * metric + month, history kept, never part of the daily series or freshness. Completed months
 * only. A connector never writes these.
 */
export async function recordMonthTotal(
  ctx: ServiceContext,
  metricId: string,
  input: { month: string; value: unknown; note?: string | null },
): Promise<{ action: WriteAction; month: IsoDate; value: number }> {
  const metric = await getMetric(ctx, metricId);
  assertMonthTotalMetric(metric);
  const month = resolvePeriod(String(input.month ?? ""), "month", today(ctx));
  const value = resolveValue(input.value, metric.unit);
  const res = await ctx.db.transaction((tx) =>
    writeMetricValueTx(tx as unknown as Db, metric.id, month, value, {
      source: "manual",
      enteredBy: ctx.user.id,
      note: input.note === undefined ? undefined : input.note,
      now: ctx.now,
      periodKind: "month_total",
    }),
  );
  if (res.action === "conflict") throw new ServiceError("conflict", "Could not save the value");
  return { action: res.action, month, value };
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
  const valid: { metricId: string; period: IsoDate; value: number; periodKind: MetricPeriodKind }[] = [];
  for (const c of cells) {
    if (c.value === "") continue;
    const def = defs.get(c.metricId);
    if (!def) {
      result.errors.push({ metricId: c.metricId, period: c.period, message: "Metric not found in this company" });
      continue;
    }
    try {
      if (c.kind === "month_total") {
        assertMonthTotalMetric(def);
        valid.push({ metricId: def.id, period: resolvePeriod(c.period, "month", t), value: resolveValue(c.value, def.unit), periodKind: "month_total" });
        continue;
      }
      valid.push({ metricId: def.id, period: resolvePeriod(c.period, def.granularity, t), value: resolveValue(c.value, def.unit), periodKind: "period" });
    } catch (err) {
      if (!(err instanceof ServiceError)) throw err;
      result.errors.push({ metricId: c.metricId, period: c.period, message: `${def.label}: ${err.message}` });
    }
  }
  valid.sort(byMetricThenPeriod);
  await ctx.db.transaction(async (tx) => {
    for (const v of valid) {
      const r = await writeMetricValueTx(tx as unknown as Db, v.metricId, v.period, v.value, {
        source: "manual",
        enteredBy: ctx.user.id,
        now: ctx.now,
        periodKind: v.periodKind,
      });
      if (r.action !== "conflict") result[r.action]++;
    }
  });
  return result;
}

/** Current values for a set of metrics and periods (grid prefill, import preview). */
export async function currentValues(
  db: Db,
  metricIds: string[],
  periods?: { from: IsoDate; to: IsoDate },
  periodKind: MetricPeriodKind = "period",
): Promise<Map<string, number>> {
  if (metricIds.length === 0) return new Map();
  const rows = await db
    .select({ metricId: metricValues.metricId, period: metricValues.periodStart, value: metricValues.value })
    .from(metricValues)
    .where(
      and(
        inArray(metricValues.metricId, metricIds),
        eq(metricValues.isCurrent, true),
        eq(metricValues.periodKind, periodKind),
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

async function freshnessOfAll(ctx: ServiceContext): Promise<{ def: MetricView; freshness: Freshness; hasData: boolean }[]> {
  const defs = await loadDefinitions(ctx);
  const t = today(ctx);
  const inputs = await freshnessInputs(ctx.db, defs.map((d) => d.id), t);
  return defs.map((def) => ({ def, freshness: freshnessOf(def, inputs.get(def.id), t), hasData: inputs.has(def.id) }));
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
  /** The metric has at least one value (it is late, not just never started). */
  hasData: boolean;
  /**
   * Expected from a data source that is not set up yet (e.g. "Edil's APIs", "WB token"):
   * the short reason; null when the metric is entered by hand or its source is set up.
   */
  awaitingSource: string | null;
}

/**
 * Hook for the notification planner: metrics whose data is overdue for this user at
 * `ctx.now` (company data is shared, so both founders get the same list). Ordered by
 * company, then metric. Pure read; it never queues anything itself and never calls a
 * data source (whether a source is set up is read from its static setup, no network).
 */
export async function staleMetricsFor(ctx: ServiceContext, opts: { registry?: ConnectorRegistry } = {}): Promise<StaleMetric[]> {
  const registry = opts.registry ?? defaultRegistry();
  const out: StaleMetric[] = [];
  for (const { def, freshness, hasData } of await freshnessOfAll(ctx)) {
    if (freshness.status === "fresh" || !freshness.waitingFor || !freshness.dueOn) continue;
    const connector = def.sourceKind === "connector" && def.connectorId ? registry.get(def.connectorId) : undefined;
    const setup = connector?.setup();
    const awaitingSource =
      def.sourceKind === "connector" && (!setup || !setup.configured) ? (setup?.shortReason ?? "a data source") : null;
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
      hasData,
      awaitingSource,
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
