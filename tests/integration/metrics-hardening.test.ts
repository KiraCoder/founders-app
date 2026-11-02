/**
 * C4 review fixes: exact numbers (> 1M, xlsx % / decimals), granularity mismatch in uploads,
 * unfinished periods, gaps behind the latest value, concurrent writes, connector rules
 * (founder's value wins, aggregation, monthly range, running status, time limit, pages,
 * cached status), note clearing and date-only REST periods.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { defaultEntryPeriod } from "@/lib/metrics";
import { ConnectorRegistry } from "@/server/connectors/registry";
import { runConnector } from "@/server/connectors/runner";
import type { Connector, MetricPoint, PullOptions } from "@/server/connectors/types";
import type { Db } from "@/server/db/connect";
import { connectorRuns, metricValues } from "@/server/db/schema";
import { parseTableFile, type ParsedTable } from "@/server/import/parse-table";
import type { ServiceContext } from "@/server/services/context";
import { listConnectorStatuses } from "@/server/services/connectors";
import { toServiceError } from "@/server/services/errors";
import {
  listCompanyMetricCards,
  listMetricDefinitions,
  listMetricValues,
  recordMetricValue,
  saveMetricGrid,
  staleMetricsFor,
} from "@/server/services/metrics";
import { applyMetricsImport, planMetricsImport } from "@/server/services/metrics-import";
import { guessMapping, planImport } from "@/server/services/people-import";
import { createTestDb, type TestDb } from "../helpers/db";

const state = vi.hoisted(() => ({ ctx: null as ServiceContext | null }));
vi.mock("@/server/context", () => ({
  getApiContext: async () => state.ctx,
  getPageContext: async () => state.ctx,
}));
const { POST: postValueRoute } = await import("@/app/api/v1/metrics/[id]/values/route");

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.handle.close();
});
beforeEach(async () => {
  await t.handle.db.delete(metricValues);
  await t.handle.db.delete(connectorRuns);
});

const cid = (slug: string): string => t.companyIds[slug]!;
async function metricId(slug: string, key: string, unitSlug?: string): Promise<string> {
  const defs = await listMetricDefinitions(t.ctx("nuraaly"), cid(slug));
  const d = defs.find((x) => x.key === key && (x.unitSlug ?? undefined) === unitSlug);
  if (!d) throw new Error(`no metric ${slug}/${key}`);
  return d.id;
}
const table = (headers: string[], rows: string[][]): ParsedTable => ({ headers, rows, rowNumbers: rows.map((_, i) => i + 2), sha256: "t" });

async function xlsx(build: (ws: ExcelJS.Worksheet) => void): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  build(wb.addWorksheet("Numbers"));
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

describe("exact numbers", () => {
  it("values above 1M with 2 decimals are accepted and stored exactly (no float check rejects them)", async () => {
    const ctx = t.ctx("nuraaly");
    const cod = await metricId("kiwi-go", "cod_collected");
    // 1234567.89 * 10000 is 12345678899.999998 in floating point: must still be accepted.
    expect(await recordMetricValue(ctx, cod, { period: "2026-10-31", value: "1 234 567,89" })).toMatchObject({ value: 1234567.89 });
    expect(await recordMetricValue(ctx, cod, { period: "2026-10-30", value: 9999999.99 })).toMatchObject({ value: 9999999.99 });
    const rows = await t.handle.db.select({ v: metricValues.value }).from(metricValues).where(eq(metricValues.metricId, cod));
    expect(rows.map((r) => r.v).sort()).toEqual(["1234567.8900", "9999999.9900"]);
    // Sweep: every x.yz between 1M and 10M in a stride is accepted by the grid.
    const cells = [];
    for (let i = 0; i < 300; i++) {
      const v = (1_000_000 + i * 30_011.37).toFixed(2);
      cells.push({ metricId: cod, period: `2026-10-${String((i % 28) + 1).padStart(2, "0")}`, value: v });
    }
    const unique = [...new Map(cells.map((c) => [c.period, c])).values()];
    const res = await saveMetricGrid(ctx, cid("kiwi-go"), unique);
    expect(res.errors).toEqual([]);
  });

  it("ambiguous text, % in a non-% column and >4 decimals are refused with a clear message", async () => {
    const ctx = t.ctx("nuraaly");
    const orders = await metricId("kiwi-go", "orders_day");
    await expect(recordMetricValue(ctx, orders, { period: "2026-10-31", value: "85.000" })).rejects.toThrow(/ambiguous: 85 or 85000/);
    await expect(recordMetricValue(ctx, orders, { period: "2026-10-31", value: "12,345" })).rejects.toThrow(/ambiguous/);
    await expect(recordMetricValue(ctx, orders, { period: "2026-10-31", value: "12%" })).rejects.toThrow(/is a percentage/);
    const cod = await metricId("kiwi-go", "cod_collected");
    await expect(recordMetricValue(ctx, cod, { period: "2026-10-31", value: "1.23456" })).rejects.toThrow(/At most 4 decimals/);
    // Unambiguous forms still work.
    expect(await recordMetricValue(ctx, cod, { period: "2026-10-31", value: "1,234,567.5" })).toMatchObject({ value: 1234567.5 });
  });
});

describe(".xlsx upload keeps stored values", () => {
  it("percent formats are ×100, large numbers keep their decimals, a % cell in a KGS column is refused", async () => {
    const bytes = await xlsx((ws) => {
      ws.addRow(["Date", "On-time %", "COD collected", "Orders per day"]);
      const r1 = ws.addRow([new Date(Date.UTC(2026, 9, 30)), 0.955, 1234567.89, 120]);
      r1.getCell(2).numFmt = "0.0%";
      r1.getCell(3).numFmt = "#,##0.00";
      const r2 = ws.addRow([new Date(Date.UTC(2026, 9, 31)), 0.0125, 0.5, 130]);
      r2.getCell(2).numFmt = "0.00%";
      r2.getCell(3).numFmt = "0%"; // a percentage in a money column
    });
    const parsed = await parseTableFile(bytes, "numbers.xlsx");
    expect(parsed.rows[0]).toEqual(["2026-10-30", "95.5%", "1234567.89", "120"]);
    expect(parsed.numbers?.[0]?.[1]).toMatchObject({ value: 0.955, percent: true, shown: 95.5 });
    const plan = await planMetricsImport(t.ctx("nuraaly"), cid("kiwi-go"), parsed);
    const byCol = (col: string, row: number) => plan.cells.find((c) => c.column === col && c.row === row)!;
    expect(byCol("On-time %", 2)).toMatchObject({ value: 95.5, action: "create" });
    expect(byCol("On-time %", 3)).toMatchObject({ value: 1.25, action: "create" });
    expect(byCol("COD collected", 2)).toMatchObject({ value: 1234567.89, action: "create" });
    expect(byCol("COD collected", 3)).toMatchObject({ action: "error" });
    expect(byCol("COD collected", 3).error).toMatch(/is a percentage/);
    const done = await applyMetricsImport(t.ctx("nuraaly"), cid("kiwi-go"), parsed, { expectedSha256: parsed.sha256 });
    expect(done.applied).toBe(5);
    const pct = await listMetricValues(t.ctx("nuraaly"), await metricId("kiwi-go", "on_time_pct"));
    expect(pct.map((v) => [v.period, v.value])).toEqual([
      ["2026-10-31", 1.25],
      ["2026-10-30", 95.5],
    ]);
  });

  it("a date cell formatted as a month is a month label (refused for daily numbers)", async () => {
    const bytes = await xlsx((ws) => {
      ws.addRow(["Date", "Orders per day", "Revenue"]);
      const r = ws.addRow([new Date(Date.UTC(2026, 9, 1)), 500, 1_000_000]);
      r.getCell(1).numFmt = "mmm yyyy";
    });
    const parsed = await parseTableFile(bytes, "m.xlsx");
    expect(parsed.rows[0]![0]).toBe("2026-10");
    const plan = await planMetricsImport(t.ctx("nuraaly"), cid("kiwi-go"), parsed);
    expect(plan.cells.find((c) => c.column === "Orders per day")!.error).toMatch(/whole month.*daily number/);
    expect(plan.cells.find((c) => c.column === "Revenue")).toMatchObject({ action: "create", period: "2026-10-01" });
  });

  it("people import keeps salary amounts exact: 2 decimals ok, more refused (never rounded)", async () => {
    const bytes = await xlsx((ws) => {
      ws.addRow(["ФИО", "Компания", "Должность", "Оклад"]);
      ws.addRow(["Точный Человек", "Kiwi Go", "courier", 45000.5]);
      ws.addRow(["Лишний Знак", "Kiwi Go", "courier", 45000.555]);
      ws.addRow(["Крупный Оклад", "Kiwi Go", "courier", 1234567.89]);
    });
    const parsed = await parseTableFile(bytes, "people.xlsx");
    const ctx = t.ctx("nuraaly");
    const plan = await planImport(ctx, parsed, guessMapping(parsed.headers, { allowSalary: true }));
    expect(plan.rows[0]!.salary).toMatchObject({ amount: 45000.5 });
    expect(plan.rows[1]!.errors.join(" ")).toMatch(/more than 2 decimals/);
    expect(plan.rows[2]!.salary).toMatchObject({ amount: 1234567.89 });
  });
});

describe("upload granularity", () => {
  it("a month label in a daily column is refused; daily rows in a monthly column are ALL refused", async () => {
    const ctx = t.ctx("nuraaly");
    const plan = await planMetricsImport(
      ctx,
      cid("kiwi-go"),
      table(
        ["Date", "Orders per day", "Revenue"],
        [
          ["Oct 2026", "100", ""],
          ["2026-10-01", "", "30000"],
          ["2026-10-02", "", "31000"],
          ["2026-09-30", "", "900000"],
        ],
      ),
    );
    const errs = plan.cells.filter((c) => c.action === "error").map((c) => [c.row, c.error]);
    expect(errs).toEqual([
      [2, "“Oct 2026” is a whole month, but Orders per day is a daily number — give the date"],
      [3, "Rows 3, 4 are all in Oct 2026 — Revenue is a monthly number: one row per month with its total"],
      [4, "Rows 3, 4 are all in Oct 2026 — Revenue is a monthly number: one row per month with its total"],
    ]);
    // One row in September (a date inside the month) is that month's number.
    expect(plan.cells.find((c) => c.row === 5)).toMatchObject({ action: "create", period: "2026-09-01", value: 900000 });
  });

  it("the current month / week is refused in uploads too", async () => {
    const plan = await planMetricsImport(t.ctx("nuraaly"), cid("kiwi-go"), table(["Date", "Revenue"], [["2026-11-01", "5"]]));
    expect(plan.cells[0]).toMatchObject({ action: "error", error: "This month isn't finished yet" });
  });
});

describe("freshness: gaps behind the latest value", () => {
  it("a missing day inside the window is chased even when later days have values", async () => {
    const ctx = t.ctx("nuraaly");
    const orders = await metricId("kiwi-go", "orders_day");
    for (const d of ["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]) {
      await recordMetricValue(ctx, orders, { period: d, value: 10 });
    }
    const card = (await listCompanyMetricCards(ctx, cid("kiwi-go"))).find((c) => c.id === orders)!;
    expect(card.freshness).toMatchObject({ status: "stale", overduePeriods: 1, missingPeriods: ["2026-10-28"], waitingFor: "2026-10-28" });
    expect(defaultEntryPeriod({ granularity: "day", freshness: card.freshness, latestPeriod: card.latest!.period }, "2026-11-02")).toBe("2026-10-28");
    expect((await staleMetricsFor(ctx)).find((s) => s.metricId === orders)).toMatchObject({ waitingFor: "2026-10-28", hasData: true });
    await recordMetricValue(ctx, orders, { period: "2026-10-28", value: 10 });
    const after = (await listCompanyMetricCards(ctx, cid("kiwi-go"))).find((c) => c.id === orders)!;
    expect(after.freshness.status).toBe("fresh");
  });

  it("today's daily value is 'in progress': never compared with yesterday", async () => {
    const ctx = t.ctx("nuraaly");
    const orders = await metricId("kiwi-go", "orders_day");
    await recordMetricValue(ctx, orders, { period: "2026-11-01", value: 100 });
    await recordMetricValue(ctx, orders, { period: "2026-11-02", value: 10 });
    const card = (await listCompanyMetricCards(ctx, cid("kiwi-go"))).find((c) => c.id === orders)!;
    expect(card.latest).toMatchObject({ period: "2026-11-02", inProgress: true });
    expect(card.change).toBeNull();
  });
});

describe("concurrent writes", () => {
  it("two grid saves touching the same metrics in opposite order both finish; one current value per period", async () => {
    const ctx = t.ctx("nuraaly");
    const a = await metricId("kiwi-go", "orders_day");
    const b = await metricId("kiwi-go", "couriers_active");
    const [r1, r2] = await Promise.all([
      saveMetricGrid(ctx, cid("kiwi-go"), [
        { metricId: a, period: "2026-10-31", value: "1" },
        { metricId: b, period: "2026-10-31", value: "1" },
      ]),
      saveMetricGrid(t.ctx("talant"), cid("kiwi-go"), [
        { metricId: b, period: "2026-10-31", value: "2" },
        { metricId: a, period: "2026-10-31", value: "2" },
      ]),
    ]);
    expect(r1.errors).toEqual([]);
    expect(r2.errors).toEqual([]);
    for (const id of [a, b]) {
      const current = await listMetricValues(ctx, id);
      expect(current).toHaveLength(1);
    }
    const many = await Promise.all([3, 4, 5, 6].map((v) => recordMetricValue(ctx, a, { period: "2026-10-30", value: v })));
    expect(many.filter((m) => m.action === "created")).toHaveLength(1);
    expect((await listMetricValues(ctx, a)).filter((v) => v.period === "2026-10-30")).toHaveLength(1);
  });

  it("a deadlock or serialization failure becomes a 'try again' conflict", () => {
    expect(toServiceError(Object.assign(new Error("deadlock detected"), { code: "40P01" }))).toMatchObject({ code: "conflict" });
    expect(toServiceError({ message: "wrapped", cause: { code: "40001" } })).toMatchObject({ code: "conflict" });
  });
});

describe("notes and REST dates", () => {
  it("a note can be cleared; omitting it keeps it", async () => {
    const ctx = t.ctx("nuraaly");
    const orders = await metricId("kiwi-go", "orders_day");
    await recordMetricValue(ctx, orders, { period: "2026-10-31", value: 5, note: "estimate" });
    expect(await recordMetricValue(ctx, orders, { period: "2026-10-31", value: 5 })).toMatchObject({ action: "unchanged" });
    expect((await listMetricValues(ctx, orders))[0]!.note).toBe("estimate");
    expect(await recordMetricValue(ctx, orders, { period: "2026-10-31", value: 5, note: null })).toMatchObject({ action: "updated" });
    expect((await listMetricValues(ctx, orders))[0]!.note).toBeNull();
  });

  it("REST refuses timestamps (the day depends on the time zone)", async () => {
    state.ctx = t.ctx("nuraaly");
    const orders = await metricId("kiwi-go", "orders_day");
    const res = await postValueRoute(
      new NextRequest(`http://localhost/api/v1/metrics/${orders}/values`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ period: "2026-10-30T20:00:00Z", value: 3 }),
      }),
      { params: Promise.resolve({ id: orders }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/without a time/);
  });
});

describe("connector rules", () => {
  const setup = () => ({ configured: true, message: "ok", shortReason: "fake", envVars: [], missingEnv: [] });
  function fake(pull: Connector["pull"], extra: Partial<Connector> = {}): Connector {
    return {
      id: "fake",
      name: "Fake source",
      companySlug: "kiwi-go",
      metrics: [{ key: "orders_day" }, { key: "on_time_pct" }, { key: "revenue" }],
      setup,
      healthCheck: async () => ({ state: "ok", message: "ok", envVars: [], missingEnv: [] }),
      pull,
      ...extra,
    };
  }
  const run = (c: Connector, range = { from: "2026-10-26", to: "2026-11-01" }, timeoutMs?: number) =>
    runConnector(t.handle.db as Db, c.id, range, { registry: new ConnectorRegistry([c]), now: t.ctx("nuraaly").now, timeoutMs });

  it("never overwrites a value entered by hand: records a conflict, the card says 'source disagrees'", async () => {
    const ctx = t.ctx("nuraaly");
    const orders = await metricId("kiwi-go", "orders_day");
    await recordMetricValue(ctx, orders, { period: "2026-10-31", value: 120 });
    await recordMetricValue(ctx, orders, { period: "2026-10-30", value: 77 });
    const res = await run(
      fake(async () => [
        { metricKey: "orders_day", periodStart: "2026-10-31", value: 130 },
        { metricKey: "orders_day", periodStart: "2026-10-30", value: 77 },
        { metricKey: "orders_day", periodStart: "2026-10-29", value: 50 },
      ]),
    );
    expect(res).toMatchObject({ status: "ok", valuesWritten: 1, conflicts: 1 });
    const values = await listMetricValues(ctx, orders);
    expect(values.map((v) => [v.period, v.value, v.source])).toEqual([
      ["2026-10-31", 120, "manual"],
      ["2026-10-30", 77, "manual"],
      ["2026-10-29", 50, "connector"],
    ]);
    const [row] = await t.handle.db.select().from(connectorRuns).where(eq(connectorRuns.id, res.runId!));
    expect(row!.details?.conflicts).toEqual([{ metricId: orders, period: "2026-10-31", kept: 120, keptSource: "manual", reported: 130 }]);
    const card = (await listCompanyMetricCards(ctx, cid("kiwi-go"))).find((c) => c.id === orders)!;
    expect(card.disagreements).toMatchObject([{ period: "2026-10-31", kept: 120, reported: 130, connectorId: "fake" }]);
    // The founder corrects to the source's number: no longer a disagreement.
    await recordMetricValue(ctx, orders, { period: "2026-10-31", value: 130 });
    expect((await listCompanyMetricCards(ctx, cid("kiwi-go"))).find((c) => c.id === orders)!.disagreements).toEqual([]);
  });

  it("daily points fill weekly / monthly metrics by aggregation, only for complete, fully received periods", async () => {
    // Defect rate (Alura Style) is weekly %, avg; use a fake for that company.
    const c = fake(
      async () => {
        const pts: MetricPoint[] = [];
        for (let d = 19; d <= 25; d++) pts.push({ metricKey: "defect_pct", unitSlug: "hbk", periodStart: `2026-10-${d}`, value: d === 19 ? 3 : 2 });
        // Week of 26 Oct: only 6 of 7 days → skipped.
        for (let d = 26; d <= 31; d++) pts.push({ metricKey: "defect_pct", unitSlug: "hbk", periodStart: `2026-10-${d}`, value: 2 });
        // Piecework (monthly, sum): October complete, every day.
        for (let d = 1; d <= 31; d++) pts.push({ metricKey: "piecework_total", unitSlug: "hbk", periodStart: `2026-10-${String(d).padStart(2, "0")}`, value: 1000.1 });
        return pts;
      },
      { companySlug: "alura-style", metrics: [{ key: "defect_pct", unitSlug: "hbk" }, { key: "piecework_total", unitSlug: "hbk" }] },
    );
    const res = await run(c, { from: "2026-09-28", to: "2026-11-01" });
    expect(res).toMatchObject({ status: "ok", valuesWritten: 2 });
    const defect = await listMetricValues(t.ctx("nuraaly"), await metricId("alura-style", "defect_pct", "hbk"));
    expect(defect.map((v) => [v.period, v.value])).toEqual([["2026-10-19", 2.1429]]);
    const piece = await listMetricValues(t.ctx("nuraaly"), await metricId("alura-style", "piecework_total", "hbk"));
    expect(piece.map((v) => [v.period, v.value])).toEqual([["2026-10-01", 31003.1]]);
    const [row] = await t.handle.db.select().from(connectorRuns).where(eq(connectorRuns.id, res.runId!));
    expect(row!.details?.skippedReasons?.join(" | ")).toMatch(/6 of 7 days received/);
  });

  it("a monthly point labelled with the 1st is kept although the range starts mid-month; the current month is refused", async () => {
    const res = await run(
      fake(async () => [
        { metricKey: "revenue", periodStart: "2026-10-01", value: 5_000_000, granularity: "month" },
        { metricKey: "revenue", periodStart: "2026-11-01", value: 1, granularity: "month" },
      ]),
    );
    expect(res).toMatchObject({ valuesWritten: 1, skipped: 1 });
    expect((await listMetricValues(t.ctx("nuraaly"), await metricId("kiwi-go", "revenue"))).map((v) => v.value)).toEqual([5_000_000]);
  });

  it("the run is 'running' while pulling and finalised after; pages are followed; a slow pull times out", async () => {
    const seen: string[] = [];
    const paged = fake(async (_range, opts: PullOptions) => {
      const [r] = await t.handle.db.select({ status: connectorRuns.status }).from(connectorRuns);
      seen.push(r!.status);
      if (!opts.cursor) return { points: [{ metricKey: "orders_day", periodStart: "2026-10-30", value: 1 }], nextCursor: "p2" };
      return { points: [{ metricKey: "orders_day", periodStart: "2026-10-31", value: 2 }], nextCursor: null };
    });
    const res = await run(paged);
    expect(seen).toEqual(["running", "running"]);
    expect(res).toMatchObject({ status: "ok", pointsReceived: 2, valuesWritten: 2 });
    const [row] = await t.handle.db.select().from(connectorRuns).where(eq(connectorRuns.id, res.runId!));
    expect(row).toMatchObject({ status: "ok" });
    expect(row!.finishedAt).not.toBeNull();

    let aborted = false;
    const slow = fake(
      (_r, opts) =>
        new Promise(() => {
          opts.signal.addEventListener("abort", () => (aborted = true));
        }),
    );
    const timedOut = await run(slow, undefined, 50);
    expect(timedOut).toMatchObject({ status: "error", message: "Pull failed: Pull timed out" });
    expect(aborted).toBe(true);
  });

  it("pages never call healthCheck: the status comes from the static setup and the last run", async () => {
    const health = vi.fn(async () => ({ state: "ok" as const, message: "ok", envVars: [], missingEnv: [] }));
    const c = fake(async () => [], { healthCheck: health });
    const registry = new ConnectorRegistry([c]);
    const before = await listConnectorStatuses(t.ctx("nuraaly"), { registry });
    expect(before[0]).toMatchObject({ health: { state: "unknown", message: "Not checked yet" }, lastRun: null });
    expect(health).not.toHaveBeenCalled();
    await run(c);
    expect(health).toHaveBeenCalledTimes(1);
    const after = await listConnectorStatuses(t.ctx("nuraaly"), { registry });
    expect(after[0]).toMatchObject({ health: { state: "ok" }, lastRun: { status: "ok" } });
    expect(health).toHaveBeenCalledTimes(1);
  });
});
