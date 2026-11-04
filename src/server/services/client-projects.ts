import "server-only";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { isIsoDate, type IsoDate } from "@/lib/dates";
import { dec, sum, toText } from "@/lib/decimal";
import {
  CLIENT_PROJECT_STAGES,
  CLIENT_PROJECT_STATUSES,
  clientProjects,
  orgDepartments,
  orgFunctions,
  orgJourneySteps,
  orgPosts,
  people,
} from "@/server/db/schema";
import { assertCompanyAccess, assertValidId } from "./access";
import type { ServiceContext } from "./context";
import { ServiceError, toServiceError } from "./errors";

/**
 * Client projects of an IT-services company (Jobutify): a board by stage with status, due
 * date, SLA fee and next invoice. Founders-only (like the holding: contract money), always
 * inside one company (every read and write is scoped by company id), archived instead of
 * deleted. SLA fees are exact decimals (numeric(14,2) → `src/lib/decimal.ts`), never floats.
 *
 * Also: the read-only partner journey of a sales-partners company (Upsell).
 */

export type ClientProjectStage = (typeof CLIENT_PROJECT_STAGES)[number];
export type ClientProjectStatus = (typeof CLIENT_PROJECT_STATUSES)[number];

/** Board columns in pipeline order; paused / closed are shown after the pipeline. */
export const PIPELINE_STAGES: readonly ClientProjectStage[] = ["lead", "discovery", "build", "implementation", "live_sla"];
export const STAGE_LABELS: Record<ClientProjectStage, string> = {
  lead: "Lead",
  discovery: "Discovery",
  build: "Build",
  implementation: "Implementation",
  live_sla: "Live · SLA",
  paused: "Paused",
  closed: "Closed",
};
export const STATUS_LABELS: Record<ClientProjectStatus, string> = { on_track: "On track", at_risk: "At risk", late: "Late" };

export function canManageClientProjects(ctx: ServiceContext): boolean {
  return ctx.user.role === "founder";
}

async function assertAccess(ctx: ServiceContext, companyId: unknown): Promise<string> {
  if (!canManageClientProjects(ctx)) throw new ServiceError("forbidden", "Only the founders can see client projects");
  assertValidId(companyId, "Company");
  await assertCompanyAccess(ctx, companyId);
  return companyId;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const optionalDate = z.preprocess(blankToNull, z.string().refine(isIsoDate, { message: "Use a valid date (YYYY-MM-DD)" }).nullable().optional());
const optionalText = (max: number) => z.preprocess(blankToNull, z.string().trim().max(max).nullable().optional());

/** "12 500,50" / "12500.5" / 12500 → "12500.5"; ≥ 0, at most 2 decimals, below 10^12. */
const feeSchema = z.preprocess(
  (v) => {
    const b = blankToNull(v);
    if (typeof b === "number") return String(b);
    return typeof b === "string" ? b.replace(/[\s  ]/g, "").replace(",", ".") : b;
  },
  z
    .string()
    .regex(/^\d{1,12}(\.\d{1,2})?$/, "Use an amount like 12500 or 12500.50 (at most 2 decimals)")
    .transform((s) => toText(dec(s)))
    .nullable()
    .optional(),
);

const fields = {
  clientName: z.string().trim().min(1, "Client is required").max(200),
  title: z.string().trim().min(1, "Title is required").max(200),
  stage: z.enum(CLIENT_PROJECT_STAGES),
  status: z.enum(CLIENT_PROJECT_STATUSES),
  startDate: optionalDate,
  dueDate: optionalDate,
  slaMonthlyFee: feeSchema,
  slaCurrency: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
    z.string().regex(/^[A-Z]{3}$/, "Use a 3-letter currency code (KGS, USD, …)"),
  ),
  slaResponseHours: z.preprocess(
    (v) => (blankToNull(v) === null ? null : typeof v === "string" ? Number(v) : v),
    z.number().int("Whole hours").min(0).max(10000).nullable().optional(),
  ),
  nextInvoiceDate: optionalDate,
  notes: optionalText(5000),
};

const datesInOrder = (v: { startDate?: string | null; dueDate?: string | null }) => !v.startDate || !v.dueDate || v.startDate <= v.dueDate;
const DATE_ORDER = { message: "The due date is before the start date", path: ["dueDate"] };

export const clientProjectCreateSchema = z
  .object({
    ...fields,
    stage: fields.stage.default("lead"),
    status: fields.status.default("on_track"),
    slaCurrency: fields.slaCurrency.default("KGS"),
  })
  .strict()
  .refine(datesInOrder, DATE_ORDER);
export const clientProjectUpdateSchema = z.object(fields).partial().strict();

/** Zod parse that throws a ServiceError("validation") with per-field messages. */
function parseInput<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const r = schema.safeParse(raw);
  if (!r.success) throw toServiceError(r.error)!;
  return r.data;
}

export type ClientProjectInput = z.input<typeof clientProjectCreateSchema>;
export type ClientProjectPatch = z.input<typeof clientProjectUpdateSchema>;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ClientProjectView {
  id: string;
  companyId: string;
  clientName: string;
  title: string;
  stage: ClientProjectStage;
  status: ClientProjectStatus;
  startDate: IsoDate | null;
  dueDate: IsoDate | null;
  /** Exact decimal text ("12500.5"), or null. */
  slaMonthlyFee: string | null;
  slaCurrency: string;
  slaResponseHours: number | null;
  nextInvoiceDate: IsoDate | null;
  notes: string | null;
  archived: boolean;
}

function toView(r: typeof clientProjects.$inferSelect): ClientProjectView {
  return {
    id: r.id,
    companyId: r.companyId,
    clientName: r.clientName,
    title: r.title,
    stage: r.stage,
    status: r.status,
    startDate: r.startDate,
    dueDate: r.dueDate,
    slaMonthlyFee: r.slaMonthlyFee === null ? null : toText(dec(r.slaMonthlyFee)),
    slaCurrency: r.slaCurrency,
    slaResponseHours: r.slaResponseHours,
    nextInvoiceDate: r.nextInvoiceDate,
    notes: r.notes,
    archived: r.archivedAt !== null,
  };
}

const STAGE_ORDER = new Map(CLIENT_PROJECT_STAGES.map((s, i) => [s, i]));

export async function listClientProjects(
  ctx: ServiceContext,
  companyId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<ClientProjectView[]> {
  await assertAccess(ctx, companyId);
  const rows = await ctx.db
    .select()
    .from(clientProjects)
    .where(and(eq(clientProjects.companyId, companyId), opts.includeArchived ? undefined : isNull(clientProjects.archivedAt)))
    .orderBy(asc(clientProjects.dueDate), asc(clientProjects.clientName), asc(clientProjects.title));
  return rows.map(toView).sort((a, b) => STAGE_ORDER.get(a.stage)! - STAGE_ORDER.get(b.stage)!);
}

async function loadOne(ctx: ServiceContext, companyId: string, id: unknown) {
  assertValidId(id, "Client project");
  const [row] = await ctx.db
    .select()
    .from(clientProjects)
    .where(and(eq(clientProjects.id, id), eq(clientProjects.companyId, companyId)));
  if (!row) throw new ServiceError("not_found", "Client project not found");
  return row;
}

export async function getClientProject(ctx: ServiceContext, companyId: string, id: string): Promise<ClientProjectView> {
  await assertAccess(ctx, companyId);
  return toView(await loadOne(ctx, companyId, id));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createClientProject(ctx: ServiceContext, companyId: string, raw: unknown): Promise<ClientProjectView> {
  await assertAccess(ctx, companyId);
  const input = parseInput(clientProjectCreateSchema, raw);
  const [row] = await ctx.db
    .insert(clientProjects)
    .values({
      companyId,
      clientName: input.clientName,
      title: input.title,
      stage: input.stage,
      status: input.status,
      startDate: input.startDate ?? null,
      dueDate: input.dueDate ?? null,
      slaMonthlyFee: input.slaMonthlyFee ?? null,
      slaCurrency: input.slaCurrency,
      slaResponseHours: input.slaResponseHours ?? null,
      nextInvoiceDate: input.nextInvoiceDate ?? null,
      notes: input.notes ?? null,
    })
    .returning();
  return toView(row!);
}

export async function updateClientProject(ctx: ServiceContext, companyId: string, id: string, raw: unknown): Promise<ClientProjectView> {
  await assertAccess(ctx, companyId);
  const patch = parseInput(clientProjectUpdateSchema, raw);
  const current = await loadOne(ctx, companyId, id);
  if (current.archivedAt) throw new ServiceError("conflict", "This client project is archived. Restore it first.");
  const set: Partial<typeof clientProjects.$inferInsert> = {};
  for (const [k, v] of Object.entries(patch) as [keyof typeof patch, unknown][]) {
    if (v !== undefined) (set as Record<string, unknown>)[k] = v;
  }
  const startDate = "startDate" in set ? set.startDate : current.startDate;
  const dueDate = "dueDate" in set ? set.dueDate : current.dueDate;
  if (!datesInOrder({ startDate, dueDate })) {
    throw new ServiceError("validation", `dueDate: ${DATE_ORDER.message}`, { dueDate: [DATE_ORDER.message] });
  }
  if (Object.keys(set).length === 0) return toView(current);
  const [row] = await ctx.db
    .update(clientProjects)
    .set({ ...set, updatedAt: ctx.now })
    .where(and(eq(clientProjects.id, current.id), eq(clientProjects.companyId, companyId)))
    .returning();
  return toView(row!);
}

/** Archive (never a hard delete) or restore. */
export async function setClientProjectArchived(ctx: ServiceContext, companyId: string, id: string, archived: boolean): Promise<ClientProjectView> {
  await assertAccess(ctx, companyId);
  const current = await loadOne(ctx, companyId, id);
  const [row] = await ctx.db
    .update(clientProjects)
    .set({ archivedAt: archived ? (current.archivedAt ?? ctx.now) : null, updatedAt: ctx.now })
    .where(and(eq(clientProjects.id, current.id), eq(clientProjects.companyId, companyId)))
    .returning();
  return toView(row!);
}

// ---------------------------------------------------------------------------
// Totals (pure)
// ---------------------------------------------------------------------------

export interface ClientProjectTotals {
  /** Not archived, not paused, not closed. */
  active: number;
  /** Monthly SLA revenue of live projects, per currency (exact decimal text), sorted by currency. */
  monthlySla: { currency: string; amount: string }[];
  /** Active projects marked at risk / late. */
  atRisk: number;
  late: number;
}

export const isActiveStage = (s: ClientProjectStage) => s !== "paused" && s !== "closed";

export function clientProjectTotals(projects: readonly ClientProjectView[]): ClientProjectTotals {
  const live = projects.filter((p) => !p.archived);
  const active = live.filter((p) => isActiveStage(p.stage));
  const byCurrency = new Map<string, bigint[]>();
  for (const p of live) {
    if (p.stage !== "live_sla" || p.slaMonthlyFee === null) continue;
    byCurrency.set(p.slaCurrency, [...(byCurrency.get(p.slaCurrency) ?? []), dec(p.slaMonthlyFee)]);
  }
  return {
    active: active.length,
    monthlySla: [...byCurrency.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([currency, list]) => ({ currency, amount: toText(sum(list)) })),
    atRisk: active.filter((p) => p.status === "at_risk").length,
    late: active.filter((p) => p.status === "late").length,
  };
}

/** Projects grouped by stage, every stage present (pipeline first, then paused / closed). */
export function boardByStage(projects: readonly ClientProjectView[]): { stage: ClientProjectStage; label: string; items: ClientProjectView[] }[] {
  return CLIENT_PROJECT_STAGES.map((stage) => ({ stage, label: STAGE_LABELS[stage], items: projects.filter((p) => p.stage === stage) }));
}

// ---------------------------------------------------------------------------
// Partner journey (read-only)
// ---------------------------------------------------------------------------

export interface JourneyStepView {
  id: string;
  number: number;
  label: string;
  departmentId: string | null;
  departmentName: string | null;
  /** Distinct active people linked to the step's department (head, post holders, function owners). */
  partners: { id: string; name: string }[];
}

/** The company's journey strip with the people working at each step. Read-only. */
export async function listPartnerJourney(ctx: ServiceContext, companyId: string): Promise<JourneyStepView[]> {
  assertValidId(companyId, "Company");
  await assertCompanyAccess(ctx, companyId);
  const steps = await ctx.db
    .select({ s: orgJourneySteps, departmentName: orgDepartments.name, headPersonId: orgDepartments.headPersonId })
    .from(orgJourneySteps)
    .leftJoin(
      orgDepartments,
      and(eq(orgDepartments.id, orgJourneySteps.departmentId), eq(orgDepartments.companyId, companyId), isNull(orgDepartments.archivedAt)),
    )
    .where(and(eq(orgJourneySteps.companyId, companyId), isNull(orgJourneySteps.archivedAt)))
    .orderBy(asc(orgJourneySteps.sort), asc(orgJourneySteps.number));
  const deptIds = [...new Set(steps.map((s) => (s.departmentName !== null ? s.s.departmentId : null)).filter((x): x is string => !!x))];
  const links = new Map<string, Set<string>>();
  const link = (dept: string, person: string | null) => {
    if (!person) return;
    links.set(dept, (links.get(dept) ?? new Set()).add(person));
  };
  for (const s of steps) if (s.s.departmentId && s.departmentName !== null) link(s.s.departmentId, s.headPersonId);
  if (deptIds.length > 0) {
    const [posts, fns] = await Promise.all([
      ctx.db
        .select({ dept: orgPosts.departmentId, person: orgPosts.personId })
        .from(orgPosts)
        .where(and(inArray(orgPosts.departmentId, deptIds), eq(orgPosts.companyId, companyId), isNull(orgPosts.archivedAt))),
      ctx.db
        .select({ dept: orgFunctions.departmentId, person: orgFunctions.responsiblePersonId })
        .from(orgFunctions)
        .where(and(inArray(orgFunctions.departmentId, deptIds), eq(orgFunctions.companyId, companyId), isNull(orgFunctions.archivedAt))),
    ]);
    for (const r of [...posts, ...fns]) link(r.dept, r.person);
  }
  const personIds = [...new Set([...links.values()].flatMap((s) => [...s]))];
  const names = new Map<string, string>();
  if (personIds.length > 0) {
    const rows = await ctx.db
      .select({ id: people.id, fullName: people.fullName, shortName: people.shortName })
      .from(people)
      .where(and(inArray(people.id, personIds), isNull(people.leftAt)));
    for (const r of rows) names.set(r.id, r.shortName || r.fullName);
  }
  return steps.map(({ s, departmentName }) => {
    const ids = s.departmentId && departmentName !== null ? [...(links.get(s.departmentId) ?? [])] : [];
    return {
      id: s.id,
      number: s.number,
      label: s.label,
      departmentId: departmentName !== null ? s.departmentId : null,
      departmentName,
      partners: ids
        .filter((id) => names.has(id))
        .map((id) => ({ id, name: names.get(id)! }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}
