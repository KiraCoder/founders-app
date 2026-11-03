import "server-only";
import { and, asc, desc, eq, inArray, isNull, max, notInArray, sql } from "drizzle-orm";
import {
  departmentCreateSchema,
  departmentMoveSchema,
  departmentPatchSchema,
  deptLabel,
  divisionDisplayRank,
  divisionPatchSchema,
  functionCreateSchema,
  functionMoveSchema,
  functionPatchSchema,
  orgExpertFindings,
  placeAt,
  VYSOTSKY_TEMPLATE,
  VYSOTSKY_TEMPLATE_KEY,
  type DepartmentPatch,
  type DivisionPatch,
  type FunctionPatch,
  type OrgFinding,
  type TemplateDivision,
} from "@/lib/org";
import type { Db } from "@/server/db/connect";
import {
  companies,
  companyUnits,
  orgChangeLog,
  orgCharts,
  orgDepartments,
  orgDivisions,
  orgFunctions,
  people,
  personCompanies,
  tasks,
  users,
  type OrgChart,
  type OrgDepartment,
  type OrgDivision,
  type OrgFunction,
} from "@/server/db/schema";
import { assertOrgEdit, assertOrgRead, assertValidId, inAccessibleCompany, visibleTasksWhere } from "./access";
import { today, type ServiceContext } from "./context";
import { ServiceError } from "./errors";
import { buildMetricCards, listMetricDefinitions } from "./metrics";
import { CLOSED_STATUSES } from "./tasks-rules";
import { createChartFromTemplate } from "@/server/db/org-charts";

export { createChartFromTemplate };

/**
 * Org structure service (C3b). One chart per company (optionally per company unit), 7
 * divisions, departments, functions. Rules:
 * - company isolation: every org row carries company_id; reads/writes check the company
 *   (`assertOrgRead` / `assertOrgEdit`), moves stay inside ONE chart, and people / numbers
 *   linked to a row must belong to that row's company — forged ids are "not found";
 * - nothing is deleted: departments and functions are archived and restored;
 * - every change runs in one transaction that locks the chart row (edits of one chart never
 *   interleave), rewrites `sort` as 0, 1, 2, … for every list it touched, and writes one
 *   org_change_log row (who / when / before / after);
 * - Undo takes back the newest change that is not undone yet, among the chart's last
 *   UNDO_DEPTH changes, one at a time (an undo is logged too and is not itself undoable).
 */

export const UNDO_DEPTH = 20;
const UNDOABLE = ["create", "update", "move", "archive", "restore"] as const;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface OrgFunctionView {
  id: string;
  departmentId: string;
  text: string;
  responsiblePersonId: string | null;
  responsibleName: string | null;
  archived: boolean;
}

export interface OrgDepartmentView {
  id: string;
  divisionId: string;
  number: number;
  name: string;
  nameIsDefault: boolean;
  ckp: string;
  statistic: string;
  metricDefinitionId: string | null;
  headPersonId: string | null;
  headName: string | null;
  archived: boolean;
  functions: OrgFunctionView[];
  /** Archived functions (only with includeArchived). */
  archivedFunctions: OrgFunctionView[];
  openTasks: number;
  overdueTasks: number;
}

export interface OrgDivisionView {
  id: string;
  number: number;
  name: string;
  nameIsDefault: boolean;
  headTitle: string;
  reportsTo: string;
  ckp: string;
  headPersonId: string | null;
  headName: string | null;
  departments: OrgDepartmentView[];
  archivedDepartments: OrgDepartmentView[];
}

export interface OrgHistoryEntry {
  id: string;
  action: string;
  summary: string;
  actorName: string | null;
  at: string;
  undone: boolean;
}

export interface OrgChartView {
  id: string;
  companyId: string;
  companyUnitId: string | null;
  templateKey: string;
  divisions: OrgDivisionView[];
  /** What Undo would take back now (null = nothing). */
  undo: { id: string; summary: string } | null;
  /** Changes Undo can still take back (at most UNDO_DEPTH). */
  undoAvailable: number;
  history: OrgHistoryEntry[];
  /** Changes with every change (so a client can tell its copy is stale). */
  version: string;
}

export interface OrgScope {
  companyId: string;
  companyUnitId: string | null;
}

const personName = sql<string>`coalesce(${people.shortName}, ${people.fullName})`;

async function namesFor(db: Db, ids: (string | null)[]): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return new Map();
  const rows = await db.select({ id: people.id, name: personName }).from(people).where(inArray(people.id, list));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function findChart(db: Db, scope: OrgScope): Promise<OrgChart | null> {
  const [row] = await db
    .select()
    .from(orgCharts)
    .where(
      and(
        eq(orgCharts.companyId, scope.companyId),
        scope.companyUnitId ? eq(orgCharts.companyUnitId, scope.companyUnitId) : isNull(orgCharts.companyUnitId),
        isNull(orgCharts.archivedAt),
      ),
    );
  return row ?? null;
}

/** Charts of a company: the whole-company one (unit null) and any per-unit ones. */
export async function listOrgCharts(ctx: ServiceContext, companyId: string): Promise<{ id: string; companyUnitId: string | null }[]> {
  await assertOrgRead(ctx, companyId);
  return ctx.db
    .select({ id: orgCharts.id, companyUnitId: orgCharts.companyUnitId })
    .from(orgCharts)
    .where(and(eq(orgCharts.companyId, companyId), isNull(orgCharts.archivedAt)));
}

/** Open / overdue tasks per department, as this user sees tasks. */
async function departmentTaskCounts(ctx: ServiceContext, departmentIds: string[]): Promise<Map<string, { open: number; overdue: number }>> {
  if (!departmentIds.length) return new Map();
  const todayIso = today(ctx);
  const rows = await ctx.db
    .select({
      id: tasks.orgDepartmentId,
      open: sql<number>`count(*)`.mapWith(Number),
      overdue: sql<number>`count(*) filter (where ${tasks.dueDate} < ${todayIso})`.mapWith(Number),
    })
    .from(tasks)
    .where(and(visibleTasksWhere(ctx), inArray(tasks.orgDepartmentId, departmentIds), notInArray(tasks.status, [...CLOSED_STATUSES])))
    .groupBy(tasks.orgDepartmentId);
  return new Map(rows.filter((r) => r.id).map((r) => [r.id!, { open: r.open, overdue: r.overdue }]));
}

/**
 * The chart of a company (or of one of its units) with divisions in display order (7, 1, …
 * 6), departments and functions in their order; null when there is no chart yet.
 */
export async function getOrgChart(ctx: ServiceContext, scope: OrgScope, opts: { includeArchived?: boolean } = {}): Promise<OrgChartView | null> {
  await assertOrgRead(ctx, scope.companyId);
  if (scope.companyUnitId) assertValidId(scope.companyUnitId, "Unit");
  const chart = await findChart(ctx.db, scope);
  if (!chart) return null;
  return loadChartView(ctx, chart, opts);
}

export async function getOrgChartById(ctx: ServiceContext, chartId: unknown, opts: { includeArchived?: boolean } = {}): Promise<OrgChartView> {
  assertValidId(chartId, "Org chart");
  const [chart] = await ctx.db.select().from(orgCharts).where(and(eq(orgCharts.id, chartId), isNull(orgCharts.archivedAt)));
  if (!chart) throw new ServiceError("not_found", "Org chart not found");
  await assertOrgRead(ctx, chart.companyId);
  return loadChartView(ctx, chart, opts);
}

async function loadChartView(ctx: ServiceContext, chart: OrgChart, opts: { includeArchived?: boolean }): Promise<OrgChartView> {
  const [divs, depts, fns] = await Promise.all([
    ctx.db.select().from(orgDivisions).where(and(eq(orgDivisions.chartId, chart.id), isNull(orgDivisions.archivedAt))),
    ctx.db.select().from(orgDepartments).where(eq(orgDepartments.chartId, chart.id)).orderBy(asc(orgDepartments.sort), asc(orgDepartments.number)),
    ctx.db.select().from(orgFunctions).where(eq(orgFunctions.chartId, chart.id)).orderBy(asc(orgFunctions.sort), asc(orgFunctions.createdAt)),
  ]);
  const names = await namesFor(ctx.db, [...divs.map((d) => d.headPersonId), ...depts.map((d) => d.headPersonId), ...fns.map((f) => f.responsiblePersonId)]);
  const counts = await departmentTaskCounts(ctx, depts.map((d) => d.id));
  const fnView = (f: OrgFunction): OrgFunctionView => ({
    id: f.id,
    departmentId: f.departmentId,
    text: f.text,
    responsiblePersonId: f.responsiblePersonId,
    responsibleName: f.responsiblePersonId ? (names.get(f.responsiblePersonId) ?? null) : null,
    archived: !!f.archivedAt,
  });
  const deptView = (d: OrgDepartment): OrgDepartmentView => {
    const own = fns.filter((f) => f.departmentId === d.id);
    return {
      id: d.id,
      divisionId: d.divisionId,
      number: d.number,
      name: d.name,
      nameIsDefault: d.nameIsDefault,
      ckp: d.ckp,
      statistic: d.statistic,
      metricDefinitionId: d.metricDefinitionId,
      headPersonId: d.headPersonId,
      headName: d.headPersonId ? (names.get(d.headPersonId) ?? null) : null,
      archived: !!d.archivedAt,
      functions: own.filter((f) => !f.archivedAt).map(fnView),
      archivedFunctions: opts.includeArchived ? own.filter((f) => f.archivedAt).map(fnView) : [],
      openTasks: counts.get(d.id)?.open ?? 0,
      overdueTasks: counts.get(d.id)?.overdue ?? 0,
    };
  };
  const divisions = [...divs]
    .sort((a, b) => divisionDisplayRank(a.number) - divisionDisplayRank(b.number))
    .map((v) => {
      const own = depts.filter((d) => d.divisionId === v.id);
      return {
        id: v.id,
        number: v.number,
        name: v.name,
        nameIsDefault: v.nameIsDefault,
        headTitle: v.headTitle,
        reportsTo: v.reportsTo,
        ckp: v.ckp,
        headPersonId: v.headPersonId,
        headName: v.headPersonId ? (names.get(v.headPersonId) ?? null) : null,
        departments: own.filter((d) => !d.archivedAt).map(deptView),
        archivedDepartments: opts.includeArchived ? own.filter((d) => d.archivedAt).map(deptView) : [],
      };
    });
  const log = await ctx.db
    .select({ row: orgChangeLog, actorName: users.shortName })
    .from(orgChangeLog)
    .leftJoin(users, eq(users.id, orgChangeLog.actorUserId))
    .where(eq(orgChangeLog.chartId, chart.id))
    .orderBy(desc(orgChangeLog.seq))
    .limit(UNDO_DEPTH);
  const window = await undoWindow(ctx.db, chart.id);
  const next = window.find((r) => !r.undoneAt) ?? null;
  return {
    id: chart.id,
    companyId: chart.companyId,
    companyUnitId: chart.companyUnitId,
    templateKey: chart.templateKey,
    divisions,
    undo: next ? { id: next.id, summary: next.summary } : null,
    undoAvailable: window.filter((r) => !r.undoneAt).length,
    history: log.map(({ row, actorName }) => ({
      id: row.id,
      action: row.action,
      summary: row.summary,
      actorName: actorName ?? null,
      at: row.createdAt.toISOString(),
      undone: !!row.undoneAt,
    })),
    version: String(log[0]?.row.seq ?? 0),
  };
}

/** The chart's newest UNDO_DEPTH undoable changes (undone ones included), newest first. */
async function undoWindow(db: Db, chartId: string) {
  return db
    .select()
    .from(orgChangeLog)
    .where(and(eq(orgChangeLog.chartId, chartId), inArray(orgChangeLog.action, [...UNDOABLE])))
    .orderBy(desc(orgChangeLog.seq))
    .limit(UNDO_DEPTH);
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

/** People who can head a division / department or be responsible for a function: active people of that company. */
export async function orgPeopleOptions(ctx: ServiceContext, companyId: string): Promise<{ id: string; name: string; role: string }[]> {
  await assertOrgRead(ctx, companyId);
  const rows = await ctx.db
    .select({ id: people.id, name: personName, role: personCompanies.role, title: personCompanies.title })
    .from(personCompanies)
    .innerJoin(people, eq(people.id, personCompanies.personId))
    .where(and(eq(personCompanies.companyId, companyId), eq(personCompanies.isActive, true), isNull(people.leftAt)))
    .orderBy(asc(people.fullName));
  const out: { id: string; name: string; role: string }[] = [];
  for (const r of rows) if (!out.some((p) => p.id === r.id)) out.push({ id: r.id, name: r.name, role: r.title ?? r.role });
  return out;
}

/** Departments per company for the task form ("21 Отдел владельца"), active charts only. */
export async function orgDepartmentOptionsByCompany(ctx: ServiceContext): Promise<Record<string, { id: string; label: string }[]>> {
  const rows = await ctx.db
    .select({ id: orgDepartments.id, companyId: orgDepartments.companyId, number: orgDepartments.number, name: orgDepartments.name, unitName: companyUnits.name })
    .from(orgDepartments)
    .innerJoin(orgCharts, eq(orgCharts.id, orgDepartments.chartId))
    .leftJoin(companyUnits, eq(companyUnits.id, orgCharts.companyUnitId))
    .innerJoin(companies, eq(companies.id, orgDepartments.companyId))
    .where(and(isNull(orgDepartments.archivedAt), isNull(orgCharts.archivedAt), isNull(companies.archivedAt), inAccessibleCompany(ctx, orgDepartments.companyId)))
    .orderBy(asc(orgDepartments.number));
  const out: Record<string, { id: string; label: string }[]> = {};
  for (const r of rows) (out[r.companyId] ??= []).push({ id: r.id, label: `${deptLabel(r)}${r.unitName ? ` · ${r.unitName}` : ""}` });
  return out;
}

/** The department a task may point at: live, of the task's company. Throws a validation error otherwise. */
export async function assertTaskDepartment(ctx: ServiceContext, departmentId: string, companyId: string | null): Promise<void> {
  const fail = () => new ServiceError("validation", "This department is not part of the task's company", { orgDepartmentId: ["Pick a department of the task's company"] });
  if (!companyId) throw new ServiceError("validation", "Pick a company before choosing a department", { orgDepartmentId: ["Needs a company"] });
  assertValidId(departmentId, "Department");
  const [row] = await ctx.db
    .select({ companyId: orgDepartments.companyId })
    .from(orgDepartments)
    .innerJoin(orgCharts, eq(orgCharts.id, orgDepartments.chartId))
    .where(and(eq(orgDepartments.id, departmentId), isNull(orgDepartments.archivedAt), isNull(orgCharts.archivedAt)));
  if (!row || row.companyId !== companyId) throw fail();
}

/** Department panel extras: the linked number's latest value and freshness (C4). */
export async function departmentMetric(ctx: ServiceContext, departmentId: unknown) {
  const dept = await loadDepartment(ctx.db, departmentId);
  await assertOrgRead(ctx, dept.companyId);
  if (!dept.metricDefinitionId) return null;
  const defs = (await listMetricDefinitions(ctx, dept.companyId)).filter((d) => d.id === dept.metricDefinitionId);
  const [card] = await buildMetricCards(ctx, defs);
  return card ?? null;
}

// ---------------------------------------------------------------------------
// Creating charts (template, seed)
// ---------------------------------------------------------------------------

/** "Apply Vysotsky template" for a company (or unit) without a chart. */
export async function applyVysotskyTemplate(ctx: ServiceContext, scope: OrgScope): Promise<OrgChartView> {
  await assertOrgEdit(ctx, scope.companyId);
  if (scope.companyUnitId) {
    assertValidId(scope.companyUnitId, "Unit");
    const [unit] = await ctx.db
      .select({ id: companyUnits.id })
      .from(companyUnits)
      .where(and(eq(companyUnits.id, scope.companyUnitId), eq(companyUnits.companyId, scope.companyId), isNull(companyUnits.archivedAt)));
    if (!unit) throw new ServiceError("not_found", "Unit not found");
  }
  const id = await createChartFromTemplate(ctx.db, {
    ...scope,
    templateKey: VYSOTSKY_TEMPLATE_KEY,
    divisions: VYSOTSKY_TEMPLATE,
    actorUserId: ctx.user.id,
    action: "apply_template",
    summary: "Applied the Vysotsky 7/21 template",
    now: ctx.now,
  });
  return getOrgChartById(ctx, id);
}

// ---------------------------------------------------------------------------
// Loading rows for a change (always re-checked against the company)
// ---------------------------------------------------------------------------

async function loadDepartment(db: Db, id: unknown): Promise<OrgDepartment> {
  assertValidId(id, "Department");
  const [row] = await db.select().from(orgDepartments).where(eq(orgDepartments.id, id));
  if (!row) throw new ServiceError("not_found", "Department not found");
  return row;
}

async function loadDivision(db: Db, id: unknown): Promise<OrgDivision> {
  assertValidId(id, "Division");
  const [row] = await db.select().from(orgDivisions).where(and(eq(orgDivisions.id, id), isNull(orgDivisions.archivedAt)));
  if (!row) throw new ServiceError("not_found", "Division not found");
  return row;
}

async function loadFunction(db: Db, id: unknown): Promise<OrgFunction> {
  assertValidId(id, "Function");
  const [row] = await db.select().from(orgFunctions).where(eq(orgFunctions.id, id));
  if (!row) throw new ServiceError("not_found", "Function not found");
  return row;
}

/** Locks the chart row for the rest of the transaction (serialises edits of one chart). */
async function lockChart(tx: Db, chartId: string): Promise<void> {
  const res = await tx.execute(sql`select id from org_charts where id = ${chartId} and archived_at is null for update`);
  const rows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows) ?? [];
  if (!rows.length) throw new ServiceError("not_found", "Org chart not found");
}

/** A person may be linked to a row only when they actively work for that company. */
async function assertCompanyPerson(db: Db, companyId: string, personId: string, field: string): Promise<void> {
  assertValidId(personId, "Person");
  const [row] = await db
    .select({ id: people.id })
    .from(personCompanies)
    .innerJoin(people, eq(people.id, personCompanies.personId))
    .where(and(eq(personCompanies.personId, personId), eq(personCompanies.companyId, companyId), eq(personCompanies.isActive, true), isNull(people.leftAt)))
    .limit(1);
  if (!row) throw new ServiceError("validation", "This person does not work for this company", { [field]: ["Pick someone from this company's people"] });
}

async function assertCompanyMetric(ctx: ServiceContext, companyId: string, metricId: string): Promise<void> {
  assertValidId(metricId, "Number");
  const defs = await listMetricDefinitions(ctx, companyId);
  if (!defs.some((d) => d.id === metricId)) {
    throw new ServiceError("validation", "This number is not tracked for this company", { metricDefinitionId: ["Pick one of this company's numbers"] });
  }
}

interface LogInput {
  entity: "division" | "department" | "function";
  entityId: string;
  action: (typeof UNDOABLE)[number];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  summary: string;
}

async function writeLog(tx: Db, ctx: ServiceContext, chartId: string, companyId: string, log: LogInput): Promise<void> {
  await tx.update(orgCharts).set({ updatedAt: ctx.now }).where(eq(orgCharts.id, chartId));
  await tx.insert(orgChangeLog).values({ chartId, companyId, actorUserId: ctx.user.id, ...log, createdAt: ctx.now });
}

const quote = (s: string) => `“${s.length > 60 ? `${s.slice(0, 57)}…` : s}”`;

/** Rewrites sort = 0, 1, 2, … for the live functions of a department, in the given order. */
async function writeFunctionOrder(tx: Db, ids: string[], departmentId: string, now: Date): Promise<void> {
  for (const [i, id] of ids.entries()) {
    await tx.update(orgFunctions).set({ sort: i, departmentId, updatedAt: now }).where(eq(orgFunctions.id, id));
  }
}

async function writeDepartmentOrder(tx: Db, ids: string[], divisionId: string, now: Date): Promise<void> {
  for (const [i, id] of ids.entries()) {
    await tx.update(orgDepartments).set({ sort: i, divisionId, updatedAt: now }).where(eq(orgDepartments.id, id));
  }
}

async function liveFunctionIds(tx: Db, departmentId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: orgFunctions.id })
    .from(orgFunctions)
    .where(and(eq(orgFunctions.departmentId, departmentId), isNull(orgFunctions.archivedAt)))
    .orderBy(asc(orgFunctions.sort), asc(orgFunctions.createdAt));
  return rows.map((r) => r.id);
}

async function liveDepartmentIds(tx: Db, divisionId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: orgDepartments.id })
    .from(orgDepartments)
    .where(and(eq(orgDepartments.divisionId, divisionId), isNull(orgDepartments.archivedAt)))
    .orderBy(asc(orgDepartments.sort), asc(orgDepartments.number));
  return rows.map((r) => r.id);
}

async function divisionLabel(db: Db, id: string): Promise<string> {
  const [d] = await db.select({ number: orgDivisions.number, name: orgDivisions.name }).from(orgDivisions).where(eq(orgDivisions.id, id));
  return d ? deptLabel(d) : "?";
}

async function departmentLabel(db: Db, id: string): Promise<string> {
  const [d] = await db.select({ number: orgDepartments.number, name: orgDepartments.name }).from(orgDepartments).where(eq(orgDepartments.id, id));
  return d ? deptLabel(d) : "?";
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

const DIVISION_FIELD_LABEL: Record<string, string> = { name: "name", headTitle: "head title", reportsTo: "Подчинение", ckp: "ЦКП", headPersonId: "head" };
const DEPARTMENT_FIELD_LABEL: Record<string, string> = { name: "name", number: "number", ckp: "ЦКП", statistic: "statistic", metricDefinitionId: "linked number", headPersonId: "head" };

function diff<T extends Record<string, unknown>>(current: T, patch: Partial<T>): { before: Partial<T>; after: Partial<T> } {
  const before: Partial<T> = {};
  const after: Partial<T> = {};
  for (const [k, v] of Object.entries(patch) as [keyof T, unknown][]) {
    if (v === undefined) continue;
    if ((current[k] ?? null) === (v ?? null)) continue;
    before[k] = current[k];
    after[k] = v as T[keyof T];
  }
  return { before, after };
}

export async function updateDivision(ctx: ServiceContext, id: unknown, input: DivisionPatch): Promise<void> {
  const patch = divisionPatchSchema.parse(input);
  const div = await loadDivision(ctx.db, id);
  await assertOrgEdit(ctx, div.companyId);
  if (patch.headPersonId) await assertCompanyPerson(ctx.db, div.companyId, patch.headPersonId, "headPersonId");
  await ctx.db.transaction(async (tx) => {
    await lockChart(tx, div.chartId);
    const current = await loadDivision(tx, div.id);
    const { before, after } = diff(current as unknown as Record<string, unknown>, patch as Record<string, unknown>);
    if (!Object.keys(after).length) return;
    const set: Partial<typeof orgDivisions.$inferInsert> = { ...(after as object), updatedAt: ctx.now };
    if ("name" in after) {
      set.nameIsDefault = false;
      (before as Record<string, unknown>).nameIsDefault = current.nameIsDefault;
    }
    await tx.update(orgDivisions).set(set).where(eq(orgDivisions.id, div.id));
    await writeLog(tx, ctx, div.chartId, div.companyId, {
      entity: "division",
      entityId: div.id,
      action: "update",
      before,
      after,
      summary: `Edited division ${deptLabel(current)}: ${Object.keys(after).map((k) => DIVISION_FIELD_LABEL[k] ?? k).join(", ")}`,
    });
  });
}

export async function updateDepartment(ctx: ServiceContext, id: unknown, input: DepartmentPatch): Promise<void> {
  const patch = departmentPatchSchema.parse(input);
  const dept = await loadDepartment(ctx.db, id);
  await assertOrgEdit(ctx, dept.companyId);
  if (dept.archivedAt) throw new ServiceError("validation", "Restore the department before editing it");
  if (patch.headPersonId) await assertCompanyPerson(ctx.db, dept.companyId, patch.headPersonId, "headPersonId");
  if (patch.metricDefinitionId) await assertCompanyMetric(ctx, dept.companyId, patch.metricDefinitionId);
  await ctx.db.transaction(async (tx) => {
    await lockChart(tx, dept.chartId);
    const current = await loadDepartment(tx, dept.id);
    const { before, after } = diff(current as unknown as Record<string, unknown>, patch as Record<string, unknown>);
    if (!Object.keys(after).length) return;
    const set: Partial<typeof orgDepartments.$inferInsert> = { ...(after as object), updatedAt: ctx.now };
    if ("name" in after) {
      set.nameIsDefault = false;
      (before as Record<string, unknown>).nameIsDefault = current.nameIsDefault;
    }
    await tx.update(orgDepartments).set(set).where(eq(orgDepartments.id, dept.id));
    await writeLog(tx, ctx, dept.chartId, dept.companyId, {
      entity: "department",
      entityId: dept.id,
      action: "update",
      before,
      after,
      summary: `Edited ${deptLabel(current)}: ${Object.keys(after).map((k) => DEPARTMENT_FIELD_LABEL[k] ?? k).join(", ")}`,
    });
  });
}

export async function updateFunction(ctx: ServiceContext, id: unknown, input: FunctionPatch): Promise<void> {
  const patch = functionPatchSchema.parse(input);
  const fn = await loadFunction(ctx.db, id);
  await assertOrgEdit(ctx, fn.companyId);
  if (fn.archivedAt) throw new ServiceError("validation", "Restore the function before editing it");
  if (patch.responsiblePersonId) await assertCompanyPerson(ctx.db, fn.companyId, patch.responsiblePersonId, "responsiblePersonId");
  await ctx.db.transaction(async (tx) => {
    await lockChart(tx, fn.chartId);
    const current = await loadFunction(tx, fn.id);
    const { before, after } = diff(current as unknown as Record<string, unknown>, patch as Record<string, unknown>);
    if (!Object.keys(after).length) return;
    await tx.update(orgFunctions).set({ ...(after as object), updatedAt: ctx.now }).where(eq(orgFunctions.id, fn.id));
    await writeLog(tx, ctx, fn.chartId, fn.companyId, {
      entity: "function",
      entityId: fn.id,
      action: "update",
      before,
      after,
      summary: "text" in after ? `Renamed function ${quote(current.text)} to ${quote(String(after.text))}` : `Changed the responsible person of ${quote(current.text)}`,
    });
  });
}

export async function createFunction(ctx: ServiceContext, input: { departmentId: string; text: string }): Promise<string> {
  const data = functionCreateSchema.parse(input);
  const dept = await loadDepartment(ctx.db, data.departmentId);
  await assertOrgEdit(ctx, dept.companyId);
  if (dept.archivedAt) throw new ServiceError("validation", "Restore the department before adding functions");
  return ctx.db.transaction(async (tx) => {
    await lockChart(tx, dept.chartId);
    const ids = await liveFunctionIds(tx, dept.id);
    const [row] = await tx
      .insert(orgFunctions)
      .values({ chartId: dept.chartId, companyId: dept.companyId, departmentId: dept.id, text: data.text, sort: ids.length, createdAt: ctx.now, updatedAt: ctx.now })
      .returning({ id: orgFunctions.id });
    await writeLog(tx, ctx, dept.chartId, dept.companyId, {
      entity: "function",
      entityId: row!.id,
      action: "create",
      before: null,
      after: { departmentId: dept.id, text: data.text },
      summary: `Added function ${quote(data.text)} to ${deptLabel(dept)}`,
    });
    return row!.id;
  });
}

export async function createDepartment(ctx: ServiceContext, input: { divisionId: string; name: string }): Promise<string> {
  const data = departmentCreateSchema.parse(input);
  const div = await loadDivision(ctx.db, data.divisionId);
  await assertOrgEdit(ctx, div.companyId);
  return ctx.db.transaction(async (tx) => {
    await lockChart(tx, div.chartId);
    const [{ top } = { top: 0 }] = await tx.select({ top: max(orgDepartments.number) }).from(orgDepartments).where(eq(orgDepartments.chartId, div.chartId));
    const number = Math.min(99, Math.max(21, top ?? 0) + 1);
    const ids = await liveDepartmentIds(tx, div.id);
    const [row] = await tx
      .insert(orgDepartments)
      .values({ chartId: div.chartId, companyId: div.companyId, divisionId: div.id, number, name: data.name, sort: ids.length, createdAt: ctx.now, updatedAt: ctx.now })
      .returning({ id: orgDepartments.id });
    await writeLog(tx, ctx, div.chartId, div.companyId, {
      entity: "department",
      entityId: row!.id,
      action: "create",
      before: null,
      after: { divisionId: div.id, number, name: data.name },
      summary: `Added department ${number} ${data.name} to ${deptLabel(div)}`,
    });
    return row!.id;
  });
}

/**
 * Moves a function to a department of the SAME chart (a forged id of another company's
 * department is "not found"), at `index` among the live functions there. Both lists get
 * their sort rewritten as 0, 1, 2, …
 */
export async function moveFunction(ctx: ServiceContext, input: { functionId: string; departmentId: string; index: number }, opts: { undo?: boolean } = {}): Promise<void> {
  const data = functionMoveSchema.parse(input);
  const fn = await loadFunction(ctx.db, data.functionId);
  await assertOrgEdit(ctx, fn.companyId);
  const target = await loadDepartment(ctx.db, data.departmentId).catch(() => null);
  if (!target || target.chartId !== fn.chartId || target.companyId !== fn.companyId) throw new ServiceError("not_found", "Department not found");
  if (!opts.undo && (fn.archivedAt || target.archivedAt)) throw new ServiceError("validation", "Restore it before moving");
  await ctx.db.transaction(async (tx) => {
    await lockChart(tx, fn.chartId);
    const current = await loadFunction(tx, fn.id);
    const from = await liveFunctionIds(tx, current.departmentId);
    const fromIndex = from.indexOf(current.id);
    const sameDept = current.departmentId === target.id;
    const to = placeAt(sameDept ? from : await liveFunctionIds(tx, target.id), current.id, data.index);
    const toIndex = to.indexOf(current.id);
    if (sameDept && toIndex === fromIndex) return;
    if (!sameDept) await writeFunctionOrder(tx, from.filter((x) => x !== current.id), current.departmentId, ctx.now);
    await writeFunctionOrder(tx, to, target.id, ctx.now);
    const fromLabel = await departmentLabel(tx, current.departmentId);
    await writeLog(tx, ctx, fn.chartId, fn.companyId, {
      entity: "function",
      entityId: fn.id,
      action: "move",
      before: { departmentId: current.departmentId, index: fromIndex },
      after: { departmentId: target.id, index: toIndex },
      summary: sameDept ? `Reordered function ${quote(current.text)} in ${fromLabel}` : `Moved function ${quote(current.text)} from ${fromLabel} to ${deptLabel(target)}`,
    });
  });
}

/** Moves a department to a division of the same chart at `index`. */
export async function moveDepartment(ctx: ServiceContext, input: { departmentId: string; divisionId: string; index: number }): Promise<void> {
  const data = departmentMoveSchema.parse(input);
  const dept = await loadDepartment(ctx.db, data.departmentId);
  await assertOrgEdit(ctx, dept.companyId);
  const target = await loadDivision(ctx.db, data.divisionId).catch(() => null);
  if (!target || target.chartId !== dept.chartId || target.companyId !== dept.companyId) throw new ServiceError("not_found", "Division not found");
  if (dept.archivedAt) throw new ServiceError("validation", "Restore it before moving");
  await ctx.db.transaction(async (tx) => {
    await lockChart(tx, dept.chartId);
    const current = await loadDepartment(tx, dept.id);
    const from = await liveDepartmentIds(tx, current.divisionId);
    const fromIndex = from.indexOf(current.id);
    const same = current.divisionId === target.id;
    const to = placeAt(same ? from : await liveDepartmentIds(tx, target.id), current.id, data.index);
    const toIndex = to.indexOf(current.id);
    if (same && toIndex === fromIndex) return;
    if (!same) await writeDepartmentOrder(tx, from.filter((x) => x !== current.id), current.divisionId, ctx.now);
    await writeDepartmentOrder(tx, to, target.id, ctx.now);
    const fromLabel = await divisionLabel(tx, current.divisionId);
    await writeLog(tx, ctx, dept.chartId, dept.companyId, {
      entity: "department",
      entityId: dept.id,
      action: "move",
      before: { divisionId: current.divisionId, index: fromIndex },
      after: { divisionId: target.id, index: toIndex },
      summary: same ? `Reordered ${deptLabel(current)} in division ${fromLabel}` : `Moved ${deptLabel(current)} from division ${fromLabel} to ${deptLabel(target)}`,
    });
  });
}

/** Archive (true) or restore (false) a department or a function. Restoring puts it back where it was. */
export async function setArchived(ctx: ServiceContext, entity: "department" | "function", id: unknown, archived: boolean): Promise<void> {
  if (entity === "function") {
    const fn = await loadFunction(ctx.db, id);
    await assertOrgEdit(ctx, fn.companyId);
    await ctx.db.transaction(async (tx) => {
      await lockChart(tx, fn.chartId);
      await archiveFunctionTx(tx, ctx, await loadFunction(tx, fn.id), archived, archived ? null : await archivedIndex(tx, fn.id));
    });
    return;
  }
  const dept = await loadDepartment(ctx.db, id);
  await assertOrgEdit(ctx, dept.companyId);
  await ctx.db.transaction(async (tx) => {
    await lockChart(tx, dept.chartId);
    await archiveDepartmentTx(tx, ctx, await loadDepartment(tx, dept.id), archived, archived ? null : await archivedIndex(tx, dept.id));
  });
}

/** Where a department / function was when it was last archived (Restore puts it back there). */
async function archivedIndex(tx: Db, entityId: string): Promise<number | null> {
  const [row] = await tx
    .select({ before: orgChangeLog.before })
    .from(orgChangeLog)
    .where(and(eq(orgChangeLog.entityId, entityId), eq(orgChangeLog.action, "archive")))
    .orderBy(desc(orgChangeLog.seq))
    .limit(1);
  const index = (row?.before as { index?: unknown } | null)?.index;
  return typeof index === "number" && index >= 0 ? index : null;
}

async function archiveFunctionTx(tx: Db, ctx: ServiceContext, fn: OrgFunction, archived: boolean, restoreIndex: number | null, log = true): Promise<void> {
  if (!!fn.archivedAt === archived) return;
  const ids = await liveFunctionIds(tx, fn.departmentId);
  if (archived) {
    const index = ids.indexOf(fn.id);
    await tx.update(orgFunctions).set({ archivedAt: ctx.now, updatedAt: ctx.now }).where(eq(orgFunctions.id, fn.id));
    await writeFunctionOrder(tx, ids.filter((x) => x !== fn.id), fn.departmentId, ctx.now);
    if (log) {
      await writeLog(tx, ctx, fn.chartId, fn.companyId, { entity: "function", entityId: fn.id, action: "archive", before: { index }, after: { archived: true }, summary: `Archived function ${quote(fn.text)}` });
    }
  } else {
    await tx.update(orgFunctions).set({ archivedAt: null, updatedAt: ctx.now }).where(eq(orgFunctions.id, fn.id));
    const to = placeAt(ids, fn.id, restoreIndex ?? ids.length);
    await writeFunctionOrder(tx, to, fn.departmentId, ctx.now);
    if (log) {
      await writeLog(tx, ctx, fn.chartId, fn.companyId, { entity: "function", entityId: fn.id, action: "restore", before: { archived: true }, after: { index: to.indexOf(fn.id) }, summary: `Restored function ${quote(fn.text)}` });
    }
  }
}

async function archiveDepartmentTx(tx: Db, ctx: ServiceContext, d: OrgDepartment, archived: boolean, restoreIndex: number | null, log = true): Promise<void> {
  if (!!d.archivedAt === archived) return;
  const ids = await liveDepartmentIds(tx, d.divisionId);
  if (archived) {
    const index = ids.indexOf(d.id);
    await tx.update(orgDepartments).set({ archivedAt: ctx.now, updatedAt: ctx.now }).where(eq(orgDepartments.id, d.id));
    await writeDepartmentOrder(tx, ids.filter((x) => x !== d.id), d.divisionId, ctx.now);
    if (log) {
      await writeLog(tx, ctx, d.chartId, d.companyId, { entity: "department", entityId: d.id, action: "archive", before: { index }, after: { archived: true }, summary: `Archived ${deptLabel(d)}` });
    }
  } else {
    await tx.update(orgDepartments).set({ archivedAt: null, updatedAt: ctx.now }).where(eq(orgDepartments.id, d.id));
    const to = placeAt(ids, d.id, restoreIndex ?? ids.length);
    await writeDepartmentOrder(tx, to, d.divisionId, ctx.now);
    if (log) {
      await writeLog(tx, ctx, d.chartId, d.companyId, { entity: "department", entityId: d.id, action: "restore", before: { archived: true }, after: { index: to.indexOf(d.id) }, summary: `Restored ${deptLabel(d)}` });
    }
  }
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/**
 * Takes back the newest change of the chart that is not undone yet (within the last
 * UNDO_DEPTH changes). Returns the summary of what was undone, or null when nothing is left.
 */
export async function undoLastChange(ctx: ServiceContext, chartId: unknown): Promise<string | null> {
  assertValidId(chartId, "Org chart");
  const [chart] = await ctx.db.select().from(orgCharts).where(and(eq(orgCharts.id, chartId), isNull(orgCharts.archivedAt)));
  if (!chart) throw new ServiceError("not_found", "Org chart not found");
  await assertOrgEdit(ctx, chart.companyId);
  return ctx.db.transaction(async (tx) => {
    await lockChart(tx, chart.id);
    const window = await undoWindow(tx, chart.id);
    const change = window.find((r) => !r.undoneAt);
    if (!change) return null;
    const before = (change.before ?? {}) as Record<string, unknown>;
    const id = change.entityId!;
    if (change.entity === "function") {
      const fn = await loadFunction(tx, id);
      if (change.action === "update") {
        await tx.update(orgFunctions).set({ ...pick(before, ["text", "responsiblePersonId"]), updatedAt: ctx.now }).where(eq(orgFunctions.id, id));
      } else if (change.action === "move") {
        await restoreFunctionPosition(tx, ctx, fn, String(before.departmentId), Number(before.index));
      } else if (change.action === "create" || change.action === "restore") {
        await archiveFunctionTx(tx, ctx, fn, true, null, false);
      } else if (change.action === "archive") {
        await archiveFunctionTx(tx, ctx, fn, false, Number(before.index), false);
      }
    } else if (change.entity === "department") {
      const d = await loadDepartment(tx, id);
      if (change.action === "update") {
        await tx
          .update(orgDepartments)
          .set({ ...pick(before, ["name", "number", "ckp", "statistic", "metricDefinitionId", "headPersonId", "nameIsDefault"]), updatedAt: ctx.now })
          .where(eq(orgDepartments.id, id));
      } else if (change.action === "move") {
        const from = await liveDepartmentIds(tx, d.divisionId);
        const targetDivision = String(before.divisionId);
        if (targetDivision !== d.divisionId) await writeDepartmentOrder(tx, from.filter((x) => x !== d.id), d.divisionId, ctx.now);
        const to = placeAt(targetDivision === d.divisionId ? from : await liveDepartmentIds(tx, targetDivision), d.id, Number(before.index));
        await writeDepartmentOrder(tx, to, targetDivision, ctx.now);
      } else if (change.action === "create" || change.action === "restore") {
        await archiveDepartmentTx(tx, ctx, d, true, null, false);
      } else if (change.action === "archive") {
        await archiveDepartmentTx(tx, ctx, d, false, Number(before.index), false);
      }
    } else if (change.entity === "division" && change.action === "update") {
      await tx
        .update(orgDivisions)
        .set({ ...pick(before, ["name", "headTitle", "reportsTo", "ckp", "headPersonId", "nameIsDefault"]), updatedAt: ctx.now })
        .where(eq(orgDivisions.id, id));
    }
    await tx.update(orgChangeLog).set({ undoneAt: ctx.now, undoneBy: ctx.user.id }).where(eq(orgChangeLog.id, change.id));
    await tx.update(orgCharts).set({ updatedAt: ctx.now }).where(eq(orgCharts.id, chart.id));
    await tx.insert(orgChangeLog).values({
      chartId: chart.id,
      companyId: chart.companyId,
      actorUserId: ctx.user.id,
      entity: change.entity,
      entityId: change.entityId,
      action: "undo",
      before: change.after,
      after: change.before,
      summary: `Undid: ${change.summary}`,
      undoOf: change.id,
      createdAt: ctx.now,
    });
    return change.summary;
  });
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
}

async function restoreFunctionPosition(tx: Db, ctx: ServiceContext, fn: OrgFunction, departmentId: string, index: number): Promise<void> {
  const from = await liveFunctionIds(tx, fn.departmentId);
  if (departmentId !== fn.departmentId) await writeFunctionOrder(tx, from.filter((x) => x !== fn.id), fn.departmentId, ctx.now);
  const to = placeAt(departmentId === fn.departmentId ? from : await liveFunctionIds(tx, departmentId), fn.id, index);
  await writeFunctionOrder(tx, to, departmentId, ctx.now);
}

// ---------------------------------------------------------------------------
// Org Structure Expert (deterministic findings)
// ---------------------------------------------------------------------------

export interface OrgExpertResult {
  companyId: string;
  companySlug: string;
  companyName: string;
  /** "Alura Style · ХБК" for a unit chart. */
  scopeName: string;
  chartId: string | null;
  findings: OrgFinding[];
}

/**
 * The expert's findings for a company: one result per chart (the whole-company chart and
 * any unit charts), or one "no chart yet" result. Reads as `ctx` (tasks it can see).
 */
export async function orgExpertForCompany(ctx: ServiceContext, companyId: string, opts: { maxDepartmentsPerHead?: number } = {}): Promise<OrgExpertResult[]> {
  await assertOrgRead(ctx, companyId);
  const [company] = await ctx.db.select({ slug: companies.slug, name: companies.name }).from(companies).where(eq(companies.id, companyId));
  const charts = await ctx.db
    .select({ chart: orgCharts, unitName: companyUnits.name })
    .from(orgCharts)
    .leftJoin(companyUnits, eq(companyUnits.id, orgCharts.companyUnitId))
    .where(and(eq(orgCharts.companyId, companyId), isNull(orgCharts.archivedAt)))
    .orderBy(sql`${orgCharts.companyUnitId} is not null`, asc(companyUnits.sort));
  const base = { companyId, companySlug: company!.slug, companyName: company!.name };
  if (!charts.length) {
    return [{ ...base, scopeName: company!.name, chartId: null, findings: orgExpertFindings({ hasChart: false, divisions: [], departments: [], functions: [], personNames: {} }) }];
  }
  const metricDefs = await listMetricDefinitions(ctx, companyId);
  const out: OrgExpertResult[] = [];
  for (const { chart, unitName } of charts) {
    const view = await loadChartView(ctx, chart, {});
    const depts = view.divisions.flatMap((d) => d.departments);
    const linked = metricDefs.filter((m) => depts.some((d) => d.metricDefinitionId === m.id));
    const cards = new Map((await buildMetricCards(ctx, linked)).map((c) => [c.id, c]));
    const personNames: Record<string, string> = {};
    for (const d of [...view.divisions, ...depts]) if (d.headPersonId && d.headName) personNames[d.headPersonId] = d.headName;
    out.push({
      ...base,
      scopeName: unitName ? `${company!.name} · ${unitName}` : company!.name,
      chartId: chart.id,
      findings: orgExpertFindings(
        {
          hasChart: true,
          divisions: view.divisions.map((d) => ({ id: d.id, number: d.number, name: d.name, headPersonId: d.headPersonId })),
          departments: depts.map((d) => {
            const card = d.metricDefinitionId ? cards.get(d.metricDefinitionId) : undefined;
            return {
              id: d.id,
              number: d.number,
              name: d.name,
              headPersonId: d.headPersonId,
              ckp: d.ckp,
              statistic: d.statistic,
              metric: card ? { label: card.label, freshness: card.freshness.status } : null,
              overdueTasks: d.overdueTasks,
            };
          }),
          functions: depts.flatMap((d) => d.functions.map((f) => ({ id: f.id, text: f.text, responsiblePersonId: f.responsiblePersonId }))),
          personNames,
        },
        opts,
      ),
    });
  }
  return out;
}
