import "server-only";
import type { IsoDate } from "@/lib/dates";
import { type Granularity, DATE_HEADERS, metricValueProblem, normalizeHeader, parseMetricNumber, parsePeriodInput, periodStart } from "@/lib/metrics";
import type { Db } from "@/server/db/connect";
import type { ParsedTable } from "@/server/import/parse-table";
import { today, type ServiceContext } from "./context";
import { ServiceError } from "./errors";
import { currentValues, listMetricDefinitions, writeMetricValueTx, type MetricView } from "./metrics";

/**
 * Upload of numbers for ONE company (`/companies/[slug]/numbers/import`).
 *
 * File shape: one date column (Дата / Date / Месяц / Period …) and one column per metric.
 * Headers are matched to this company's metrics only (name, key or alias, Russian or
 * English; factory metrics need the factory in the header, e.g. "Выпуск ХБК"), so a file
 * can never write numbers into another company. Each date is turned into the metric's
 * period (a date in October → October for a monthly metric).
 *
 * Flow like the people import: parse (parse-table.ts) → `planMetricsImport` (preview:
 * create / update / unchanged / error per cell) → `applyMetricsImport` (re-plans in a
 * transaction and writes). Re-importing the same file changes nothing.
 */

export type CellAction = "create" | "update" | "unchanged" | "error";

export interface MetricImportCell {
  row: number;
  column: string;
  metricId: string | null;
  metricLabel: string;
  period: IsoDate | null;
  value: number | null;
  current: number | null;
  unit: string | null;
  granularity: Granularity | null;
  action: CellAction;
  error?: string;
}

export interface MetricImportColumn {
  index: number;
  header: string;
  metricId: string | null;
  metricLabel: string | null;
  /** Why a column is not used (unknown header, duplicate, ambiguous). */
  note?: string;
}

export interface MetricImportPlan {
  dateColumn: string;
  columns: MetricImportColumn[];
  cells: MetricImportCell[];
  counts: Record<CellAction, number>;
}

function candidates(def: MetricView): string[] {
  return [def.key, def.name, ...def.aliases].map(normalizeHeader).filter(Boolean);
}

/** Which metric (if any) a header means, among this company's metrics. */
export function matchHeader(header: string, defs: MetricView[]): { metric?: MetricView; note?: string } {
  const h = normalizeHeader(header);
  if (!h) return { note: "Empty header" };
  const hits = defs.filter((d) => {
    const bases = candidates(d);
    if (!d.unitName) return bases.includes(h);
    // The factory may be written by name ("ХБК") or slug ("hbk", "osh-rayon").
    const unitTokens = [d.unitName, d.unitSlug ?? ""].map(normalizeHeader).filter(Boolean);
    return unitTokens.some((t) => {
      const re = new RegExp(`(^|\\s)${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|\\s)`);
      if (!re.test(h)) return false;
      const rest = h.replace(re, " ").replace(/\s+/g, " ").trim();
      return bases.includes(rest);
    });
  });
  if (hits.length === 1) return { metric: hits[0] };
  if (hits.length > 1) return { note: `Matches several metrics (${hits.map((d) => d.label).join(", ")})` };
  return { note: "Not a metric of this company — ignored" };
}

function findDateColumn(table: ParsedTable): number {
  const byName = table.headers.findIndex((h) => DATE_HEADERS.includes(normalizeHeader(h)));
  if (byName >= 0) return byName;
  const first = table.rows.slice(0, 5).map((r) => r[0] ?? "").filter(Boolean);
  if (first.length > 0 && first.every((v) => parsePeriodInput(v, "day") !== null)) return 0;
  return -1;
}

async function buildPlan(ctx: ServiceContext, companyId: string, table: ParsedTable): Promise<MetricImportPlan> {
  const defs = await listMetricDefinitions(ctx, companyId);
  if (defs.length === 0) throw new ServiceError("validation", "This company has no metrics to import yet.");
  const dateIdx = findDateColumn(table);
  if (dateIdx < 0) {
    throw new ServiceError("validation", "No date column found. Name the first column “Date” (or Дата / Месяц).", {
      file: ["No date column"],
    });
  }

  const columns: MetricImportColumn[] = [];
  const used = new Map<string, string>();
  table.headers.forEach((header, index) => {
    if (index === dateIdx) return;
    if (!header.trim() && table.rows.every((r) => !(r[index] ?? "").trim())) return;
    const { metric, note } = matchHeader(header, defs);
    if (metric && used.has(metric.id)) {
      columns.push({ index, header, metricId: null, metricLabel: null, note: `Same metric as column “${used.get(metric.id)}” — ignored` });
      return;
    }
    if (metric) used.set(metric.id, header);
    columns.push({ index, header, metricId: metric?.id ?? null, metricLabel: metric?.label ?? null, note });
  });
  const mapped = columns.filter((c) => c.metricId);
  if (mapped.length === 0) {
    throw new ServiceError(
      "validation",
      `No column matches a metric of this company. Expected headers like: ${defs
        .slice(0, 4)
        .map((d) => `“${d.label.replace(" · ", " ")}”`)
        .join(", ")}.`,
    );
  }
  const defById = new Map(defs.map((d) => [d.id, d]));
  const t = today(ctx);
  const current = await currentValues(ctx.db, mapped.map((c) => c.metricId!));

  const cells: MetricImportCell[] = [];
  const seen = new Map<string, number>();
  table.rows.forEach((r, i) => {
    const rowNo = table.rowNumbers[i] ?? i + 2;
    const rawDate = (r[dateIdx] ?? "").trim();
    const filled = mapped.filter((c) => (r[c.index] ?? "").trim() !== "");
    if (filled.length === 0) return;
    const base = { row: rowNo, column: table.headers[dateIdx] ?? "Date", metricId: null, metricLabel: "—", period: null, value: null, current: null, unit: null, granularity: null };
    if (!parsePeriodInput(rawDate, "day") && !parsePeriodInput(rawDate, "month")) {
      cells.push({ ...base, action: "error", error: rawDate ? `Date not recognised: “${rawDate}”` : "Date is empty" });
      return;
    }
    for (const c of filled) {
      const def = defById.get(c.metricId!)!;
      const period = parsePeriodInput(rawDate, def.granularity)!;
      const raw = (r[c.index] ?? "").trim();
      const value = parseMetricNumber(raw);
      const cell: MetricImportCell = {
        row: rowNo,
        column: c.header,
        metricId: def.id,
        metricLabel: def.label,
        period,
        value: Number.isFinite(value) ? value : null,
        current: current.get(`${def.id}|${period}`) ?? null,
        unit: def.unit,
        granularity: def.granularity,
        action: "create",
      };
      const problem = metricValueProblem(value, def.unit);
      const key = `${def.id}|${period}`;
      if (problem) {
        cell.action = "error";
        cell.error = Number.isFinite(value) ? problem : `Not a number: “${raw}”`;
      } else if (period > periodStart(t, def.granularity)) {
        cell.action = "error";
        cell.error = "Period is in the future";
      } else if (seen.has(key)) {
        cell.action = "error";
        cell.error = `Same period as row ${seen.get(key)}`;
      } else {
        seen.set(key, rowNo);
        cell.action = cell.current === null ? "create" : Math.abs(cell.current - value) < 1e-9 ? "unchanged" : "update";
      }
      cells.push(cell);
    }
  });
  if (cells.length === 0) throw new ServiceError("validation", "The file has no numbers in the metric columns.");
  const counts: Record<CellAction, number> = { create: 0, update: 0, unchanged: 0, error: 0 };
  for (const c of cells) counts[c.action]++;
  return { dateColumn: table.headers[dateIdx] ?? "Date", columns, cells, counts };
}

/** Preview. Writes nothing. */
export async function planMetricsImport(ctx: ServiceContext, companyId: string, table: ParsedTable): Promise<MetricImportPlan> {
  return buildPlan(ctx, companyId, table);
}

/** Re-plans inside one transaction and writes the create/update cells (source = upload). */
export async function applyMetricsImport(
  ctx: ServiceContext,
  companyId: string,
  table: ParsedTable,
): Promise<MetricImportPlan & { applied: number }> {
  return ctx.db.transaction(async (rawTx) => {
    const tx: ServiceContext = { ...ctx, db: rawTx as unknown as Db };
    const plan = await buildPlan(tx, companyId, table);
    let applied = 0;
    for (const c of plan.cells) {
      if ((c.action !== "create" && c.action !== "update") || !c.metricId || !c.period || c.value === null) continue;
      const r = await writeMetricValueTx(tx.db, c.metricId, c.period, c.value, {
        source: "upload",
        enteredBy: ctx.user.id,
        now: ctx.now,
      });
      if (r.action !== "unchanged") applied++;
    }
    return { ...plan, applied };
  });
}
