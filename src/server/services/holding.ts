import "server-only";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { cache } from "react";
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
import { decimalPlaces, nextPeriod, parseMetricInput, periodEnd, prevPeriod } from "@/lib/metrics";
import { loadAskPeople, type AskPeopleIndex, type AskPerson } from "@/server/db/ask-person";
import type { Db } from "@/server/db/connect";
import {
  companies,
  holdingAskOverrides,
  holdingFiles,
  intercompanyActs,
  intercompanyContracts,
  intercompanyFlows,
  intercompanyLedgerEntries,
  metricDefinitions,
  metricValues,
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
 * flows, contracts and ledger entries are archived. The app never contacts the people it
 * names ("who to ask" per flow, e.g. Elmurat); it only reminds the founders to ask them
 * (see holding-asks.ts).
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

/**
 * Labels for every company (archived ones too). Once per request (React `cache`, same db handle):
 * the holding page asked five times. Outside a render (actions, API, planner) every call reads.
 */
const companyMap = cache(async (db: Db): Promise<Map<string, CompanyRef>> => {
  const rows = await db
    .select({ id: companies.id, slug: companies.slug, name: companies.name, color: companies.color })
    .from(companies)
    .orderBy(asc(companies.sort));
  return new Map(rows.map((r) => [r.id, r]));
});

/** Every flow row (archived too), once per request — callers filter (never mutate the list). */
const allFlowRows = cache(async (db: Db): Promise<IntercompanyFlow[]> =>
  db.select().from(intercompanyFlows).orderBy(asc(intercompanyFlows.createdAt), asc(intercompanyFlows.id)),
);

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
  /** "Who to ask" for this flow's акты (null = nobody named: generic wording). */
  askPerson: AskPerson | null;
  /** False when the saved person no longer works for either company (then nobody is named). */
  askPersonOk: boolean;
  /** People a founder can pick as "who to ask" (work for one of the two companies). */
  askOptions: AskPerson[];
  /** "Alura Style → Alura Brand" */
  label: string;
  /** "Alura Style → Alura Brand · пошив" */
  fullLabel: string;
}

function flowView(f: IntercompanyFlow, cmap: Map<string, CompanyRef>, ask: AskPeopleIndex): FlowView {
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
    askPerson: ask.person(f.askPersonId),
    askPersonOk: !f.askPersonId || ask.eligible(f, f.askPersonId),
    askOptions: ask.options(f),
    label,
    fullLabel: `${label} · ${f.service}`,
  };
}

async function loadFlows(db: Db, opts: { includeArchived?: boolean; ask?: AskPeopleIndex } = {}): Promise<FlowView[]> {
  const [all, cmap, ask] = await Promise.all([
    allFlowRows(db),
    companyMap(db),
    opts.ask ?? loadAskPeople(db, null),
  ]);
  const rows = opts.includeArchived ? all : all.filter((f) => !f.archivedAt);
  return rows
    .map((f) => flowView(f, cmap, ask))
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
  const ask = await loadAskPeople(ctx.db, null);
  // Left out = the companies' accountant (if any); null = nobody named; else must work there.
  const askPersonId = data.askPersonId === undefined ? ask.defaultFor(data) : data.askPersonId;
  assertAskPerson(ask, data, askPersonId, "askPersonId");
  const [row] = await ctx.db
    .insert(intercompanyFlows)
    .values({
      fromCompanyId: data.fromCompanyId,
      toCompanyId: data.toCompanyId,
      askPersonId,
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
  return flowView(row!, await companyMap(ctx.db), ask);
}

/** "Who to ask" must work (active link, not left, not an app user) for one of the flow's companies. */
function assertAskPerson(
  ask: AskPeopleIndex,
  flow: { fromCompanyId: string; toCompanyId: string },
  personId: string | null,
  field: string,
): void {
  if (personId === null) return;
  if (!ask.eligible(flow, personId)) {
    throw new ServiceError("validation", "Pick someone who works for one of the flow's two companies", {
      [field]: ["Not a person of these companies"],
    });
  }
}

export async function updateFlow(ctx: ServiceContext, id: string, input: FlowUpdateInput): Promise<FlowView> {
  assertHoldingAccess(ctx);
  const flow = await loadFlow(ctx.db, id);
  const data = flowUpdateSchema.parse(input);
  const since = data.since === undefined ? flow.since : data.since;
  const until = data.until === undefined ? flow.until : data.until;
  const status = data.status ?? flow.status;
  checkFlowDates(since, until, status);
  const ask = await loadAskPeople(ctx.db, null);
  // Unchanged (left out) is fine even when that person has since left; a new choice is checked.
  if (data.askPersonId !== undefined && data.askPersonId !== flow.askPersonId) assertAskPerson(ask, flow, data.askPersonId, "askPersonId");
  const [row] = await ctx.db
    .update(intercompanyFlows)
    .set({
      service: data.service ?? flow.service,
      askPersonId: data.askPersonId === undefined ? flow.askPersonId : data.askPersonId,
      description: data.description === undefined ? flow.description : data.description,
      since,
      until,
      status,
      updatedAt: ctx.now,
    })
    .where(eq(intercompanyFlows.id, flow.id))
    .returning()
    .catch(uniqueFlowError);
  return flowView(row!, await companyMap(ctx.db), ask);
}

/**
 * A founder's override of a flow's "who to ask" for this ask round (the current month,
 * YYYY-MM in the business time zone). `personId` null clears it (back to the flow's person).
 * The person must work for one of the flow's two companies.
 */
export async function setAskOverride(ctx: ServiceContext, flowId: string, personId: string | null): Promise<{ roundKey: string }> {
  assertHoldingAccess(ctx);
  const flow = await loadFlow(ctx.db, flowId);
  if (personId !== null) assertValidId(personId, "Person");
  const roundKey = today(ctx).slice(0, 7);
  if (personId === null) {
    await ctx.db.delete(holdingAskOverrides).where(and(eq(holdingAskOverrides.roundKey, roundKey), eq(holdingAskOverrides.flowId, flow.id)));
    return { roundKey };
  }
  assertAskPerson(await loadAskPeople(ctx.db, null), flow, personId, "personId");
  await ctx.db
    .insert(holdingAskOverrides)
    .values({ roundKey, flowId: flow.id, personId, setBy: ctx.user.id, createdAt: ctx.now, updatedAt: ctx.now })
    .onConflictDoUpdate({
      target: [holdingAskOverrides.roundKey, holdingAskOverrides.flowId],
      set: { personId, setBy: ctx.user.id, updatedAt: ctx.now },
    });
  return { roundKey };
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

/**
 * Checks an attachment exists and marks it attached (so the 24 h cleanup of unattached
 * uploads never touches it). Marking just before the акт / contract is saved is harmless
 * if that save then fails: the file is merely kept.
 */
async function assertFile(db: Db, id: string | null | undefined, now: Date): Promise<void> {
  if (!id) return;
  const [row] = await db
    .update(holdingFiles)
    .set({ attachedAt: sql`coalesce(${holdingFiles.attachedAt}, ${now.toISOString()}::timestamptz)` })
    .where(and(eq(holdingFiles.id, id), isNull(holdingFiles.archivedAt)))
    .returning({ id: holdingFiles.id });
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
  await assertFile(ctx.db, data.attachmentFileId, ctx.now);
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
  await assertFile(ctx.db, data.attachmentFileId, ctx.now);
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
  /**
   * Who the founders' messages name for this month: for an акт already asked for, the person
   * asked; otherwise this round's override or the flow's "who to ask". Null = nobody named.
   */
  askPerson: AskPerson | null;
}

export interface ActsGrid {
  today: IsoDate;
  graceDays: number;
  months: { period: IsoDate; label: string; current: boolean }[];
  rows: ActsGridRow[];
  /** Missing cells, the older months before the grid included. */
  missing: number;
  requested: number;
}

export interface ActsGridRow {
  flow: FlowView;
  cells: ActCell[];
  /**
   * Months before the grid's first month (back to the flow's start) that still need
   * something: missing or requested. Not drawn as columns; the row shows "N older missing"
   * and the ask / reminder include them, so they are never silently forgotten.
   */
  older: ActCell[];
  /** "Who to ask" for this flow's missing акты this round, and whether a founder overrode it. */
  ask: { person: AskPerson | null; overridden: boolean; flowPerson: AskPerson | null; options: AskPerson[] };
}

/** Every cell of a row that can be asked about: older months first, then the grid's. */
export function rowCells(row: Pick<ActsGridRow, "cells" | "older">): ActCell[] {
  return [...row.older, ...row.cells];
}

export function allGridCells(grid: Pick<ActsGrid, "rows">): ActCell[] {
  return grid.rows.flatMap(rowCells);
}

interface GridOpts {
  months?: IsoDate[];
  grace?: number;
}

/** No flow starts before this (checkFlowDates), so older months are bounded. */
const OLDEST_MONTH = "2015-01-01";

/** The grid for any reader (service context or planner). Rows = active flows. */
export async function loadActsGrid(db: Db, todayIso: IsoDate, opts: GridOpts = {}): Promise<ActsGrid> {
  const grace = opts.grace ?? graceDays();
  const months = opts.months ?? gridMonths(todayIso);
  const askIndex = await loadAskPeople(db, todayIso.slice(0, 7));
  const flowRows = new Map((await allFlowRows(db)).filter((f) => !f.archivedAt).map((f) => [f.id, f]));
  const flows = (await loadFlows(db, { ask: askIndex })).filter((f) => f.status === "active");
  // The default grid also looks at the months before it (see ActsGridRow.older); a grid
  // for given months (one cell after a change) does not.
  const withOlder = !opts.months;
  const earliest = withOlder
    ? flows.reduce<IsoDate>((min, f) => (f.since && monthStart(f.since) < min ? monthStart(f.since) : min), months[0]!)
    : months[0]!;
  const from = earliest < OLDEST_MONTH ? OLDEST_MONTH : earliest;
  const acts = flows.length
    ? await db
        .select()
        .from(intercompanyActs)
        .where(
          and(
            inArray(intercompanyActs.flowId, flows.map((f) => f.id)),
            gte(intercompanyActs.period, from),
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
  const cellFor = (flow: FlowView, period: IsoDate): ActCell => {
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
      askPerson: (() => {
        const raw = flowRows.get(flow.id);
        if (!raw) return null;
        return state === "requested" ? askIndex.forRequested(raw, a?.requestedPersonId ?? null) : askIndex.forMissing(raw);
      })(),
    };
  };
  const rows = flows.map((flow): ActsGridRow => {
    const older: ActCell[] = [];
    if (withOlder && flow.since) {
      for (let p = monthStart(flow.since) < from ? from : monthStart(flow.since); p < months[0]!; p = nextPeriod(p, "month")) {
        const exp = expectation(flow, p, todayIso, grace);
        const recorded = byKey.get(`${flow.id}|${p}`)?.status ?? null;
        const state = cellState(recorded, exp);
        if (state === "missing" || state === "requested") older.push(cellFor(flow, p));
      }
    }
    const raw = flowRows.get(flow.id)!;
    const override = askIndex.override(raw);
    return {
      flow,
      older,
      cells: months.map((period) => cellFor(flow, period)),
      ask: { person: askIndex.forMissing(raw), overridden: !!override, flowPerson: flow.askPersonOk ? flow.askPerson : null, options: flow.askOptions },
    };
  });
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

/** Cells grouped per flow, for the ask lines and messages. */
export function groupCells(grid: ActsGrid, pick: (c: ActCell) => boolean): { groups: AskGroup[]; cells: { flowId: string; period: IsoDate }[] } {
  const groups: AskGroup[] = [];
  const cells: { flowId: string; period: IsoDate }[] = [];
  for (const row of grid.rows) {
    const months = rowCells(row).filter(pick).map((c) => c.period);
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

/**
 * An archived flow's акты still count in the debts (an акт is a real invoice), so a wrong
 * amount must stay correctable: on an archived flow a founder may change an акт that is
 * already recorded — its status (not "requested": nobody asks Elmurat about an archived
 * flow), amount and act date (the date decides which month the debt counts from). Anything
 * else needs the flow restored first.
 */
const ARCHIVED_EDITABLE = new Set(["flowId", "period", "status", "amount", "actDate"]);
function assertArchivedCorrection(data: ReturnType<typeof actPatchSchema.parse>): void {
  const other = Object.entries(data).filter(([k, v]) => v !== undefined && !ARCHIVED_EDITABLE.has(k));
  if (other.length) {
    throw new ServiceError("validation", "This flow is archived: only the status, amount and act date of its акты can be corrected", Object.fromEntries(other.map(([k]) => [k, ["Restore the flow to change this"]])));
  }
  if (data.status === "requested") {
    throw new ServiceError("validation", "This flow is archived: there is nothing to ask Elmurat for", { status: ["Not for an archived flow"] });
  }
}

/** Recorded акты of archived flows (they still count in the debts), for corrections. */
export interface ArchivedFlowAct {
  flowId: string;
  period: IsoDate;
  status: ActStatusValue;
  amount: number | null;
  actDate: IsoDate | null;
}

export async function listArchivedFlowActs(ctx: ServiceContext): Promise<ArchivedFlowAct[]> {
  assertHoldingAccess(ctx);
  const rows = await ctx.db
    .select({
      flowId: intercompanyActs.flowId,
      period: intercompanyActs.period,
      status: intercompanyActs.status,
      amount: intercompanyActs.amount,
      actDate: intercompanyActs.actDate,
    })
    .from(intercompanyActs)
    .innerJoin(intercompanyFlows, eq(intercompanyFlows.id, intercompanyActs.flowId))
    .where(isNotNull(intercompanyFlows.archivedAt))
    .orderBy(asc(intercompanyActs.flowId), desc(intercompanyActs.period));
  return rows.map((r) => ({ ...r, amount: r.amount != null ? Number(r.amount) : null }));
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
  const flow = await loadFlow(ctx.db, data.flowId, { allowArchived: true });
  if (flow.archivedAt) assertArchivedCorrection(data);
  const todayIso = today(ctx);
  assertMonthAllowed(flow, data.period, todayIso);
  const amount = data.amount === undefined ? undefined : data.amount === null ? null : parseKgs(data.amount);
  if (data.requestedOn && data.requestedOn > todayIso) {
    throw new ServiceError("validation", "“Asked on” can't be in the future", { requestedOn: ["In the future"] });
  }
  if (data.actDate && data.actDate > todayIso) {
    throw new ServiceError("validation", "The act date can't be in the future", { actDate: ["In the future"] });
  }
  await assertFile(ctx.db, data.attachmentFileId, ctx.now);

  let debtChanged = false;
  let affectedFrom: IsoDate | null = null;
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [cur] = await tx
      .select()
      .from(intercompanyActs)
      .where(and(eq(intercompanyActs.flowId, flow.id), eq(intercompanyActs.period, data.period)))
      .for("update");
    if (flow.archivedAt && !cur) {
      throw new ServiceError("validation", "This flow is archived: only акты already recorded can be corrected (restore the flow to add more)");
    }
    const prevStatus: ActStatusValue = cur?.status ?? "missing";
    const status: ActStatusValue = data.status ?? prevStatus;
    let requestedOn = cur?.requestedOn ?? null;
    let requestedBy = cur?.requestedBy ?? null;
    let requestedPersonId = cur?.requestedPersonId ?? null;
    if (status === "requested" && (prevStatus !== "requested" || data.requestedOn)) {
      requestedOn = data.requestedOn ?? todayIso;
      requestedBy = ctx.user.id;
      if (prevStatus !== "requested") requestedPersonId = (await loadAskPeople(tx, todayIso.slice(0, 7))).forMissing(flow)?.id ?? null;
    } else if (data.requestedOn !== undefined && status !== "missing") {
      requestedOn = data.requestedOn;
    }
    if (status === "missing") {
      requestedOn = null;
      requestedBy = null;
      requestedPersonId = null;
    }
    const next = {
      status,
      requestedOn,
      requestedBy,
      requestedPersonId,
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
    // The earliest month whose debt total this change can touch (old or new ledger date).
    affectedFrom = [data.period, cur?.actDate, next.actDate]
      .filter((d): d is IsoDate => !!d)
      .map(monthStart)
      .sort()[0]!;
    if (cur) {
      await tx.update(intercompanyActs).set(next).where(eq(intercompanyActs.id, cur.id));
    } else {
      const ins = await tx
        .insert(intercompanyActs)
        .values({ flowId: flow.id, period: data.period, ...next, createdAt: ctx.now })
        .onConflictDoNothing({ target: [intercompanyActs.flowId, intercompanyActs.period] })
        .returning({ id: intercompanyActs.id });
      if (!ins.length) {
        throw new ServiceError("conflict", "Someone else changed this акт at the same moment, so nothing was saved. Please try again.");
      }
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
      askPerson: null,
    } satisfies ActCell);
  if (debtChanged && affectedFrom) await syncDebtMetricSafe(ctx, affectedFrom);
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
  const ask = await loadAskPeople(ctx.db, todayIso.slice(0, 7));
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
      // Who was asked: this round's "who to ask" (asked again: the same person, if still there).
      const requestedPersonId = (mode === "again" ? ask.forRequested(flow, cur?.requestedPersonId ?? null) : ask.forMissing(flow))?.id ?? null;
      const set = { status: "requested" as const, requestedOn: todayIso, requestedBy: ctx.user.id, requestedPersonId, updatedBy: ctx.user.id, updatedAt: ctx.now };
      if (cur) {
        await tx.update(intercompanyActs).set(set).where(eq(intercompanyActs.id, cur.id));
      } else {
        // The other founder may have created this cell at the same moment: then it is done.
        const ins = await tx
          .insert(intercompanyActs)
          .values({ flowId: flow.id, period, ...set, createdAt: ctx.now })
          .onConflictDoNothing({ target: [intercompanyActs.flowId, intercompanyActs.period] })
          .returning({ id: intercompanyActs.id });
        if (!ins.length) continue;
      }
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
  await syncDebtMetricSafe(ctx, data.entryDate);
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
    .returning({ id: intercompanyLedgerEntries.id, entryDate: intercompanyLedgerEntries.entryDate });
  if (!rows.length) throw new ServiceError("not_found", "Entry not found");
  await syncDebtMetricSafe(ctx, rows[0]!.entryDate);
}

export interface DebtMonthSync {
  period: IsoDate;
  action: "created" | "updated" | "unchanged" | "conflict" | "skipped";
  value?: number;
  reason?: string;
}

export interface DebtMetricSync {
  /** The result for the latest finished month (the one the KPI card shows). */
  action: DebtMonthSync["action"];
  period?: IsoDate;
  value?: number;
  reason?: string;
  /** Every month looked at, oldest first. */
  months?: DebtMonthSync[];
}

/**
 * Feeds the Holding metric "Intercompany debt total" (source "derived"): each month's value
 * is the total as of that month's last day. By default only the latest finished month is
 * written (the scheduler tick). After a debt change (an акт's amount / status / date, a
 * payment or opening balance, an archived entry) the caller passes `fromMonth` — the
 * earliest month the change touches — and every month from there up to the latest
 * finished month is recomputed, so a late акт for September also corrects October.
 *
 * Rules: only rows whose current value is "derived" (or months without a value) are
 * written; a number a founder entered or uploaded (or a connector's) is never replaced
 * (reported as "conflict" when it differs). A month with no debt data at all is left
 * empty — unless it already had a derived value (e.g. every entry was archived since):
 * then 0 is written, a new version with history, so the card never keeps showing a stale
 * total. (0 rather than deleting the row: metric values are never deleted, and "no
 * recorded debt" is exactly what 0 says.)
 */
export async function syncDebtMetric(db: Db, now: Date, timeZone: string, opts: { fromMonth?: IsoDate } = {}): Promise<DebtMetricSync> {
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
  const last = prevPeriod(monthStart(todayIso), "month");
  let first = opts.fromMonth ? monthStart(opts.fromMonth) : last;
  if (first > last) first = last;
  if (first < OLDEST_MONTH) first = OLDEST_MONTH;
  const periods: IsoDate[] = [];
  for (let p = first; p <= last; p = nextPeriod(p, "month")) periods.push(p);

  const movements = await loadMovements(db);
  const months = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const currents = new Map(
      (
        await tx
          .select({ period: metricValues.periodStart, value: metricValues.value, source: metricValues.source })
          .from(metricValues)
          .where(and(eq(metricValues.metricId, metric.id), eq(metricValues.isCurrent, true), eq(metricValues.periodKind, "period"), gte(metricValues.periodStart, first), lte(metricValues.periodStart, last)))
      ).map((r) => [r.period, r]),
    );
    const out: DebtMonthSync[] = [];
    for (const period of periods) {
      const end = periodEnd(period, "month");
      const hasData = movements.some((m) => m.date <= end);
      const cur = currents.get(period);
      if (!hasData && cur?.source !== "derived") {
        out.push({ period, action: "skipped", reason: "no_data" });
        continue;
      }
      const value = hasData ? totalDebt(netDebts(movements, end)) : 0;
      if (cur && cur.source !== "derived") {
        out.push({ period, action: Number(cur.value) === value ? "unchanged" : "conflict", value, reason: `kept_${cur.source}` });
        continue;
      }
      const res = await writeMetricValueTx(tx, metric.id, period, value, { source: "derived", enteredBy: null, now });
      out.push({ period, action: res.action, value, ...(hasData ? {} : { reason: "no_data_cleared" }) });
    }
    return out;
  });
  const latest = months[months.length - 1]!;
  return { ...latest, months };
}

/** Logs instead of failing the founder's save: the metric is a convenience copy. */
function syncDebtMetricSafe(ctx: ServiceContext, fromMonth: IsoDate): Promise<unknown> {
  return syncDebtMetric(ctx.db, ctx.now, ctx.timeZone, { fromMonth }).catch((err: unknown) => console.error("[holding] debt metric", err));
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
