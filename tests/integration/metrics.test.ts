import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import type { SessionUser } from "@/server/auth/types";
import { ConnectorRegistry } from "@/server/connectors/registry";
import { runConnector } from "@/server/connectors/runner";
import { STUB_SPECS, stubConnectors } from "@/server/connectors/stubs";
import type { Connector, MetricPoint } from "@/server/connectors/types";
import { connectorRuns, metricDefinitions, metricValues, notificationsOutbox } from "@/server/db/schema";
import { seed } from "@/server/db/seed";
import type { ParsedTable } from "@/server/import/parse-table";
import { parseTableFile } from "@/server/import/parse-table";
import type { ChannelRegistry } from "@/server/notifications/channels";
import { dispatch } from "@/server/notifications/dispatcher";
import { planTick } from "@/server/notifications/planner";
import type { NeutralMessage, NotificationChannel } from "@/server/notifications/types";
import type { ServiceContext } from "@/server/services/context";
import { checkConnector, listConnectorStatuses } from "@/server/services/connectors";
import {
  companyFreshness,
  getMetric,
  listCompanyMetricCards,
  listMetricDefinitions,
  listMetricValues,
  recordMetricValue,
  saveMetricGrid,
  staleMetricsFor,
} from "@/server/services/metrics";
import { applyMetricsImport, planMetricsImport } from "@/server/services/metrics-import";
import { createTestDb, FIXED_NOW, type TestDb } from "../helpers/db";
import { readFileSync } from "node:fs";

const state = vi.hoisted(() => ({ ctx: null as ServiceContext | null }));
vi.mock("@/server/context", () => ({
  getApiContext: async () => state.ctx,
  getPageContext: async () => state.ctx,
}));
const { GET: companyMetricsRoute } = await import("@/app/api/v1/companies/[slug]/metrics/route");
const { GET: valuesRoute, POST: postValueRoute } = await import("@/app/api/v1/metrics/[id]/values/route");

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
afterEach(() => {
  vi.unstubAllGlobals();
});

const staff: SessionUser = { id: "00000000-0000-4000-8000-0000000000aa", email: "staff@example.test", name: "Staff", shortName: "Staff", role: "staff" };
const staffCtx = (): ServiceContext => ({ ...t.ctx("nuraaly"), user: staff });

async function metricId(slug: string, key: string, unitSlug?: string): Promise<string> {
  const defs = await listMetricDefinitions(t.ctx("nuraaly"), t.companyIds[slug]);
  const d = defs.find((x) => x.key === key && (x.unitSlug ?? undefined) === unitSlug);
  if (!d) throw new Error(`no metric ${slug}/${key}/${unitSlug}`);
  return d.id;
}

const cid = (slug: string): string => t.companyIds[slug]!;
const table = (headers: string[], rows: string[][]): ParsedTable => ({ headers, rows, rowNumbers: rows.map((_, i) => i + 2), sha256: "test-table" });

describe("seeded definitions", () => {
  it("each company gets its metrics from kpis.ts; Alura Style per factory; Marketing none; re-seed adds nothing", async () => {
    const ctx = t.ctx("nuraaly");
    const kiwi = await listMetricDefinitions(ctx, cid("kiwi-go"));
    expect(kiwi.map((d) => d.key)).toEqual(["orders_day", "on_time_pct", "cod_collected", "cod_paid_out", "revenue", "couriers_active"]);
    expect(kiwi.find((d) => d.key === "on_time_pct")).toMatchObject({ unit: "%", target: 95, granularity: "day", dueDays: 1 });
    const style = await listMetricDefinitions(ctx, cid("alura-style"));
    expect(style.filter((d) => d.key === "output_pcs").map((d) => d.label)).toEqual(["Output per day · ХБК", "Output per day · Ош Район"]);
    expect(await listMetricDefinitions(ctx, cid("marketing"))).toEqual([]);
    const before = (await t.handle.db.select().from(metricDefinitions)).length;
    await seed(t.handle.db, { password: "test-password", bcryptRounds: 4, now: FIXED_NOW, timeZone: "Asia/Bishkek" });
    expect((await t.handle.db.select().from(metricDefinitions)).length).toBe(before);
  });
});

describe("values: correction keeps history, latest wins", () => {
  it("records, corrects and reports change vs previous", async () => {
    const ctx = t.ctx("nuraaly");
    const id = await metricId("kiwi-go", "orders_day");
    expect(await recordMetricValue(ctx, id, { period: "2026-10-31", value: "120" })).toMatchObject({ action: "created", period: "2026-10-31" });
    expect(await recordMetricValue(ctx, id, { period: "2026-11-01", value: 140 })).toMatchObject({ action: "created" });
    // Correction by Talant: the old row is kept, the new one is current.
    expect(await recordMetricValue(t.ctx("talant"), id, { period: "2026-11-01", value: "150", note: "recount" })).toMatchObject({ action: "updated" });
    // Same value again → unchanged, nothing written.
    expect(await recordMetricValue(ctx, id, { period: "2026-11-01", value: "150" })).toMatchObject({ action: "unchanged" });

    const history = await listMetricValues(ctx, id, { includeHistory: true });
    expect(history.map((h) => [h.period, h.value, h.isCurrent])).toEqual([
      ["2026-11-01", 150, true],
      ["2026-11-01", 140, false],
      ["2026-10-31", 120, true],
    ]);
    expect(history[0]).toMatchObject({ enteredByName: "Talant", note: "recount", source: "manual" });
    expect((await listMetricValues(ctx, id)).length).toBe(2);

    const card = (await listCompanyMetricCards(ctx, cid("kiwi-go"))).find((c) => c.id === id)!;
    expect(card.latest).toMatchObject({ period: "2026-11-01", value: 150, enteredByName: "Talant", enteredDay: "2026-11-02" });
    expect(card.change).toMatchObject({ previous: 120, delta: 30, tone: "good" });
    expect(card.freshness.status).toBe("fresh");
    expect(card.series).toHaveLength(12);
    expect(card.series.at(-1)).toEqual({ period: "2026-11-02", value: null });
    expect(card.series.at(-2)).toEqual({ period: "2026-11-01", value: 150 });
  });

  it("rejects future periods, bad numbers and out-of-range percentages", async () => {
    const ctx = t.ctx("nuraaly");
    const pct = await metricId("kiwi-go", "on_time_pct");
    await expect(recordMetricValue(ctx, pct, { period: "2026-11-03", value: 90 })).rejects.toMatchObject({ code: "validation" });
    await expect(recordMetricValue(ctx, pct, { period: "2026-11-01", value: "101" })).rejects.toMatchObject({ code: "validation" });
    await expect(recordMetricValue(ctx, pct, { period: "2026-11-01", value: "abc" })).rejects.toMatchObject({ code: "validation" });
    await expect(recordMetricValue(ctx, pct, { period: "soon", value: 1 })).rejects.toMatchObject({ code: "validation" });
    // A monthly metric takes "2026-10" and any day in October.
    const revenue = await metricId("kiwi-go", "revenue");
    expect(await recordMetricValue(ctx, revenue, { period: "2026-10-17", value: "1 250 000" })).toMatchObject({ period: "2026-10-01", value: 1250000 });
    // The current month / week is not finished: refused (a month-to-date total is not the month's number).
    await expect(recordMetricValue(ctx, revenue, { period: "2026-11", value: 1 })).rejects.toThrow("This month isn't finished yet");
    const defect = await metricId("alura-style", "defect_pct", "hbk");
    await expect(recordMetricValue(ctx, defect, { period: "2026-11-02", value: 1 })).rejects.toThrow("This week isn't finished yet");
    expect(await recordMetricValue(ctx, defect, { period: "2026-11-01", value: 1 })).toMatchObject({ period: "2026-10-26" });
    // Daily numbers may be entered for today.
    expect(await recordMetricValue(ctx, pct, { period: "2026-11-02", value: 90 })).toMatchObject({ period: "2026-11-02" });
  });

  it("grid saves changed cells in one go and reports errors per cell", async () => {
    const ctx = t.ctx("nuraaly");
    const revenue = await metricId("kiwi-go", "revenue");
    const res = await saveMetricGrid(ctx, cid("kiwi-go"), [
      { metricId: revenue, period: "2026-09-01", value: "900000" },
      { metricId: revenue, period: "2026-10-01", value: "950 000" },
      { metricId: revenue, period: "2026-08-01", value: "" },
      { metricId: revenue, period: "2026-12-01", value: "1" },
      { metricId: revenue, period: "2026-11-01", value: "1" },
      { metricId: await metricId("alura-style", "output_pcs", "hbk"), period: "2026-11-01", value: "5" },
    ]);
    expect(res).toMatchObject({ created: 2, updated: 0, unchanged: 0 });
    expect(res.errors.map((e) => e.message)).toEqual([
      "Revenue: That period is in the future",
      "Revenue: This month isn't finished yet",
      "Metric not found in this company",
    ]);
    const again = await saveMetricGrid(ctx, cid("kiwi-go"), [{ metricId: revenue, period: "2026-10-01", value: "950000" }]);
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
  });
});

describe("company isolation", () => {
  it("staff (no company access yet) sees no metrics, cannot read or write values", async () => {
    const id = await metricId("kiwi-go", "orders_day");
    await recordMetricValue(t.ctx("nuraaly"), id, { period: "2026-11-01", value: 10 });
    const s = staffCtx();
    await expect(getMetric(s, id)).rejects.toMatchObject({ code: "not_found" });
    await expect(listMetricValues(s, id)).rejects.toMatchObject({ code: "not_found" });
    await expect(recordMetricValue(s, id, { period: "2026-11-01", value: 99 })).rejects.toMatchObject({ code: "not_found" });
    await expect(listCompanyMetricCards(s, cid("kiwi-go"))).rejects.toMatchObject({ code: "not_found" });
    expect(await staleMetricsFor(s)).toEqual([]);
    expect(await companyFreshness(s)).toEqual([]);
    expect(await listConnectorStatuses(s)).toEqual([]);
    await expect(planMetricsImport(s, cid("kiwi-go"), table(["Date", "Orders per day"], [["2026-11-01", "5"]]))).rejects.toMatchObject({
      code: "not_found",
    });
    // A malformed id is "not found", not a 500.
    await expect(getMetric(t.ctx("nuraaly"), "nope")).rejects.toMatchObject({ code: "not_found" });
  });

  it("an upload for one company never writes another company's metric", async () => {
    const ctx = t.ctx("nuraaly");
    const plan = await planMetricsImport(
      ctx,
      cid("kiwi-go"),
      table(["Дата", "Заказы в день", "Выпуск ХБК", "Wildberries sales"], [["2026-11-01", "7", "300", "1000"]]),
    );
    expect(plan.columns.map((c) => [c.header, c.metricLabel])).toEqual([
      ["Заказы в день", "Orders per day"],
      ["Выпуск ХБК", null],
      ["Wildberries sales", null],
    ]);
    expect(plan.cells.map((c) => c.metricLabel)).toEqual(["Orders per day"]);
  });

  it("archived metrics are hidden", async () => {
    const id = await metricId("jobutify", "wms_shipment_errors");
    await t.handle.db.update(metricDefinitions).set({ archivedAt: FIXED_NOW }).where(eq(metricDefinitions.id, id));
    await expect(getMetric(t.ctx("nuraaly"), id)).rejects.toMatchObject({ code: "not_found" });
    await t.handle.db.update(metricDefinitions).set({ archivedAt: null }).where(eq(metricDefinitions.id, id));
  });
});

describe("upload: preview then confirm, idempotent", () => {
  const file = table(
    ["Дата", "Выпуск ХБК", "Выпуск Ош Район", "Брак % ХБК", "Сдельная оплата ХБК", "Unknown column"],
    [
      ["30.10.2026", "410", "380", "1,8", "", "x"],
      ["31.10.2026", "425", "390", "", "1 200 000", ""],
      ["2026-11-01", "abc", "", "", "", ""],
      ["31.10.2026", "999", "", "", "", ""],
      ["soon", "1", "", "", "", ""],
      ["2026-11-05", "1", "", "", "", ""],
    ],
  );

  it("preview shows create / update / unchanged / errors", async () => {
    const ctx = t.ctx("nuraaly");
    const company = cid("alura-style");
    await recordMetricValue(ctx, await metricId("alura-style", "output_pcs", "osh-rayon"), { period: "2026-10-30", value: 380 });
    await recordMetricValue(ctx, await metricId("alura-style", "output_pcs", "hbk"), { period: "2026-10-31", value: 400 });

    const plan = await planMetricsImport(ctx, company, file);
    expect(plan.dateColumn).toBe("Дата");
    expect(plan.columns.find((c) => c.header === "Unknown column")?.metricId).toBeNull();
    expect(plan.columns.find((c) => c.header === "Брак % ХБК")?.metricLabel).toBe("Defect rate · ХБК");
    expect(plan.counts).toEqual({ create: 4, update: 0, unchanged: 1, error: 5 });
    const errs = plan.cells.filter((c) => c.action === "error").map((c) => c.error);
    // Two rows for the same day: BOTH are refused (the first one is not silently kept).
    expect(errs).toEqual([
      "Rows 3, 5 are the same day twice",
      "Not a number: “abc”",
      "Rows 3, 5 are the same day twice",
      "Date not recognised: “soon”",
      "That period is in the future",
    ]);
    // Defect rate is weekly: 30 Oct → the week of 26 Oct. Piecework is monthly: October.
    expect(plan.cells.find((c) => c.metricLabel === "Defect rate · ХБК")).toMatchObject({ period: "2026-10-26", value: 1.8 });
    expect(plan.cells.find((c) => c.metricLabel === "Piecework pay total · ХБК")).toMatchObject({ period: "2026-10-01", value: 1200000 });
    // Preview writes nothing.
    expect((await listMetricValues(ctx, await metricId("alura-style", "defect_pct", "hbk"))).length).toBe(0);

    const applied = await applyMetricsImport(ctx, company, file, { expectedSha256: file.sha256 });
    expect(applied.applied).toBe(4);
    const hbk = await listMetricValues(ctx, await metricId("alura-style", "output_pcs", "hbk"), { includeHistory: true });
    expect(hbk.map((h) => [h.period, h.value, h.isCurrent, h.source])).toEqual([
      ["2026-10-31", 400, true, "manual"],
      ["2026-10-30", 410, true, "upload"],
    ]);

    // Same file again: nothing to do.
    const second = await planMetricsImport(ctx, company, file);
    expect(second.counts).toMatchObject({ create: 0, update: 0, unchanged: 5 });
    expect((await applyMetricsImport(ctx, company, file, { expectedSha256: file.sha256 })).applied).toBe(0);
    expect((await listMetricValues(ctx, await metricId("alura-style", "output_pcs", "hbk"), { includeHistory: true })).length).toBe(2);
  });

  it("the sample file in docs/samples parses and matches every column", async () => {
    const bytes = new Uint8Array(readFileSync("docs/samples/kiwi-go-numbers-sample.csv"));
    const parsed = await parseTableFile(bytes, "kiwi-go-numbers-sample.csv");
    const plan = await planMetricsImport(t.ctx("nuraaly"), cid("kiwi-go"), parsed);
    expect(plan.columns.every((c) => c.metricId)).toBe(true);
    expect(plan.counts.error).toBe(0);
    expect(plan.counts.create).toBeGreaterThan(20);
  });

  it("a file without a date column or without metric columns is refused with a clear message", async () => {
    const ctx = t.ctx("nuraaly");
    await expect(planMetricsImport(ctx, cid("kiwi-go"), table(["Orders per day"], [["5"]]))).rejects.toThrow(/date column/i);
    await expect(planMetricsImport(ctx, cid("kiwi-go"), table(["Date", "Foo"], [["2026-11-01", "5"]]))).rejects.toThrow(
      /No column matches/,
    );
    await expect(planMetricsImport(ctx, cid("marketing"), table(["Date"], [["2026-11-01"]]))).rejects.toThrow(/no metrics/);
  });
});

describe("connectors", () => {
  function fakeConnector(points: MetricPoint[], opts: { failPull?: boolean } = {}): Connector {
    return {
      id: "fake-kiwi",
      name: "Fake Kiwi",
      companySlug: "kiwi-go",
      metrics: [{ key: "orders_day" }, { key: "couriers_active" }],
      setup: () => ({ configured: true, message: "ok", shortReason: "fake", envVars: [], missingEnv: [] }),
      healthCheck: async () => ({ state: "ok", message: "ok", envVars: [], missingEnv: [] }),
      pull: async () => {
        if (opts.failPull) throw new Error("boom");
        return points;
      },
    };
  }

  it("runConnector writes values with source=connector and logs the run", async () => {
    const db = t.handle.db;
    const registry = new ConnectorRegistry([
      fakeConnector([
        { metricKey: "orders_day", periodStart: "2026-10-31", value: 118 },
        { metricKey: "orders_day", periodStart: "2026-11-01", value: 131 },
        { metricKey: "couriers_active", periodStart: "2026-11-01", value: 14 },
        { metricKey: "revenue", periodStart: "2026-10-01", value: 1 }, // not declared by the connector
        { metricKey: "orders_day", periodStart: "2026-10-01", value: 1 }, // outside the range
        { metricKey: "nope", periodStart: "2026-11-01", value: 1 },
      ]),
    ]);
    const range = { from: "2026-10-26", to: "2026-11-01" };
    const res = await runConnector(db, "fake-kiwi", range, { registry, now: FIXED_NOW });
    expect(res).toMatchObject({ status: "ok", pointsReceived: 6, valuesWritten: 3, skipped: 3 });
    const values = await listMetricValues(t.ctx("nuraaly"), await metricId("kiwi-go", "orders_day"));
    expect(values.map((v) => [v.period, v.value, v.source, v.enteredByName])).toEqual([
      ["2026-11-01", 131, "connector", null],
      ["2026-10-31", 118, "connector", null],
    ]);
    const [run] = await db.select().from(connectorRuns).where(eq(connectorRuns.id, res.runId!));
    expect(run).toMatchObject({ connectorId: "fake-kiwi", status: "ok", valuesWritten: 3, pointsReceived: 6, companyId: cid("kiwi-go") });
    // Second run with the same data writes nothing new but is logged.
    expect((await runConnector(db, "fake-kiwi", range, { registry, now: FIXED_NOW })).valuesWritten).toBe(0);
    expect((await db.select().from(connectorRuns)).length).toBe(2);
  });

  it("a failing pull is logged as error and writes nothing; bad ranges are refused", async () => {
    const db = t.handle.db;
    const registry = new ConnectorRegistry([fakeConnector([], { failPull: true })]);
    const res = await runConnector(db, "fake-kiwi", { from: "2026-10-26", to: "2026-11-01" }, { registry, now: FIXED_NOW });
    expect(res).toMatchObject({ status: "error", message: "Pull failed: boom" });
    expect((await runConnector(db, "fake-kiwi", { from: "2026-11-02", to: "2026-11-01" }, { registry })).message).toMatch(/starts after/);
    expect((await runConnector(db, "missing", { from: "2026-11-01", to: "2026-11-01" }, { registry })).message).toMatch(/Unknown/);
    expect((await db.select().from(metricValues)).length).toBe(0);
  });

  it("stub connectors report 'not configured' without any network call, and runs are logged", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("no network in tests");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const stubs = stubConnectors({});
    expect(stubs.map((s) => s.id)).toEqual(["kiwigo-app", "wms-jobutify", "alura-erp", "wildberries"]);
    for (const s of stubs) {
      const h = await s.healthCheck();
      expect(h.state).toBe("not_configured");
      expect(h.missingEnv).toEqual(STUB_SPECS.find((x) => x.id === s.id)!.envVars);
    }
    expect((await stubs[0]!.healthCheck()).message).toBe("Waiting for API access from Edil");
    expect((await stubs[3]!.healthCheck()).message).toMatch(/^Needs WB token/);
    // Even with env vars set, a stub stays "not configured" and never calls out.
    const withEnv = stubConnectors({ WB_API_TOKEN: "x" })[3]!;
    expect(await withEnv.healthCheck()).toMatchObject({ state: "not_configured", missingEnv: [] });

    const res = await checkConnector(t.ctx("talant"), "wildberries", new ConnectorRegistry(stubs));
    expect(res).toMatchObject({ status: "not_configured", valuesWritten: 0 });
    const statuses = await listConnectorStatuses(t.ctx("nuraaly"), { registry: new ConnectorRegistry(stubs) });
    expect(statuses.find((s) => s.id === "wildberries")).toMatchObject({
      companySlug: "upsell-group",
      health: { state: "not_configured" },
      lastRun: { status: "not_configured" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(checkConnector(staffCtx(), "wildberries", new ConnectorRegistry(stubs))).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("staleness hook and morning summary", () => {
  it("staleMetricsFor lists overdue numbers; entering them clears them", async () => {
    const ctx = t.ctx("nuraaly");
    const all = await staleMetricsFor(ctx);
    const total = (await listMetricDefinitions(ctx)).length;
    expect(all.length).toBe(total); // nothing entered yet → all missing
    expect(all.every((s) => s.status === "missing")).toBe(true);
    const revenue = await metricId("kiwi-go", "revenue");
    expect(all.find((s) => s.metricId === revenue)).toMatchObject({ waitingFor: "2026-09-01", dueOn: "2026-10-10" });

    await recordMetricValue(ctx, revenue, { period: "2026-09", value: 1 });
    expect((await staleMetricsFor(ctx)).find((s) => s.metricId === revenue)).toBeUndefined();
    await recordMetricValue(ctx, await metricId("kiwi-go", "orders_day"), { period: "2026-10-30", value: 1 });
    expect((await staleMetricsFor(ctx)).find((s) => s.label === "Orders per day")).toMatchObject({ status: "stale", waitingFor: "2026-10-31" });
    // Shared company data: Talant gets the same list.
    expect((await staleMetricsFor(t.ctx("talant"))).map((s) => s.metricId)).toEqual((await staleMetricsFor(ctx)).map((s) => s.metricId));

    const fresh = await companyFreshness(ctx);
    expect(fresh.find((f) => f.companySlug === "kiwi-go")).toMatchObject({ total: 6, fresh: 1, stale: 1, missing: 4 });
    expect(fresh.find((f) => f.companySlug === "marketing")).toBeUndefined();
  });

  it("the morning summary of both founders has a 'Numbers waiting' section of at most 3 lines; no extra pushes", async () => {
    const db = t.handle.db;
    await db.delete(notificationsOutbox);
    await planTick(db, FIXED_NOW);
    const sent: { userId: string; message: NeutralMessage }[] = [];
    const channel: NotificationChannel = {
      name: "dev",
      async send(recipient, message) {
        sent.push({ userId: recipient.userId, message });
        return { ok: true, providerMessageId: "rec" };
      },
    };
    const registry: ChannelRegistry = { get: () => channel, resolve: () => channel };
    await dispatch(db, FIXED_NOW, { registry });
    expect(sent).toHaveLength(2); // one morning summary each, nothing else
    for (const s of sent) {
      expect(s.message.title).toMatch(/^Good morning/);
      const idx = s.message.lines.findIndex((l) => l.text.startsWith("Numbers waiting"));
      expect(idx).toBeGreaterThan(0);
      const section = s.message.lines.slice(idx + 1);
      // Monday, nothing entered yet: one line for numbers never entered and ONE line for
      // the 18 numbers that wait for data sources that are not set up.
      expect(section.map((l) => l.text)).toEqual([
        "Never entered yet: Revenue (Kiwi Go), Orders to factory (Alura Brand) +2 more",
        "18 numbers wait for data sources (Edil's APIs, WB token)",
      ]);
    }
    const kinds = (await db.select().from(notificationsOutbox)).map((r) => r.kind);
    expect(kinds.every((k) => k === "morning_summary" || k === "evening_check")).toBe(true);
  });
});

describe("REST", () => {
  const req = (url: string, init?: { method?: string; body?: unknown }) =>
    new NextRequest(`http://localhost${url}`, {
      method: init?.method ?? "GET",
      headers: { "content-type": "application/json" },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });

  it("GET company metrics, POST a value, GET history", async () => {
    state.ctx = null;
    expect((await companyMetricsRoute(req("/api/v1/companies/kiwi-go/metrics"), { params: Promise.resolve({ slug: "kiwi-go" }) })).status).toBe(401);
    state.ctx = t.ctx("nuraaly");
    const list = await companyMetricsRoute(req("/api/v1/companies/kiwi-go/metrics"), { params: Promise.resolve({ slug: "kiwi-go" }) });
    expect(list.status).toBe(200);
    const metrics = (await list.json()).data as { id: string; key: string; latest: unknown; freshness: { status: string } }[];
    const orders = metrics.find((m) => m.key === "orders_day")!;
    expect(orders).toMatchObject({ latest: null, freshness: { status: "missing" } });
    expect((await companyMetricsRoute(req("/x"), { params: Promise.resolve({ slug: "nope" }) })).status).toBe(404);

    const p = { params: Promise.resolve({ id: orders.id }) };
    const created = await postValueRoute(req(`/api/v1/metrics/${orders.id}/values`, { method: "POST", body: { period: "2026-11-01", value: 42 } }), p);
    expect(created.status).toBe(201);
    expect((await created.json()).data).toMatchObject({ action: "created", period: "2026-11-01", value: 42 });
    const bad = await postValueRoute(req(`/api/v1/metrics/${orders.id}/values`, { method: "POST", body: { period: "2026-11-01", value: -1 } }), p);
    expect(bad.status).toBe(400);
    await postValueRoute(req(`/api/v1/metrics/${orders.id}/values`, { method: "POST", body: { period: "2026-11-01", value: 43 } }), p);
    const hist = await valuesRoute(req(`/api/v1/metrics/${orders.id}/values?history=1`), p);
    expect((await hist.json()).data.values.map((v: { value: number; isCurrent: boolean }) => [v.value, v.isCurrent])).toEqual([
      [43, true],
      [42, false],
    ]);
    expect((await valuesRoute(req("/x"), { params: Promise.resolve({ id: "bad" }) })).status).toBe(404);
    state.ctx = staffCtx();
    expect((await valuesRoute(req("/x"), p)).status).toBe(404);
  });
});
