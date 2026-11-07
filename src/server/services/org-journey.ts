import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import {
  deptLabel,
  journeyMoveSchema,
  journeyStepCreateSchema,
  journeyStepPatchSchema,
  journeyTemplateFor,
  JOURNEY_TEMPLATES,
  placeAt,
  type JourneyStepCreateInput,
  type JourneyStepPatch,
  type JourneyTemplateKey,
} from "@/lib/org";
import type { Db } from "@/server/db/connect";
import { companies, orgCharts, orgDepartments, orgJourneySteps } from "@/server/db/schema";
import { assertOrgEdit, assertOrgRead, assertValidId } from "./access";
import type { ServiceContext } from "./context";
import { ServiceError, toServiceError } from "./errors";
import {
  archiveJourneyStepTx,
  beginWrite,
  liveJourneyIds,
  loadJourneyStep,
  lockJourney,
  quote,
  writeJourneyOrder,
  writeLog,
  type OrgJourneyStepRow,
  type OrgWriteOpts,
} from "./org";

/**
 * The journey strip above the org board: the company's work as numbered steps ("01 Фабрика
 * найдена → 02 Переговоры → …"), each optionally pointing at a department (clicking a step
 * highlights it on the board). Steps belong to the COMPANY (shared by its charts); a change
 * is made from a board, so it is written to that board's chart change log, checked against
 * that chart's version and undoable there like every other org edit. Founders only; a step
 * or a department of another company is "not found" / refused; nothing is deleted (removed
 * steps are archived).
 */

export interface OrgJourneyStepView {
  id: string;
  /** 1, 2, 3 … (shown "01", "02", …). */
  number: number;
  label: string;
  departmentId: string | null;
  /** "4 Маркетинг" (null when not linked). */
  departmentLabel: string | null;
  /** The linked department was archived meanwhile. */
  departmentArchived: boolean;
}

export interface OrgJourneyView {
  steps: OrgJourneyStepView[];
  /** A template the founders can start from (offered only while the company has no steps). */
  template: { key: JourneyTemplateKey; label: string; steps: readonly string[] } | null;
}

export async function getOrgJourney(ctx: ServiceContext, companyId: string, known: { slug?: string } = {}): Promise<OrgJourneyView> {
  await assertOrgRead(ctx, companyId);
  const [company] = known.slug ? [{ slug: known.slug }] : await ctx.db.select({ slug: companies.slug }).from(companies).where(eq(companies.id, companyId));
  if (!company) throw new ServiceError("not_found", "Company not found");
  const ids = await liveJourneyIds(ctx.db, companyId);
  const rows = ids.length ? await ctx.db.select().from(orgJourneySteps).where(and(eq(orgJourneySteps.companyId, companyId), isNull(orgJourneySteps.archivedAt))) : [];
  const depts = ids.length
    ? await ctx.db
        .select({ id: orgDepartments.id, number: orgDepartments.number, name: orgDepartments.name, archivedAt: orgDepartments.archivedAt })
        .from(orgDepartments)
        .where(eq(orgDepartments.companyId, companyId))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const steps = ids.map((id, i) => {
    const r = byId.get(id)!;
    const d = r.departmentId ? depts.find((x) => x.id === r.departmentId) : undefined;
    return { id, number: i + 1, label: r.label, departmentId: d ? r.departmentId : null, departmentLabel: d ? deptLabel(d) : null, departmentArchived: !!d?.archivedAt };
  });
  const key = steps.length ? null : journeyTemplateFor(company.slug);
  return { steps, template: key ? { key, label: JOURNEY_TEMPLATES[key].label, steps: JOURNEY_TEMPLATES[key].steps } : null };
}

/** The board's chart (live), after the founders-only and company checks. */
async function editableChart(ctx: ServiceContext, chartId: unknown) {
  assertValidId(chartId, "Org chart");
  const [chart] = await ctx.db.select().from(orgCharts).where(and(eq(orgCharts.id, chartId), isNull(orgCharts.archivedAt)));
  if (!chart) throw new ServiceError("not_found", "Org chart not found");
  await assertOrgEdit(ctx, chart.companyId);
  return chart;
}

/** A step of the chart's company (another company's step is "not found", also with a forged id). */
async function companyStep(db: Db, companyId: string, stepId: unknown): Promise<OrgJourneyStepRow> {
  const step = await loadJourneyStep(db, stepId);
  if (step.companyId !== companyId) throw new ServiceError("not_found", "Journey step not found");
  return step;
}

/** A step may point at a live department of its own company only. */
async function assertJourneyDepartment(db: Db, companyId: string, departmentId: string): Promise<string> {
  assertValidId(departmentId, "Department");
  const [d] = await db
    .select({ companyId: orgDepartments.companyId, number: orgDepartments.number, name: orgDepartments.name })
    .from(orgDepartments)
    .innerJoin(orgCharts, eq(orgCharts.id, orgDepartments.chartId))
    .where(and(eq(orgDepartments.id, departmentId), isNull(orgDepartments.archivedAt), isNull(orgCharts.archivedAt)));
  if (!d || d.companyId !== companyId) {
    throw new ServiceError("validation", "This department is not part of this company's org chart", { departmentId: ["Pick a department of this company"] });
  }
  return deptLabel(d);
}

/** Lock order everywhere: the chart (with the version check), then the company's journey. */
async function begin(tx: Db, chartId: string, companyId: string, opts: OrgWriteOpts): Promise<void> {
  await beginWrite(tx, chartId, opts);
  await lockJourney(tx, companyId);
}

export async function createJourneyStep(ctx: ServiceContext, chartId: unknown, input: JourneyStepCreateInput, opts: OrgWriteOpts = {}): Promise<string> {
  const parsed = journeyStepCreateSchema.safeParse(input);
  if (!parsed.success) throw toServiceError(parsed.error)!;
  const data = parsed.data;
  const chart = await editableChart(ctx, chartId);
  const deptName = data.departmentId ? await assertJourneyDepartment(ctx.db, chart.companyId, data.departmentId) : null;
  return ctx.db.transaction(async (tx) => {
    await begin(tx, chart.id, chart.companyId, opts);
    const ids = await liveJourneyIds(tx, chart.companyId);
    const [row] = await tx
      .insert(orgJourneySteps)
      .values({ companyId: chart.companyId, number: ids.length + 1, label: data.label, departmentId: data.departmentId ?? null, sort: ids.length, createdAt: ctx.now, updatedAt: ctx.now })
      .returning({ id: orgJourneySteps.id });
    await writeLog(
      tx,
      ctx,
      chart.id,
      chart.companyId,
      {
        entity: "journey_step",
        entityId: row!.id,
        action: "create",
        before: null,
        after: { label: data.label, departmentId: data.departmentId ?? null },
        summary: `Added journey step ${ids.length + 1} ${quote(data.label)}${deptName ? ` → ${deptName}` : ""}`,
      },
      opts,
    );
    return row!.id;
  });
}

/** Renames a step and / or links it to a department of the company (null = unlink). */
export async function updateJourneyStep(ctx: ServiceContext, chartId: unknown, stepId: unknown, input: JourneyStepPatch, opts: OrgWriteOpts = {}): Promise<void> {
  const parsed = journeyStepPatchSchema.safeParse(input);
  if (!parsed.success) throw toServiceError(parsed.error)!;
  const patch = parsed.data;
  const chart = await editableChart(ctx, chartId);
  const step = await companyStep(ctx.db, chart.companyId, stepId);
  if (step.archivedAt) throw new ServiceError("validation", "This step was removed — Undo brings it back");
  const deptName = patch.departmentId ? await assertJourneyDepartment(ctx.db, chart.companyId, patch.departmentId) : null;
  await ctx.db.transaction(async (tx) => {
    await begin(tx, chart.id, chart.companyId, opts);
    const current = await loadJourneyStep(tx, step.id);
    if (current.archivedAt) throw new ServiceError("validation", "This step was removed — Undo brings it back");
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    if (patch.label !== undefined && patch.label !== current.label) {
      before.label = current.label;
      after.label = patch.label;
    }
    if (patch.departmentId !== undefined && (patch.departmentId ?? null) !== current.departmentId) {
      before.departmentId = current.departmentId;
      after.departmentId = patch.departmentId ?? null;
    }
    if (!Object.keys(after).length) return;
    await tx
      .update(orgJourneySteps)
      .set({ ...after, updatedAt: ctx.now })
      .where(eq(orgJourneySteps.id, step.id));
    const name = quote(String(after.label ?? current.label));
    const summary =
      "label" in after
        ? `Renamed journey step ${quote(current.label)} to ${name}`
        : after.departmentId
          ? `Linked journey step ${name} to ${deptName}`
          : `Unlinked journey step ${name} from its department`;
    await writeLog(tx, ctx, chart.id, chart.companyId, { entity: "journey_step", entityId: step.id, action: "update", before, after, summary }, opts);
  });
}

/** Moves a step to `index` (0 = first); numbers follow the order (01, 02, …). */
export async function moveJourneyStep(ctx: ServiceContext, chartId: unknown, input: { stepId: string; index: number }, opts: OrgWriteOpts = {}): Promise<void> {
  const data = journeyMoveSchema.parse(input);
  const chart = await editableChart(ctx, chartId);
  const step = await companyStep(ctx.db, chart.companyId, data.stepId);
  if (step.archivedAt) throw new ServiceError("validation", "This step was removed — Undo brings it back");
  await ctx.db.transaction(async (tx) => {
    await begin(tx, chart.id, chart.companyId, opts);
    const current = await loadJourneyStep(tx, step.id);
    if (current.archivedAt) throw new ServiceError("validation", "This step was removed — Undo brings it back");
    const ids = await liveJourneyIds(tx, chart.companyId);
    const from = ids.indexOf(step.id);
    const to = placeAt(ids, step.id, data.index);
    const toIndex = to.indexOf(step.id);
    if (toIndex === from) return;
    await writeJourneyOrder(tx, to, ctx.now);
    await writeLog(
      tx,
      ctx,
      chart.id,
      chart.companyId,
      { entity: "journey_step", entityId: step.id, action: "move", before: { index: from }, after: { index: toIndex }, summary: `Moved journey step ${quote(current.label)} from ${from + 1} to ${toIndex + 1}` },
      opts,
    );
  });
}

/** Removes (archives) a step, or brings it back where it was. */
export async function setJourneyStepArchived(ctx: ServiceContext, chartId: unknown, stepId: unknown, archived: boolean, opts: OrgWriteOpts = {}): Promise<void> {
  const chart = await editableChart(ctx, chartId);
  const step = await companyStep(ctx.db, chart.companyId, stepId);
  await ctx.db.transaction(async (tx) => {
    await begin(tx, chart.id, chart.companyId, opts);
    const current = await loadJourneyStep(tx, step.id);
    if (!!current.archivedAt === archived) return;
    const ids = await liveJourneyIds(tx, chart.companyId);
    const lastIndex = archived ? ids.indexOf(current.id) : null;
    const index = await archiveJourneyStepTx(tx, ctx, current, archived, archived ? null : ids.length);
    await writeLog(
      tx,
      ctx,
      chart.id,
      chart.companyId,
      archived
        ? { entity: "journey_step", entityId: step.id, action: "archive", before: { index: lastIndex }, after: { archived: true }, summary: `Removed journey step ${quote(current.label)}` }
        : { entity: "journey_step", entityId: step.id, action: "restore", before: { archived: true }, after: { index }, summary: `Restored journey step ${quote(current.label)}` },
      opts,
    );
  });
}

/**
 * "Use Upsell template": adds the template's steps (01 … 09) with no departments linked —
 * the founders pick them. Only for a company with no journey yet; one change (Undo removes
 * all of its steps).
 */
export async function applyJourneyTemplate(ctx: ServiceContext, chartId: unknown, key: JourneyTemplateKey, opts: OrgWriteOpts = {}): Promise<string[]> {
  const template = Object.hasOwn(JOURNEY_TEMPLATES, key) ? JOURNEY_TEMPLATES[key] : null;
  if (!template) throw new ServiceError("validation", "Unknown journey template");
  const chart = await editableChart(ctx, chartId);
  return ctx.db.transaction(async (tx) => {
    await begin(tx, chart.id, chart.companyId, opts);
    if ((await liveJourneyIds(tx, chart.companyId)).length) {
      throw new ServiceError("validation", "This company already has a journey — edit its steps instead");
    }
    const rows = await tx
      .insert(orgJourneySteps)
      .values(template.steps.map((label, i) => ({ companyId: chart.companyId, number: i + 1, label, departmentId: null, sort: i, createdAt: ctx.now, updatedAt: ctx.now })))
      .returning({ id: orgJourneySteps.id, sort: orgJourneySteps.sort });
    const stepIds = rows.sort((a, b) => a.sort - b.sort).map((r) => r.id);
    await writeLog(
      tx,
      ctx,
      chart.id,
      chart.companyId,
      { entity: "journey", entityId: null, action: "create", before: null, after: { template: key, stepIds }, summary: `Applied the ${template.label} journey template (${stepIds.length} steps)` },
      opts,
    );
    return stepIds;
  });
}
