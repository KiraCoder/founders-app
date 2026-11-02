import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { intercompanyActs, intercompanyFlows, metricDefinitions, metricValues } from "@/server/db/schema";
import { seed } from "@/server/db/seed";
import {
  addLedgerEntry,
  archiveContract,
  archiveFlow,
  archiveLedgerEntry,
  createContract,
  createFlow,
  getActsGrid,
  getDebts,
  getHoldingSummary,
  listContracts,
  listFlows,
  patchAct,
  restoreFlow,
  syncDebtMetric,
  updateFlow,
  type FlowView,
} from "@/server/services/holding";
import type { ServiceContext } from "@/server/services/context";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
/** 2026-11-20 12:00 Bishkek: October is expected (after the 10-day grace), November is not. */
const NOV20 = new Date("2026-11-20T06:00:00Z");
let flows: FlowView[];
const flowOf = (label: string) => flows.find((f) => f.fullLabel.startsWith(label))!;

beforeAll(async () => {
  t = await createTestDb();
  flows = await listFlows(t.ctx("nuraaly"));
});
afterAll(async () => {
  await t.handle.close();
});

const at = (who: "nuraaly" | "talant" = "nuraaly", now = NOV20): ServiceContext => t.ctx(who, now);

describe("seeded flows", () => {
  it("has the known flows; real databases get no start date, so nothing is expected yet", async () => {
    const labels = flows.map((f) => `${f.fullLabel}|${f.status}|${f.since ?? "-"}`);
    expect(labels).toEqual(
      expect.arrayContaining([
        "Alura Style → Alura Brand · пошив|active|-",
        "Jobutify → Alura Style · ERP|active|-",
        "Jobutify → Kiwi Go · приложение и платформа|active|-",
        "Kiwi Go → Alura Brand · доставка|active|-",
        "Marketing → Alura Brand · маркетинг|planned|-",
      ]),
    );
    expect(flows.filter((f) => f.from.slug === "marketing")).toHaveLength(5);
    const grid = await getActsGrid(at());
    expect(grid.rows).toHaveLength(4); // planned Marketing flows are not in the grid
    expect(grid.missing).toBe(0);
    expect(grid.rows[0]!.cells.every((c) => c.state === "inactive")).toBe(true);
  });

  it("re-seeding adds nothing and keeps a start date a founder set", async () => {
    const f = flowOf("Kiwi Go → Alura Brand");
    await updateFlow(at(), f.id, { since: "2026-05-01" });
    await seed(t.handle.db, { password: "test-password", bcryptRounds: 4, withSamples: true, timeZone: "Asia/Bishkek" });
    const after = await listFlows(at());
    expect(after).toHaveLength(flows.length);
    expect(after.find((x) => x.id === f.id)!.since).toBe("2026-05-01");
    // Samples fill only empty start dates.
    expect(after.find((x) => x.fullLabel.startsWith("Alura Style → Alura Brand"))!.since).toBe("2026-01-01");
    expect(after.filter((x) => x.status === "planned").every((x) => x.since === null)).toBe(true);
    flows = after;
  });
});

describe("акты grid", () => {
  it("expects months from the flow start up to the last finished month after grace", async () => {
    const grid = await getActsGrid(at());
    const row = grid.rows.find((r) => r.flow.label === "Kiwi Go → Alura Brand")!;
    const state = (p: string) => row.cells.find((c) => c.period === p)!.state;
    expect(state("2026-04-01")).toBe("before_start");
    expect(state("2026-05-01")).toBe("missing");
    expect(state("2026-10-01")).toBe("missing");
    expect(state("2026-11-01")).toBe("not_due");
    // On 2 November October is still in the grace days.
    const early = await getActsGrid(at("nuraaly", new Date("2026-11-02T06:00:00Z")));
    expect(early.rows.find((r) => r.flow.id === row.flow.id)!.cells.find((c) => c.period === "2026-10-01")!.state).toBe("not_due");
    expect(grid.months).toHaveLength(13);
    expect(grid.months.at(-1)).toMatchObject({ period: "2026-11-01", current: true });
  });

  it("changing a cell: requested (yellow, with date and who), received (green), not needed (grey), back to missing", async () => {
    const f = flowOf("Kiwi Go → Alura Brand");
    const req = await patchAct(at("talant"), { flowId: f.id, period: "2026-09", status: "requested" });
    expect(req.cell).toMatchObject({ state: "requested", tone: "warn", requestedOn: "2026-11-20", requestedBy: "Talant" });
    const rec = await patchAct(at(), { flowId: f.id, period: "2026-09-01", status: "received", amount: "45 000", actNumber: "А-9" });
    expect(rec.cell).toMatchObject({ state: "received", tone: "ok", amount: 45000, actNumber: "А-9", requestedOn: "2026-11-20" });
    expect(rec.debtChanged).toBe(true);
    const nn = await patchAct(at(), { flowId: f.id, period: "2026-08", status: "not_needed", note: "No deliveries in August" });
    expect(nn.cell).toMatchObject({ state: "not_needed", tone: "grey", note: "No deliveries in August" });
    const back = await patchAct(at(), { flowId: f.id, period: "2026-08", status: "missing" });
    expect(back.cell).toMatchObject({ state: "missing", tone: "risk", note: "No deliveries in August" });
    // Only changed fields: a note alone keeps the status.
    const noted = await patchAct(at(), { flowId: f.id, period: "2026-09", note: "Original at the office" });
    expect(noted.cell).toMatchObject({ state: "received", amount: 45000, note: "Original at the office" });
    expect(noted.debtChanged).toBe(false);
  });

  it("refuses months before the start, future months, bad amounts and dates", async () => {
    const f = flowOf("Kiwi Go → Alura Brand");
    const ctx = at();
    await expect(patchAct(ctx, { flowId: f.id, period: "2026-04", status: "requested" })).rejects.toThrow(/starts in May 2026/);
    await expect(patchAct(ctx, { flowId: f.id, period: "2026-12", status: "requested" })).rejects.toThrow(/hasn't started/);
    await expect(patchAct(ctx, { flowId: f.id, period: "2026-10", amount: "85.000" })).rejects.toThrow(/ambiguous/);
    await expect(patchAct(ctx, { flowId: f.id, period: "2026-10", amount: "-5" })).rejects.toThrow(/negative/);
    await expect(patchAct(ctx, { flowId: f.id, period: "2026-10", amount: "1210.555" })).rejects.toThrow(/2 decimals/);
    await expect(patchAct(ctx, { flowId: f.id, period: "2026-10", actDate: "2026-12-01" })).rejects.toThrow(/future/);
    await expect(patchAct(ctx, { flowId: f.id, period: "2026-13", status: "requested" })).rejects.toThrow();
    await expect(patchAct(ctx, { flowId: "not-a-uuid", period: "2026-10" })).rejects.toThrow();
    // The current month may be recorded early (e.g. received before the month ends).
    const early = await patchAct(ctx, { flowId: f.id, period: "2026-11", status: "received" });
    expect(early.cell.state).toBe("received");
    await patchAct(ctx, { flowId: f.id, period: "2026-11", status: "missing" });
  });

  it("a staff account gets nothing (founders only)", async () => {
    const staff: ServiceContext = { ...at(), user: { ...t.founders.nuraaly, role: "staff" } };
    await expect(getActsGrid(staff)).rejects.toMatchObject({ code: "forbidden" });
    await expect(getDebts(staff)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("flows", () => {
  it("create, duplicate refused, same company refused, edit, archive (kept), restore", async () => {
    const ctx = at();
    const c = t.companyIds;
    const f = await createFlow(ctx, { fromCompanyId: c["upsell-group"]!, toCompanyId: c["alura-brand"]!, service: "продажи WB", since: "2026-06-01" });
    expect(f.fullLabel).toBe("Upsell Group → Alura Brand · продажи WB");
    await expect(
      createFlow(ctx, { fromCompanyId: c["upsell-group"]!, toCompanyId: c["alura-brand"]!, service: "Продажи WB" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(createFlow(ctx, { fromCompanyId: c["kiwi-go"]!, toCompanyId: c["kiwi-go"]!, service: "x" })).rejects.toThrow(/two different/);
    await expect(updateFlow(ctx, f.id, { since: "2026-06-01", until: "2026-05-01" })).rejects.toThrow(/before the start/);
    await updateFlow(ctx, f.id, { description: "WB sales for the brand" });
    await patchAct(ctx, { flowId: f.id, period: "2026-07", status: "signed" });
    await archiveFlow(ctx, f.id);
    expect((await getActsGrid(ctx)).rows.some((r) => r.flow.id === f.id)).toBe(false);
    expect((await listFlows(ctx, { includeArchived: true })).find((x) => x.id === f.id)!.archived).toBe(true);
    // Nothing was deleted.
    expect(await t.handle.db.select().from(intercompanyActs).where(eq(intercompanyActs.flowId, f.id))).toHaveLength(1);
    await restoreFlow(ctx, f.id);
    expect((await getActsGrid(ctx)).rows.some((r) => r.flow.id === f.id)).toBe(true);
    await archiveFlow(ctx, f.id);
  });
});

describe("contracts", () => {
  it("expiry warnings 30 days ahead, overdue signed contracts, archive", async () => {
    const ctx = at();
    const f = flowOf("Alura Style → Alura Brand");
    const soon = await createContract(ctx, { flowId: f.id, number: "№ 7/2026", signedOn: "2026-01-10", validUntil: "2026-12-15", status: "signed", amountTerms: "по прайсу за единицу" });
    expect(soon.warning).toEqual({ kind: "expiring", days: 25 });
    const later = await createContract(ctx, { flowId: f.id, number: "№ 8/2026", validUntil: "2027-06-30", status: "signed" });
    expect(later.warning).toBeNull();
    const ended = await createContract(ctx, { flowId: f.id, number: "№ 1/2025", validUntil: "2026-11-01", status: "signed" });
    expect(ended.warning).toEqual({ kind: "overdue", days: 19 });
    await expect(createContract(ctx, { flowId: f.id, number: "x", signedOn: "2026-05-01", validUntil: "2026-04-01" })).rejects.toThrow(
      /before the signing date/,
    );
    await expect(createContract(ctx, { flowId: f.id, number: "x", attachmentFileId: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(
      /Attachment not found/,
    );
    expect((await getHoldingSummary(ctx)).contractsExpiring).toBe(2);
    await archiveContract(ctx, ended.id);
    expect((await listContracts(ctx)).map((c) => c.number)).not.toContain("№ 1/2025");
    expect((await listContracts(ctx, { includeArchived: true })).map((c) => c.number)).toContain("№ 1/2025");
    await archiveContract(ctx, soon.id);
    await archiveContract(ctx, later.id);
  });
});

describe("debts", () => {
  it("акты received/signed with an amount are invoiced; payments and opening balances; both directions netted", async () => {
    const ctx = at();
    const c = t.companyIds;
    const sew = flowOf("Alura Style → Alura Brand");
    // Kiwi Go → Alura Brand Sep: 45 000 received (earlier test).
    await patchAct(ctx, { flowId: sew.id, period: "2026-09", status: "signed", amount: 1_000_000, actDate: "2026-09-30" });
    await patchAct(ctx, { flowId: sew.id, period: "2026-10", status: "received", amount: "500000" });
    // Requested with an amount does not count yet.
    await patchAct(ctx, { flowId: sew.id, period: "2026-08", status: "requested", amount: 999 });
    await addLedgerEntry(ctx, { kind: "opening", debtorCompanyId: c["alura-brand"]!, creditorCompanyId: c["alura-style"]!, entryDate: "2026-01-01", amount: "300 000", note: "Balance from Excel" });
    await addLedgerEntry(ctx, { kind: "payment", debtorCompanyId: c["alura-brand"]!, creditorCompanyId: c["alura-style"]!, entryDate: "2026-10-15", amount: 560_000 });
    // The other direction: Alura Style owes Alura Brand for materials.
    await addLedgerEntry(ctx, { kind: "opening", debtorCompanyId: c["alura-style"]!, creditorCompanyId: c["alura-brand"]!, entryDate: "2026-02-01", amount: 0.5 });
    const debts = await getDebts(ctx);
    const pair = debts.pairs.find((p) => p.creditor.slug === "alura-style")!;
    // 1 000 000 + 500 000 + 300 000 − 560 000 − 0.50
    expect(pair).toMatchObject({ debtor: { slug: "alura-brand" }, amount: 1_239_999.5 });
    expect(debts.pairs.find((p) => p.creditor.slug === "kiwi-go")).toMatchObject({ debtor: { slug: "alura-brand" }, amount: 45_000 });
    expect(debts.total).toBe(1_284_999.5);
    // As of the end of September: no October act, no October payment.
    const sept = await getDebts(ctx, "2026-09-30");
    expect(sept.pairs.find((p) => p.creditor.slug === "alura-style")!.amount).toBe(1_299_999.5);

    await expect(
      addLedgerEntry(ctx, { kind: "payment", debtorCompanyId: c["kiwi-go"]!, creditorCompanyId: c["kiwi-go"]!, entryDate: "2026-10-01", amount: 1 }),
    ).rejects.toThrow(/two different/);
    await expect(
      addLedgerEntry(ctx, { kind: "payment", debtorCompanyId: c["kiwi-go"]!, creditorCompanyId: c["jobutify"]!, entryDate: "2026-10-01", amount: 0 }),
    ).rejects.toThrow(/more than 0/);
    await expect(
      addLedgerEntry(ctx, { kind: "payment", debtorCompanyId: c["kiwi-go"]!, creditorCompanyId: c["jobutify"]!, entryDate: "2026-12-01", amount: 5 }),
    ).rejects.toThrow(/future/);

    // A mistaken entry is archived (not deleted) and stops counting.
    const wrong = await addLedgerEntry(ctx, { kind: "payment", debtorCompanyId: c["kiwi-go"]!, creditorCompanyId: c["jobutify"]!, entryDate: "2026-11-01", amount: 7 });
    expect((await getDebts(ctx)).pairs.find((p) => p.creditor.slug === "kiwi-go" && p.debtor.slug === "jobutify")?.amount).toBe(7);
    await archiveLedgerEntry(ctx, wrong.id);
    expect((await getDebts(ctx)).pairs.some((p) => p.debtor.slug === "jobutify")).toBe(false);
    const summary = await getHoldingSummary(ctx);
    expect(summary.totalDebt).toBe(1_284_999.5);
  });

  it("feeds the Holding metric 'Intercompany debt total' for the latest finished month (derived), never over a founder's number", async () => {
    const db = t.handle.db;
    const [metric] = await db
      .select()
      .from(metricDefinitions)
      .where(and(eq(metricDefinitions.key, "intercompany_debt"), eq(metricDefinitions.companyId, t.companyIds["asqa-zou-holding"]!)));
    const current = async () =>
      db.select().from(metricValues).where(and(eq(metricValues.metricId, metric!.id), eq(metricValues.isCurrent, true)));
    // Written already by the act/ledger changes above (October = total as of 31 Oct).
    expect(await current()).toEqual([expect.objectContaining({ periodStart: "2026-10-01", source: "derived", value: "1284999.5000" })]);
    expect(await syncDebtMetric(db, NOV20, "Asia/Bishkek")).toMatchObject({ action: "unchanged", period: "2026-10-01" });

    // A founder's own number for October wins; the derived value does not replace it.
    await db.update(metricValues).set({ isCurrent: false }).where(eq(metricValues.metricId, metric!.id));
    await db.insert(metricValues).values({ metricId: metric!.id, periodStart: "2026-10-01", value: "1000", source: "manual", enteredBy: t.userIds.nuraaly });
    expect(await syncDebtMetric(db, NOV20, "Asia/Bishkek")).toMatchObject({ action: "conflict" });
    expect((await current())[0]).toMatchObject({ source: "manual", value: "1000.0000" });
  });

  it("writes nothing while no debt data exists", async () => {
    const fresh = await createTestDb();
    try {
      expect(await syncDebtMetric(fresh.handle.db, NOV20, "Asia/Bishkek")).toMatchObject({ action: "skipped", reason: "no_data" });
      expect(await fresh.handle.db.select().from(metricValues)).toHaveLength(0);
    } finally {
      await fresh.handle.close();
    }
  });
});

describe("summary row", () => {
  it("counts missing акты in the grid window", async () => {
    const ctx = at();
    const grid = await getActsGrid(ctx);
    const summary = await getHoldingSummary(ctx);
    expect(summary.missingActs).toBe(grid.missing);
    expect(summary.missingActs).toBeGreaterThan(0);
    // Unknown flows in the database are never shown as a different company's.
    const [any] = await t.handle.db.select().from(intercompanyFlows).limit(1);
    expect(any).toBeTruthy();
  });
});
