import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { addDays, todayInTimeZone, type IsoDate } from "@/lib/dates";
import {
  actCountsAsInvoiced,
  actDueFrom,
  actLedgerDate,
  cellState,
  cellTone,
  contractWarning,
  expectation,
  graceDays,
  gridMonths,
  monthLong,
  monthStart,
  netDebts,
  totalDebt,
  type ActStatusValue,
  type AskGroup,
  type CellState,
  type CellTone,
  type ContractWarning,
  type DebtMovement,
  type FlowStatusValue,
} from "@/lib/holding";
import {
  actPatchSchema,
  contractCreateSchema,
  contractUpdateSchema,
  flowCreateSchema,
  flowUpdateSchema,
  ledgerEntrySchema,
  type ActPatchInput,
  type ContractCreateInput,
  type ContractUpdateInput,
  type FlowCreateInput,
  type FlowUpdateInput,
  type LedgerEntryInput,
} from "@/lib/holding-schemas";
import { decimalPlaces, parseMetricInput, periodEnd, prevPeriod } from "@/lib/metrics";
import type { Db } from "@/server/db/connect";
import {
  companies,
  holdingFiles,
  intercompanyActs,
  intercompanyContracts,
  intercompanyFlows,
  intercompanyLedgerEntries,
  metricDefinitions,
  users,
  type ContractStatus,
  type IntercompanyAct,
  type IntercompanyFlow,
} from "@/server/db/schema";
import { assertHoldingAccess, assertValidId } from "./access";
import { today, type ServiceContext } from "./context";
import { ServiceError } from "./errors";
import { writeMetricValueTx } from "./metrics";

/**
 * Holding: intercompany flows, contracts, monthly акты приёма-передачи and the debts
 * between group companies. Founders only (assertHoldingAccess). Nothing is hard-deleted:
 * flows, contracts and ledger entries are archived. The app never contacts Elmurat; it
 * only reminds the founders to ask him (see holding-asks.ts).
 */

export const HOLDING_COMPANY_SLUG = "asqa-zou-holding";
export const DEBT_METRIC_KEY = "intercompany_debt";

// ---------------------------------------------------------------------------
// Companies (names for labels)
// ---------------------------------------------------------------------------

export interface CompanyRef {
  id: string;
  slug: string;
  name: string;
  color: string;
}

async function companyMap(db: Db): Promise<Map<string, CompanyRef>> {
  const rows = await db
    .select({ id: companies.id, slug: companies.slug, name: companies.name, color: companies.color })
    .from(companies)
    .orderBy(asc(companies.sort));
  return new Map(rows.map((r) => [r.id, r]));
}

async function assertLiveCompany(db: Db, id: string, field: string): Promise<void> {
  const [row] = await db.select({ id: companies.id }).from(companies).where(and(eq(companies.id, id), isNull(companies.archivedAt)));
  if (!row) throw new ServiceError("validation", "Unknown company", { [field]: ["Unknown company"] });
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

export interface FlowView {
  id: string;
  from: CompanyRef;
  to: CompanyRef;
  service: string;
  description: string | null;
  since: IsoDate | null;
  until: IsoDate | null;
  status: FlowStatusValue;
  archived: boolean;
  /** "Alura Style → Alura Brand" */
  label: string;
  /** "Alura Style → Alura Brand · пошив" */
  fullLabel: string;
}

function flowView(f: IntercompanyFlow, cmap: Map<string, CompanyRef>): FlowView {
  const unknown = (id: string): CompanyRef => ({ id, slug: "", name: "Unknown company", color: "#58645D" });
  const from = cmap.get(f.fromCompanyId) ?? unknown(f.fromCompanyId);
  const to = cmap.get(f.toCompanyId) ?? unknown(f.toCompanyId);
  const label = `${from.name} → ${to.name}`;
  return {
    id: f.id,
    from,
    to,
    service: f.service,
    description: f.description,
    since: f.since,
    until: f.until,
    status: f.status,
    archived: !!f.archivedAt,
    label,
    fullLabel: `${label} · ${f.service}`,
  };
}

async function loadFlows(db: Db, opts: { includeArchived?: boolean } = {}): Promise<FlowView[]> {
  const [rows, cmap] = await Promise.all([
    db
      .select()
      .from(intercompanyFlows)
      .where(opts.includeArchived ? undefined : isNull(intercompanyFlows.archivedAt))
      .orderBy(asc(intercompanyFlows.createdAt), asc(intercompanyFlows.id)),
    companyMap(db),
  ]);
  return rows
    .map((f) => flowView(f, cmap))
    .sort((a, b) => Number(a.archived) - Number(b.archived) || (a.status === b.status ? 0 : a.status === "active" ? -1 : 1));
}

export async function listFlows(ctx: ServiceContext, opts: { includeArchived?: boolean } = {}): Promise<FlowView[]> {
  assertHoldingAccess(ctx);
  return loadFlows(ctx.db, opts);
}

async function loadFlow(db: Db, id: unknown, opts: { allowArchived?: boolean } = {}): Promise<IntercompanyFlow> {
  assertValidId(id, "Flow");
  const [row] = await db.select().from(intercompanyFlows).where(eq(intercompanyFlows.id, id));
  if (!row || (!opts.allowArchived && row.archivedAt)) throw new ServiceError("not_found", "Flow not found");
  return row;
}

function checkFlowDates(since: IsoDate | null, until: IsoDate | null, status: FlowStatusValue): void {
  if (since && until && until < since) {
    throw new ServiceError("validation", "The end date is before the start date", { until: ["Before the start date"] });
  }
  if (since && since < "2015-01-01") throw new ServiceError("validation", "That start date is too far back", { since: ["Too old"] });
  void status;
}

function uniqueFlowError(err: unknown): never {
  const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
  if (code === "23505") {
    throw new ServiceError("conflict", "This flow already exists (same two companies and service)", {
      service: ["Already exists for these companies"],
    });
  }
  throw err;
}

export async function createFlow(ctx: ServiceContext, input: FlowCreateInput): Promise<FlowView> {
  assertHoldingAccess(ctx);
  const data = flowCreateSchema.parse(input);
  if (data.fromCompanyId === data.toCompanyId) {
    throw new ServiceError("validation", "A flow needs two different companies", { toCompanyId: ["Same company as “from”"] });
  }
  await assertLiveCompany(ctx.db, data.fromCompanyId, "fromCompanyId");
  await assertLiveCompany(ctx.db, data.toCompanyId, "toCompanyId");
  const status = data.status ?? "active";
  checkFlowDates(data.since ?? null, data.until ?? null, status);
  const [row] = await ctx.db
    .insert(intercompanyFlows)
    .values({
      fromCompanyId: data.fromCompanyId,
      toCompanyId: data.toCompanyId,
      service: data.service,
      description: data.description ?? null,
      since: data.since ?? null,
      until: data.until ?? null,
      status,
      createdBy: ctx.user.id,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning()
    .catch(uniqueFlowError);
  return flowView(row!, await companyMap(ctx.db));
}

export async function updateFlow(ctx: ServiceContext, id: string, input: FlowUpdateInput): Promise<FlowView> {
  assertHoldingAccess(ctx);
  const flow = await loadFlow(ctx.db, id);
  const data = flowUpdateSchema.parse(input);
  const since = data.since === undefined ? flow.since : data.since;
  const until = data.until === undefined ? flow.until : data.until;
  const status = data.status ?? flow.status;
  checkFlowDates(since, until, status);
  const [row] = await ctx.db
    .update(intercompanyFlows)
    .set({
      service: data.service ?? flow.service,
      description: data.description === undefined ? flow.description : data.description,
      since,
      until,
      status,
      updatedAt: ctx.now,
    })
    .where(eq(intercompanyFlows.id, flow.id))
    .returning()
    .catch(uniqueFlowError);
  return flowView(row!, await companyMap(ctx.db));
}

/** Archive (never delete): the flow leaves the grid; its акты and contracts are kept. */
export async function archiveFlow(ctx: ServiceContext, id: string): Promise<void> {
  assertHoldingAccess(ctx);
  const flow = await loadFlow(ctx.db, id);
  await ctx.db.update(intercompanyFlows).set({ archivedAt: ctx.now, updatedAt: ctx.now }).where(eq(intercompanyFlows.id, flow.id));
}

export async function restoreFlow(ctx: ServiceContext, id: string): Promise<void> {
  assertHoldingAccess(ctx);
  const flow = await loadFlow(ctx.db, id, { allowArchived: true });
  await ctx.db
    .update(intercompanyFlows)
    .set({ archivedAt: null, updatedAt: ctx.now })
    .where(eq(intercompanyFlows.id, flow.id))
    .catch(uniqueFlowError);
}

// ---------------------------------------------------------------------------
// Files (attachments): metadata check only; upload/download is in holding-files.ts
// ---------------------------------------------------------------------------

export interface FileRef {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
}

async function assertFile(db: Db, id: string | null | undefined): Promise<void> {
  if (!id) return;
  const [row] = await db.select({ id: holdingFiles.id }).from(holdingFiles).where(and(eq(holdingFiles.id, id), isNull(holdingFiles.archivedAt)));
  if (!row) throw new ServiceError("validation", "Attachment not found (upload it again)", { attachmentFileId: ["Not found"] });
}

async function fileRefs(db: Db, ids: (string | null)[]): Promise<Map<string, FileRef>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return new Map();
  const rows = await db
    .select({ id: holdingFiles.id, name: holdingFiles.originalName, contentType: holdingFiles.contentType, sizeBytes: holdingFiles.sizeBytes })
    .from(holdingFiles)
    .where(inArray(holdingFiles.id, list));
  return new Map(rows.map((r) => [r.id, r]));
}

// ---------------------------------------------------------------------------
// Amounts (exact KGS, at most 2 decimals)
// ---------------------------------------------------------------------------

export function parseKgs(raw: unknown, field = "amount", opts: { positive?: boolean } = {}): number {
  const r = parseMetricInput(typeof raw === "number" ? raw : String(raw ?? ""), "KGS");
  const fail = (msg: string): never => {
    throw new ServiceError("validation", msg, { [field]: [msg] });
  };
  if ("error" in r) return fail(r.error);
  if (r.value < 0) return fail("The amount can't be negative");
  if (opts.positive && r.value === 0) return fail("The amount must be more than 0");
  if (decimalPlaces(r.value) > 2) return fail("At most 2 decimals (tyiyn)");
  if (r.value > 999_999_999_999) return fail("The amount is too large");
  return r.value;
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export interface ContractView {
  id: string;
  flow: FlowView;
  number: string;
  signedOn: IsoDate | null;
  validUntil: IsoDate | null;
  status: ContractStatus;
  amountTerms: string | null;
  attachment: FileRef | null;
  warning: ContractWarning;
  archived: boolean;
}

export async function listContracts(ctx: ServiceContext, opts: { includeArchived?: boolean } = {}): Promise<ContractView[]> {
  assertHoldingAccess(ctx);
  const flows = new Map((await loadFlows(ctx.db, { includeArchived: true })).map((f) => [f.id, f]));
  const rows = await ctx.db
    .select()
    .from(intercompanyContracts)
    .where(opts.includeArchived ? undefined : isNull(intercompanyContracts.archivedAt))
    .orderBy(asc(intercompanyContracts.validUntil), asc(intercompanyContracts.createdAt));
  const files = await fileRefs(ctx.db, rows.map((r) => r.attachmentFileId));
  const todayIso = today(ctx);
  return rows
    .filter((r) => flows.has(r.flowId))
    .map((r) => ({
      id: r.id,
      flow: flows.get(r.flowId)!,
      number: r.number,
      signedOn: r.signedOn,
      validUntil: r.validUntil,
      status: r.status,
      amountTerms: r.amountTerms,
      attachment: r.attachmentFileId ? (files.get(r.attachmentFileId) ?? null) : null,
      warning: r.archivedAt ? null : contractWarning(r, todayIso),
      archived: !!r.archivedAt,
    }));
}

function checkContractDates(signedOn: IsoDate | null, validUntil: IsoDate | null): void {
  if (signedOn && validUntil && validUntil < signedOn) {
    throw new ServiceError("validation", "“Valid until” is before the signing date", { validUntil: ["Before the signing date"] });
  }
}

export async function createContract(ctx: ServiceContext, input: ContractCreateInput): Promise<ContractView> {
  assertHoldingAccess(ctx);
  const data = contractCreateSchema.parse(input);
  await loadFlow(ctx.db, data.flowId);
  checkContractDates(data.signedOn ?? null, data.validUntil ?? null);
  await assertFile(ctx.db, data.attachmentFileId);
  const [row] = await ctx.db
    .insert(intercompanyContracts)
    .values({
      flowId: data.flowId,
      number: data.number,
      signedOn: data.signedOn ?? null,
      validUntil: data.validUntil ?? null,
      status: data.status ?? "draft",
      amountTerms: data.amountTerms ?? null,
      attachmentFileId: data.attachmentFileId ?? null,
      createdBy: ctx.user.id,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning({ id: intercompanyContracts.id });
  return (await listContracts(ctx)).find((c) => c.id === row!.id)!;
}

async function loadContract(db: Db, id: unknown) {
  assertValidId(id, "Contract");
  const [row] = await db.select().from(intercompanyContracts).where(and(eq(intercompanyContracts.id, id), isNull(intercompanyContracts.archivedAt)));
  if (!row) throw new ServiceError("not_found", "Contract not found");
  return row;
}

export async function updateContract(ctx: ServiceContext, id: string, input: ContractUpdateInput): Promise<ContractView> {
  assertHoldingAccess(ctx);
  const c = await loadContract(ctx.db, id);
  const data = contractUpdateSchema.parse(input);
  const pick = <K extends keyof typeof data>(k: K, cur: unknown) => (data[k] === undefined ? cur : data[k]);
  const signedOn = pick("signedOn", c.signedOn) as IsoDate | null;
  const validUntil = pick("validUntil", c.validUntil) as IsoDate | null;
  checkContractDates(signedOn, validUntil);
  await assertFile(ctx.db, data.attachmentFileId);
  await ctx.db
    .update(intercompanyContracts)
    .set({
      number: data.number ?? c.number,
      signedOn,
      validUntil,
      status: data.status ?? c.status,
      amountTerms: pick("amountTerms", c.amountTerms) as string | null,
      attachmentFileId: pick("attachmentFileId", c.attachmentFileId) as string | null,
      updatedAt: ctx.now,
    })
    .where(eq(intercompanyContracts.id, c.id));
  return (await listContracts(ctx)).find((x) => x.id === c.id)!;
}

export async function archiveContract(ctx: ServiceContext, id: string): Promise<void> {
  assertHoldingAccess(ctx);
  const c = await loadContract(ctx.db, id);
  await ctx.db.update(intercompanyContracts).set({ archivedAt: ctx.now, updatedAt: ctx.now }).where(eq(intercompanyContracts.id, c.id));
}

// ---------------------------------------------------------------------------
// Акты grid
// ---------------------------------------------------------------------------

export interface ActCell {
  flowId: string;
  period: IsoDate;
  state: CellState;
  tone: CellTone;
  /** Recorded status (null = nothing recorded yet). */
  status: ActStatusValue | null;
  amount: number | null;
  actNumber: string | null;
  actDate: IsoDate | null;
  requestedOn: IsoDate | null;
  requestedBy: string | null;
  note: string | null;
  attachment: FileRef | null;
  /** First day this month's акт is expected (end of month + grace). */
  dueFrom: IsoDate;
}

export interface ActsGrid {
  today: IsoDate;
  graceDays: number;
  months: { period: IsoDate; label: string; current: boolean }[];
  rows: { flow: FlowView; cells: ActCell[] }[];
  missing: number;
  requested: number;
}

interface GridOpts {
  months?: IsoDate[];
  grace?: number;
}

/** The grid for any reader (service context or planner). Rows = active flows. */
export async function loadActsGrid(db: Db, todayIso: IsoDate, opts: GridOpts = {}): Promise<ActsGrid> {
  const grace = opts.grace ?? graceDays();
  const months = opts.months ?? gridMonths(todayIso);
  const flows = (await loadFlows(db)).filter((f) => f.status === "active");
  const acts = flows.length
    ? await db
        .select()
        .from(intercompanyActs)
        .where(
          and(
            inArray(intercompanyActs.flowId, flows.map((f) => f.id)),
            gte(intercompanyActs.period, months[0]!),
            lte(intercompanyActs.period, months[months.length - 1]!),
          ),
        )
    : [];
  const byKey = new Map(acts.map((a) => [`${a.flowId}|${a.period}`, a]));
  const files = await fileRefs(db, acts.map((a) => a.attachmentFileId));
  const userNames = new Map(
    (await db.select({ id: users.id, shortName: users.shortName }).from(users)).map((u) => [u.id, u.shortName]),
  );
  const current = monthStart(todayIso);
  let missing = 0;
  let requested = 0;
  const rows = flows.map((flow) => ({
    flow,
    cells: months.map((period): ActCell => {
      const a = byKey.get(`${flow.id}|${period}`);
      const exp = expectation(flow, period, todayIso, grace);
      const state = cellState(a?.status ?? null, exp);
      if (state === "missing") missing++;
      if (state === "requested") requested++;
      return {
        flowId: flow.id,
        period,
        state,
        tone: cellTone(state),
        status: a?.status ?? null,
        amount: a?.amount != null ? Number(a.amount) : null,
        actNumber: a?.actNumber ?? null,
        actDate: a?.actDate ?? null,
        requestedOn: a?.requestedOn ?? null,
        requestedBy: a?.requestedBy ? (userNames.get(a.requestedBy) ?? null) : null,
        note: a?.note ?? null,
        attachment: a?.attachmentFileId ? (files.get(a.attachmentFileId) ?? null) : null,
        dueFrom: actDueFrom(period, grace),
      };
    }),
  }));
  return {
    today: todayIso,
    graceDays: grace,
    months: months.map((p) => ({ period: p, label: monthLong(p), current: p === current })),
    rows,
    missing,
    requested,
  };
}

export async function getActsGrid(ctx: ServiceContext, opts: GridOpts = {}): Promise<ActsGrid> {
  assertHoldingAccess(ctx);
  return loadActsGrid(ctx.db, today(ctx), opts);
}

/** Cells grouped per flow, for the "ask Elmurat" lines and message. */
export function groupCells(grid: ActsGrid, pick: (c: ActCell) => boolean): { groups: AskGroup[]; cells: { flowId: string; period: IsoDate }[] } {
  const groups: AskGroup[] = [];
  const cells: { flowId: string; period: IsoDate }[] = [];
  for (const row of grid.rows) {
    const months = row.cells.filter(pick).map((c) => c.period);
    if (!months.length) continue;
    groups.push({ label: row.flow.label, service: row.flow.service, months });
    for (const period of months) cells.push({ flowId: row.flow.id, period });
  }
  return { groups, cells };
}

function assertMonthAllowed(flow: IntercompanyFlow, period: IsoDate, todayIso: IsoDate): void {
  if (period > monthStart(todayIso)) {
    throw new ServiceError("validation", "That month hasn't started yet", { period: ["Future month"] });
  }
  if (period < "2015-01-01") throw new ServiceError("validation", "That month is too far back", { period: ["Too old"] });
  if (flow.since && period < monthStart(flow.since)) {
    throw new ServiceError("validation", `This flow starts in ${monthLong(monthStart(flow.since))}`, {
      period: ["Before the flow started (change its start date if it is wrong)"],
    });
  }
}

export interface ActChange {
  cell: ActCell;
  /** True when something that affects the debts (amount, status) changed. */
  debtChanged: boolean;
}

/**
 * Changes one cell. Fields left out stay as they are. Becoming "requested" records today
 * (or the given date) and who asked; going back to "missing" clears that.
 */
export async function patchAct(ctx: ServiceContext, input: ActPatchInput): Promise<ActChange> {
  assertHoldingAccess(ctx);
  const data = actPatchSchema.parse(input);
  const flow = await loadFlow(ctx.db, data.flowId);
  const todayIso = today(ctx);
  assertMonthAllowed(flow, data.period, todayIso);
  const amount = data.amount === undefined ? undefined : data.amount === null ? null : parseKgs(data.amount);
  if (data.requestedOn && data.requestedOn > todayIso) {
    throw new ServiceError("validation", "“Asked on” can't be in the future", { requestedOn: ["In the future"] });
  }
  if (data.actDate && data.actDate > todayIso) {
    throw new ServiceError("validation", "The act date can't be in the future", { actDate: ["In the future"] });
  }
  await assertFile(ctx.db, data.attachmentFileId);

  let debtChanged = false;
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [cur] = await tx
      .select()
      .from(intercompanyActs)
      .where(and(eq(intercompanyActs.flowId, flow.id), eq(intercompanyActs.period, data.period)))
      .for("update");
    const prevStatus: ActStatusValue = cur?.status ?? "missing";
    const status: ActStatusValue = data.status ?? prevStatus;
    let requestedOn = cur?.requestedOn ?? null;
    let requestedBy = cur?.requestedBy ?? null;
    if (status === "requested" && (prevStatus !== "requested" || data.requestedOn)) {
      requestedOn = data.requestedOn ?? todayIso;
      requestedBy = ctx.user.id;
    } else if (data.requestedOn !== undefined && status !== "missing") {
      requestedOn = data.requestedOn;
    }
    if (status === "missing") {
      requestedOn = null;
      requestedBy = null;
    }
    const next = {
      status,
      requestedOn,
      requestedBy,
      amount: amount === undefined ? (cur?.amount ?? null) : amount === null ? null : amount.toFixed(2),
      actNumber: data.actNumber === undefined ? (cur?.actNumber ?? null) : data.actNumber,
      actDate: data.actDate === undefined ? (cur?.actDate ?? null) : data.actDate,
      note: data.note === undefined ? (cur?.note ?? null) : data.note,
      attachmentFileId: data.attachmentFileId === undefined ? (cur?.attachmentFileId ?? null) : data.attachmentFileId,
      updatedBy: ctx.user.id,
      updatedAt: ctx.now,
    };
    const counted = (a: Pick<IntercompanyAct, "status" | "amount" | "actDate"> | undefined) =>
      a && actCountsAsInvoiced(a.status) && a.amount != null ? `${Number(a.amount)}|${a.actDate ?? ""}` : "";
    debtChanged = counted(cur) !== counted({ status: next.status, amount: next.amount, actDate: next.actDate });
    if (cur) {
      await tx.update(intercompanyActs).set(next).where(eq(intercompanyActs.id, cur.id));
    } else {
      await tx.insert(intercompanyActs).values({ flowId: flow.id, period: data.period, ...next, createdAt: ctx.now });
    }
  });
  const grid = await loadActsGrid(ctx.db, todayIso, { months: [data.period] });
  const cell =
    grid.rows.find((r) => r.flow.id === flow.id)?.cells[0] ??
    // A planned flow is not in the grid: describe the cell directly.
    ({
      flowId: flow.id,
      period: data.period,
      state: "inactive",
      tone: "grey",
      status: data.status ?? null,
      amount: null,
      actNumber: null,
      actDate: null,
      requestedOn: null,
      requestedBy: null,
      note: null,
      attachment: null,
      dueFrom: actDueFrom(data.period, graceDays()),
    } satisfies ActCell);
  if (debtChanged) await syncDebtMetric(ctx.db, ctx.now, ctx.timeZone).catch((err: unknown) => console.error("[holding] debt metric", err));
  return { cell, debtChanged };
}

/**
 * Marks cells as asked: "missing" cells become "requested" today; with `again`, cells
 * already "requested" get today's date (asked again). Returns the cells that changed.
 * Cells in any other state (received, signed, not needed, not expected) are left alone.
 */
export async function markCellsAsked(
  ctx: ServiceContext,
  cells: readonly { flowId: string; period: IsoDate }[],
  mode: "missing" | "again",
): Promise<{ flowId: string; period: IsoDate }[]> {
  assertHoldingAccess(ctx);
  const todayIso = today(ctx);
  const grace = graceDays();
  const flows = new Map(
    (await ctx.db.select().from(intercompanyFlows).where(isNull(intercompanyFlows.archivedAt))).map((f) => [f.id, f]),
  );
  const changed: { flowId: string; period: IsoDate }[] = [];
  // Fixed order: two founders tapping at once lock rows in the same order (no deadlock).
  const sorted = [...cells].sort((a, b) => (a.flowId === b.flowId ? a.period.localeCompare(b.period) : a.flowId.localeCompare(b.flowId)));
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    for (const c of sorted) {
      const flow = flows.get(c.flowId);
      if (!flow) continue;
      const period = monthStart(c.period);
      const [cur] = await tx
        .select()
        .from(intercompanyActs)
        .where(and(eq(intercompanyActs.flowId, flow.id), eq(intercompanyActs.period, period)))
        .for("update");
      const status = cur?.status ?? "missing";
      if (mode === "missing") {
        if (status !== "missing" || expectation(flow, period, todayIso, grace) !== "expected") continue;
      } else if (status !== "requested" || cur?.requestedOn === todayIso) {
        continue;
      }
      const set = { status: "requested" as const, requestedOn: todayIso, requestedBy: ctx.user.id, updatedBy: ctx.user.id, updatedAt: ctx.now };
      if (cur) await tx.update(intercompanyActs).set(set).where(eq(intercompanyActs.id, cur.id));
      else await tx.insert(intercompanyActs).values({ flowId: flow.id, period, ...set, createdAt: ctx.now });
      changed.push({ flowId: flow.id, period });
    }
  });
  return changed;
}

// ---------------------------------------------------------------------------
// Debts
// ---------------------------------------------------------------------------

export interface LedgerEntryView {
  id: string;
  kind: "opening" | "payment";
  debtor: CompanyRef;
  creditor: CompanyRef;
  entryDate: IsoDate;
  amount: number;
  note: string | null;
}

export interface DebtPairView {
  debtor: CompanyRef;
  creditor: CompanyRef;
  amount: number;
}

export interface DebtsView {
  asOf: IsoDate;
  pairs: DebtPairView[];
  total: number;
  /** False when nothing (no акт amount, opening balance or payment) has been entered yet. */
  hasData: boolean;
}

/** Every debt movement: акты received/signed with an amount, opening balances, payments. */
async function loadMovements(db: Db): Promise<DebtMovement[]> {
  const acts = await db
    .select({
      status: intercompanyActs.status,
      amount: intercompanyActs.amount,
      period: intercompanyActs.period,
      actDate: intercompanyActs.actDate,
      from: intercompanyFlows.fromCompanyId,
      to: intercompanyFlows.toCompanyId,
    })
    .from(intercompanyActs)
    .innerJoin(intercompanyFlows, eq(intercompanyFlows.id, intercompanyActs.flowId));
  const entries = await db.select().from(intercompanyLedgerEntries).where(isNull(intercompanyLedgerEntries.archivedAt));
  const out: DebtMovement[] = [];
  for (const a of acts) {
    if (!actCountsAsInvoiced(a.status) || a.amount == null) continue;
    // The provider (from) invoiced the receiver (to): the receiver owes the provider.
    out.push({ debtor: a.to, creditor: a.from, amount: Number(a.amount), date: actLedgerDate(a.period, a.actDate) });
  }
  for (const e of entries) {
    const amount = Number(e.amount);
    out.push({ debtor: e.debtorCompanyId, creditor: e.creditorCompanyId, amount: e.kind === "payment" ? -amount : amount, date: e.entryDate });
  }
  return out;
}

async function computeDebts(db: Db, asOf: IsoDate): Promise<DebtsView> {
  const [movements, cmap] = await Promise.all([loadMovements(db), companyMap(db)]);
  const pairs = netDebts(movements, asOf);
  const ref = (id: string): CompanyRef => cmap.get(id) ?? { id, slug: "", name: "Unknown company", color: "#58645D" };
  return {
    asOf,
    pairs: pairs.map((p) => ({ debtor: ref(p.debtor), creditor: ref(p.creditor), amount: p.amount })),
    total: totalDebt(pairs),
    hasData: movements.some((m) => m.date <= asOf),
  };
}

export async function getDebts(ctx: ServiceContext, asOf?: IsoDate): Promise<DebtsView> {
  assertHoldingAccess(ctx);
  return computeDebts(ctx.db, asOf ?? today(ctx));
}

export async function listLedgerEntries(ctx: ServiceContext, limit = 100): Promise<LedgerEntryView[]> {
  assertHoldingAccess(ctx);
  const [rows, cmap] = await Promise.all([
    ctx.db
      .select()
      .from(intercompanyLedgerEntries)
      .where(isNull(intercompanyLedgerEntries.archivedAt))
      .orderBy(desc(intercompanyLedgerEntries.entryDate), desc(intercompanyLedgerEntries.createdAt))
      .limit(limit),
    companyMap(ctx.db),
  ]);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    debtor: cmap.get(r.debtorCompanyId)!,
    creditor: cmap.get(r.creditorCompanyId)!,
    entryDate: r.entryDate,
    amount: Number(r.amount),
    note: r.note,
  }));
}

/** An opening balance ("debtor owes creditor X as of date") or a payment ("debtor paid creditor X"). */
export async function addLedgerEntry(ctx: ServiceContext, input: LedgerEntryInput): Promise<LedgerEntryView> {
  assertHoldingAccess(ctx);
  const data = ledgerEntrySchema.parse(input);
  if (data.debtorCompanyId === data.creditorCompanyId) {
    throw new ServiceError("validation", "Choose two different companies", { creditorCompanyId: ["Same company"] });
  }
  await assertLiveCompany(ctx.db, data.debtorCompanyId, "debtorCompanyId");
  await assertLiveCompany(ctx.db, data.creditorCompanyId, "creditorCompanyId");
  if (data.entryDate > today(ctx)) throw new ServiceError("validation", "The date can't be in the future", { entryDate: ["In the future"] });
  const amount = parseKgs(data.amount, "amount", { positive: true });
  const [row] = await ctx.db
    .insert(intercompanyLedgerEntries)
    .values({
      kind: data.kind,
      debtorCompanyId: data.debtorCompanyId,
      creditorCompanyId: data.creditorCompanyId,
      entryDate: data.entryDate,
      amount: amount.toFixed(2),
      note: data.note ?? null,
      createdBy: ctx.user.id,
      createdAt: ctx.now,
    })
    .returning({ id: intercompanyLedgerEntries.id });
  await syncDebtMetric(ctx.db, ctx.now, ctx.timeZone).catch((err: unknown) => console.error("[holding] debt metric", err));
  return (await listLedgerEntries(ctx, 1000)).find((e) => e.id === row!.id)!;
}

/** Cancel an entry entered by mistake (archived, never deleted). */
export async function archiveLedgerEntry(ctx: ServiceContext, id: string): Promise<void> {
  assertHoldingAccess(ctx);
  assertValidId(id, "Entry");
  const rows = await ctx.db
    .update(intercompanyLedgerEntries)
    .set({ archivedAt: ctx.now, archivedBy: ctx.user.id })
    .where(and(eq(intercompanyLedgerEntries.id, id), isNull(intercompanyLedgerEntries.archivedAt)))
    .returning({ id: intercompanyLedgerEntries.id });
  if (!rows.length) throw new ServiceError("not_found", "Entry not found");
  await syncDebtMetric(ctx.db, ctx.now, ctx.timeZone).catch((err: unknown) => console.error("[holding] debt metric", err));
}

export interface DebtMetricSync {
  action: "created" | "updated" | "unchanged" | "conflict" | "skipped";
  period?: IsoDate;
  value?: number;
  reason?: string;
}

/**
 * Feeds the Holding metric "Intercompany debt total" for the latest finished month with
 * the total as of that month's last day (source "derived"). Writes nothing while no debt
 * data exists, and never replaces a number a founder entered or uploaded for that month
 * (same rule as connectors: the founder's number wins).
 */
export async function syncDebtMetric(db: Db, now: Date, timeZone: string): Promise<DebtMetricSync> {
  const todayIso = todayInTimeZone(now, timeZone);
  const [metric] = await db
    .select({ id: metricDefinitions.id })
    .from(metricDefinitions)
    .innerJoin(companies, eq(companies.id, metricDefinitions.companyId))
    .where(
      and(
        eq(companies.slug, HOLDING_COMPANY_SLUG),
        eq(metricDefinitions.key, DEBT_METRIC_KEY),
        isNull(metricDefinitions.archivedAt),
        eq(metricDefinitions.granularity, "month"),
      ),
    );
  if (!metric) return { action: "skipped", reason: "no_metric" };
  const period = prevPeriod(monthStart(todayIso), "month");
  const debts = await computeDebts(db, periodEnd(period, "month"));
  if (!debts.hasData) return { action: "skipped", reason: "no_data", period };
  const res = await db.transaction((tx) =>
    writeMetricValueTx(tx as unknown as Db, metric.id, period, debts.total, { source: "derived", enteredBy: null, now }),
  );
  return { action: res.action, period, value: debts.total };
}

// ---------------------------------------------------------------------------
// Summary row
// ---------------------------------------------------------------------------

export interface HoldingSummary {
  missingActs: number;
  requestedActs: number;
  contractsExpiring: number;
  totalDebt: number;
  debtHasData: boolean;
}

export async function getHoldingSummary(ctx: ServiceContext): Promise<HoldingSummary> {
  assertHoldingAccess(ctx);
  const [grid, contracts, debts] = await Promise.all([getActsGrid(ctx), listContracts(ctx), getDebts(ctx)]);
  return {
    missingActs: grid.missing,
    requestedActs: grid.requested,
    contractsExpiring: contracts.filter((c) => c.warning).length,
    totalDebt: debts.total,
    debtHasData: debts.hasData,
  };
}

/** Requested more than `days` ago and still not received (for the weekly reminder). */
export function staleRequested(grid: ActsGrid, days: number): (c: ActCell) => boolean {
  const limit = addDays(grid.today, -days);
  return (c) => c.state === "requested" && !!c.requestedOn && c.requestedOn <= limit;
}
