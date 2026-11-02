import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { metricDefinitions, metricValues } from "@/server/db/schema";
import {
  addLedgerEntry,
  archiveFlow,
  archiveLedgerEntry,
  getActsGrid,
  getDebts,
  listArchivedFlowActs,
  listFlows,
  patchAct,
  updateFlow,
  type FlowView,
} from "@/server/services/holding";
import { askCardFromGrid } from "@/server/services/holding-asks";
import { createTestDb, type TestDb } from "../helpers/db";

/** 20 Dec 2026, 12:00 Bishkek: November is the latest finished (and expected) month. */
const DEC20 = new Date("2026-12-20T06:00:00Z");
let t: TestDb;
let sew: FlowView;
let erp: FlowView;

beforeAll(async () => {
  t = await createTestDb({ now: DEC20 });
  const flows = await listFlows(t.ctx("nuraaly"));
  sew = flows.find((f) => f.fullLabel.startsWith("Alura Style → Alura Brand"))!;
  erp = flows.find((f) => f.fullLabel.startsWith("Jobutify → Alura Style"))!;
  await updateFlow(t.ctx("nuraaly"), sew.id, { since: "2026-09-01" });
});
afterAll(async () => {
  await t.handle.close();
});

async function debtValues(): Promise<Record<string, string>> {
  const [metric] = await t.handle.db
    .select()
    .from(metricDefinitions)
    .where(and(eq(metricDefinitions.key, "intercompany_debt"), eq(metricDefinitions.companyId, t.companyIds["asqa-zou-holding"]!)));
  const rows = await t.handle.db
    .select()
    .from(metricValues)
    .where(and(eq(metricValues.metricId, metric!.id), eq(metricValues.isCurrent, true)));
  return Object.fromEntries(rows.map((r) => [r.periodStart, `${r.source}:${r.value}`]));
}

describe("Intercompany debt total follows late and removed entries", () => {
  it("a late акт for October also corrects November (was stuck at 100.10)", async () => {
    const ctx = t.ctx("nuraaly");
    await patchAct(ctx, { flowId: sew.id, period: "2026-11", status: "received", amount: "100.10", actDate: "2026-11-30" });
    expect(await debtValues()).toEqual({ "2026-11-01": "derived:100.1000" });
    await patchAct(ctx, { flowId: sew.id, period: "2026-10", status: "signed", amount: "200.20", actDate: "2026-10-31" });
    expect(await debtValues()).toEqual({ "2026-10-01": "derived:200.2000", "2026-11-01": "derived:300.3000" });
  });

  it("a founder's own number for a month is kept; the months around it are still recomputed", async () => {
    const db = t.handle.db;
    const [metric] = await db.select().from(metricDefinitions).where(eq(metricDefinitions.key, "intercompany_debt"));
    await db
      .update(metricValues)
      .set({ isCurrent: false })
      .where(and(eq(metricValues.metricId, metric!.id), eq(metricValues.periodStart, "2026-10-01")));
    await db.insert(metricValues).values({ metricId: metric!.id, periodStart: "2026-10-01", value: "999", source: "manual", enteredBy: t.userIds.nuraaly });
    await patchAct(t.ctx("nuraaly"), { flowId: sew.id, period: "2026-10", amount: "250.20" });
    expect(await debtValues()).toEqual({ "2026-10-01": "manual:999.0000", "2026-11-01": "derived:350.3000" });
  });

  it("when every entry is gone again the derived months go to 0 (not left stale)", async () => {
    const ctx = t.ctx("nuraaly");
    const c = t.companyIds;
    const e = await addLedgerEntry(ctx, { kind: "opening", debtorCompanyId: c["kiwi-go"]!, creditorCompanyId: c["jobutify"]!, entryDate: "2026-08-15", amount: 50 });
    expect(await debtValues()).toMatchObject({ "2026-08-01": "derived:50.0000", "2026-09-01": "derived:50.0000", "2026-11-01": "derived:400.3000" });
    await archiveLedgerEntry(ctx, e.id);
    await patchAct(ctx, { flowId: sew.id, period: "2026-10", status: "missing" });
    await patchAct(ctx, { flowId: sew.id, period: "2026-11", status: "missing" });
    expect(await debtValues()).toEqual({
      "2026-08-01": "derived:0.0000",
      "2026-09-01": "derived:0.0000",
      "2026-10-01": "manual:999.0000",
      "2026-11-01": "derived:0.0000",
    });
  });
});

describe("акты of an archived flow can still be corrected", () => {
  it("status / amount / act date of a recorded акт; nothing else, nothing new, never 'requested'", async () => {
    const ctx = t.ctx("nuraaly");
    await updateFlow(ctx, erp.id, { since: "2026-09-01" });
    await patchAct(ctx, { flowId: erp.id, period: "2026-09", status: "received", amount: 1000 });
    await archiveFlow(ctx, erp.id);
    expect((await getDebts(ctx)).total).toBe(1000);
    expect(await listArchivedFlowActs(ctx)).toEqual([{ flowId: erp.id, period: "2026-09-01", status: "received", amount: 1000, actDate: null }]);

    await patchAct(ctx, { flowId: erp.id, period: "2026-09", amount: "1200.50", status: "signed", actDate: "2026-10-02" });
    expect((await getDebts(ctx)).total).toBe(1200.5);
    await expect(patchAct(ctx, { flowId: erp.id, period: "2026-09", note: "x" })).rejects.toThrow(/archived/);
    await expect(patchAct(ctx, { flowId: erp.id, period: "2026-09", status: "requested" })).rejects.toThrow(/archived/);
    await expect(patchAct(ctx, { flowId: erp.id, period: "2026-10", status: "received", amount: 5 })).rejects.toThrow(/already recorded/);
    await expect(patchAct(t.ctx("nuraaly"), { flowId: erp.id, period: "2026-09", status: "not_needed" })).resolves.toMatchObject({ debtChanged: true });
    expect((await getDebts(ctx)).total).toBe(0);
  });
});

describe("months older than the 13-month grid", () => {
  it("are counted, shown per row and included in the ask (grouped with the grid months)", async () => {
    const ctx = t.ctx("nuraaly");
    const kiwi = (await listFlows(ctx)).find((f) => f.fullLabel.startsWith("Kiwi Go → Alura Brand"))!;
    await updateFlow(ctx, kiwi.id, { since: "2025-09-01" });
    // Grid: Dec 2025 – Dec 2026. Sep–Nov 2025 are older; Oct 2025 was received.
    await patchAct(ctx, { flowId: kiwi.id, period: "2025-10", status: "received" });
    const grid = await getActsGrid(ctx);
    const row = grid.rows.find((r) => r.flow.id === kiwi.id)!;
    expect(grid.months[0]!.period).toBe("2025-12-01");
    expect(row.older.map((c) => `${c.period}|${c.state}`)).toEqual(["2025-09-01|missing", "2025-11-01|missing"]);
    const card = askCardFromGrid(grid);
    const g = card.missing.groups.find((x) => x.label === "Kiwi Go → Alura Brand")!;
    expect(g.months.slice(0, 3)).toEqual(["2025-09-01", "2025-11-01", "2025-12-01"]);
    expect(card.missing.cells).toEqual(expect.arrayContaining([{ flowId: kiwi.id, period: "2025-09-01" }]));
    expect(card.message).toContain("сентябрь, ноябрь, декабрь 2025");
    // The total includes them.
    expect(grid.missing).toBe(grid.rows.flatMap((r) => [...r.older, ...r.cells]).filter((c) => c.state === "missing").length);
  });
});
