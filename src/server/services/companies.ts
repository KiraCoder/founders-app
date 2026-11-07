import "server-only";
import { and, asc, count, eq, inArray, isNull, max, ne, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { cache } from "react";
import { z } from "zod";
import { CACHE_TAGS, invalidate, sharedCache } from "@/server/cache";
import type { Db } from "@/server/db/connect";
import {
  clientProjects,
  COMPANY_KINDS,
  companies,
  companyUnits,
  intercompanyFlows,
  intercompanyLedgerEntries,
  metricDefinitions,
  orgChangeLog,
  orgCharts,
  orgDepartments,
  orgDivisions,
  orgFunctions,
  orgJourneySteps,
  orgPosts,
  personCompanies,
  projects,
  tasks,
  type Company,
  type CompanyKind,
  type CompanyUnit,
} from "@/server/db/schema";
import { accessibleCompaniesWhere, assertValidId, inAccessibleCompany } from "./access";
import type { ServiceContext } from "./context";
import { ServiceError } from "./errors";
import { SLUG_MAX, SLUG_RE, slugifyCompanyName } from "@/components/companies/slug";
import { taskCountsByCompany } from "./tasks";

export { slugifyCompanyName };

export interface CompanyCard extends Company {
  openTasks: number;
  overdueTasks: number;
  activeProjects: number;
}

// ---------------------------------------------------------------------------
// Archived filters (for other services: archived companies are hidden everywhere)
// ---------------------------------------------------------------------------

/** SQL filter on the `companies` table: only active (not archived) companies. */
export function activeCompaniesWhere(): SQL {
  return isNull(companies.archivedAt);
}

/**
 * For any table with a company id column (tasks, projects, metric definitions, ...): rows
 * of companies that are not archived AND that the user may access. Unlike
 * `inAccessibleCompany` this is never `undefined` (archived companies are hidden for
 * founders too). For a nullable column (tasks.company_id), combine with
 * `or(isNull(col), inActiveCompany(...))` to keep rows without a company.
 */
export function inActiveCompany(ctx: ServiceContext, companyIdColumn: AnyPgColumn): SQL {
  return inArray(
    companyIdColumn,
    ctx.db
      .select({ id: companies.id })
      .from(companies)
      .where(and(activeCompaniesWhere(), accessibleCompaniesWhere(ctx))),
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Straight from the database (write paths: never a cached copy). */
async function queryCompanies(ctx: ServiceContext): Promise<Company[]> {
  return ctx.db
    .select()
    .from(companies)
    .where(and(activeCompaniesWhere(), accessibleCompaniesWhere(ctx)))
    .orderBy(asc(companies.sort), asc(companies.name));
}

/**
 * Active (non-archived) companies the user can access, in sidebar order. Read by the layout and
 * most pages, so it is cached twice: per request (same `ctx` → one read for layout + page) and,
 * for founders (who all see every company), across requests under the `companies` tag (dropped
 * by every write below).
 */
export const listCompanies = cache(async (ctx: ServiceContext): Promise<Company[]> => {
  if (ctx.user.role !== "founder") return queryCompanies(ctx);
  return sharedCache(["companies:active"], [CACHE_TAGS.companies], () => queryCompanies(ctx));
});

/** Every write to `companies` (and company units) calls this. */
export function companiesChanged(): void {
  invalidate(CACHE_TAGS.companies);
}

export async function listCompanyCards(ctx: ServiceContext): Promise<CompanyCard[]> {
  const list = await listCompanies(ctx);
  const ids = list.map((c) => c.id);
  const [taskCounts, projectRows] = await Promise.all([
    taskCountsByCompany(ctx, ids),
    ctx.db
      .select({
        companyId: projects.companyId,
        active: sql<number>`count(*) filter (where ${projects.status} in ('planned','active','on_hold'))`.mapWith(Number),
      })
      .from(projects)
      .where(inAccessibleCompany(ctx, projects.companyId))
      .groupBy(projects.companyId),
  ]);
  const projectCounts = new Map(projectRows.map((r) => [r.companyId, r.active]));
  return list.map((c) => ({
    ...c,
    openTasks: taskCounts.get(c.id)?.open ?? 0,
    overdueTasks: taskCounts.get(c.id)?.overdue ?? 0,
    activeProjects: projectCounts.get(c.id) ?? 0,
  }));
}

/** Live units of a company (shared between founders: cached under `companies`). */
async function unitsOf(ctx: ServiceContext, companyId: string): Promise<CompanyUnit[]> {
  const load = () =>
    ctx.db
      .select()
      .from(companyUnits)
      .where(and(eq(companyUnits.companyId, companyId), isNull(companyUnits.archivedAt)))
      .orderBy(asc(companyUnits.sort));
  return ctx.user.role === "founder" ? sharedCache(["companies:units", companyId], [CACHE_TAGS.companies], load) : load();
}

/** A company page's company with its counts and units. Once per request (page + generateMetadata). */
export const getCompanyBySlug = cache(async (ctx: ServiceContext, slug: string): Promise<CompanyCard & { units: CompanyUnit[] }> => {
  const cards = await listCompanyCards(ctx);
  const company = cards.find((c) => c.slug === slug);
  if (!company) throw new ServiceError("not_found", "Company not found");
  return { ...company, units: await unitsOf(ctx, company.id) };
});

/** A company with its units, without the task / project counts (the org page). */
export const getCompanyWithUnits = cache(async (ctx: ServiceContext, slug: string): Promise<Company & { units: CompanyUnit[] }> => {
  const company = (await listCompanies(ctx)).find((c) => c.slug === slug);
  if (!company) throw new ServiceError("not_found", "Company not found");
  return { ...company, units: await unitsOf(ctx, company.id) };
});

// ---------------------------------------------------------------------------
// Management (Settings → Companies; founders only)
// ---------------------------------------------------------------------------

export const COMPANY_KIND_LABELS: Record<CompanyKind, string> = {
  it_services: "IT services",
  factory: "Factory",
  brand_sales: "Brand / sales",
  sales_partners: "Sales partners",
  courier: "Courier",
  generic: "Generic",
};

export const DEFAULT_COMPANY_COLOR = "#1E6B49";

/** Things that keep a company from being deleted for good (then it can only be archived). */
export interface CompanyUsage {
  tasks: number;
  peopleLinks: number;
  metricDefinitions: number;
  projects: number;
  orgChart: number;
  holdingFlows: number;
  clientProjects: number;
}

export interface ManagedCompany extends Company {
  usage: CompanyUsage;
  /** True when nothing refers to the company (hard delete allowed). */
  canDelete: boolean;
}

export function canManageCompanies(ctx: ServiceContext): boolean {
  return ctx.user.role === "founder";
}

function assertFounder(ctx: ServiceContext): void {
  if (!canManageCompanies(ctx)) throw new ServiceError("forbidden", "Only the founders can manage companies");
}

const nameSchema = z.string().trim().min(1, "Enter a name").max(80, "At most 80 characters");
const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, "At least 2 characters")
  .max(SLUG_MAX, `At most ${SLUG_MAX} characters`)
  .regex(SLUG_RE, "Only latin letters, digits and single hyphens");
const kindSchema = z.enum(COMPANY_KINDS, { error: "Choose a kind" });
const colorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #1E6B49")
  .transform((s) => s.toUpperCase());
/** Optional text: empty string becomes null. */
const optionalText = (maxLen: number) =>
  z
    .string()
    .trim()
    .max(maxLen, `At most ${maxLen} characters`)
    .nullish()
    .transform((s) => (s ? s : null));

export const companyCreateSchema = z
  .object({
    name: nameSchema,
    /** Empty or missing: made from the name (unique, "-2", "-3" ... appended if needed). */
    slug: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), slugSchema.optional()),
    kind: kindSchema.default("generic"),
    color: colorSchema.default(DEFAULT_COMPANY_COLOR),
    legalName: optionalText(200),
    description: optionalText(2000),
  })
  .strict();
export type CompanyCreateInput = z.input<typeof companyCreateSchema>;

export const companyUpdateSchema = z
  .object({
    name: nameSchema.optional(),
    slug: slugSchema.optional(),
    kind: kindSchema.optional(),
    color: colorSchema.optional(),
    legalName: optionalText(200).optional(),
    description: optionalText(2000).optional(),
  })
  .strict();
export type CompanyUpdateInput = z.input<typeof companyUpdateSchema>;

function slugTaken(): never {
  throw new ServiceError("conflict", "This address (slug) is already used by another company", {
    slug: ["Already used by another company"],
  });
}

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && typeof e === "object" && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

/** foreign_key_violation (NO ACTION) or restrict_violation (ON DELETE RESTRICT). */
function isFkViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && typeof e === "object" && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    const code = (e as { code?: unknown }).code;
    if (code === "23503" || code === "23001") return true;
  }
  return false;
}

async function slugExists(db: Db, slug: string, exceptId?: string): Promise<boolean> {
  const [row] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(exceptId ? and(eq(companies.slug, slug), ne(companies.id, exceptId)) : eq(companies.slug, slug))
    .limit(1);
  return !!row;
}

/** First free slug: base, base-2, base-3 ... (archived companies keep their slug too). */
async function freeSlug(db: Db, base: string): Promise<string> {
  const rows = await db
    .select({ slug: companies.slug })
    .from(companies)
    .where(sql`${companies.slug} = ${base} or ${companies.slug} like ${`${base}-%`}`);
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

async function getCompanyRow(db: Db, id: unknown): Promise<Company> {
  assertValidId(id, "Company");
  const [row] = await db.select().from(companies).where(eq(companies.id, id));
  if (!row) throw new ServiceError("not_found", "Company not found");
  return row;
}

type CountRow = { companyId: string | null; n: number };

/** Usage counts per company id (all companies when `ids` is omitted). */
async function usageByCompany(db: Db, ids?: string[]): Promise<Map<string, CompanyUsage>> {
  const grouped = (table: PgTable, col: AnyPgColumn): Promise<CountRow[]> =>
    db
      .select({ companyId: sql<string | null>`${col}`, n: count() })
      .from(table)
      .where(ids ? inArray(col, ids) : undefined)
      .groupBy(col);
  const [t, pl, md, pr, oc, odv, odp, ofn, ocl, op, oj, ff, ft, ld, lc, cp] = await Promise.all([
    grouped(tasks, tasks.companyId),
    grouped(personCompanies, personCompanies.companyId),
    grouped(metricDefinitions, metricDefinitions.companyId),
    grouped(projects, projects.companyId),
    grouped(orgCharts, orgCharts.companyId),
    grouped(orgDivisions, orgDivisions.companyId),
    grouped(orgDepartments, orgDepartments.companyId),
    grouped(orgFunctions, orgFunctions.companyId),
    grouped(orgChangeLog, orgChangeLog.companyId),
    grouped(orgPosts, orgPosts.companyId),
    grouped(orgJourneySteps, orgJourneySteps.companyId),
    grouped(intercompanyFlows, intercompanyFlows.fromCompanyId),
    grouped(intercompanyFlows, intercompanyFlows.toCompanyId),
    grouped(intercompanyLedgerEntries, intercompanyLedgerEntries.debtorCompanyId),
    grouped(intercompanyLedgerEntries, intercompanyLedgerEntries.creditorCompanyId),
    grouped(clientProjects, clientProjects.companyId),
  ]);
  const out = new Map<string, CompanyUsage>();
  const add = (rows: CountRow[], key: keyof CompanyUsage) => {
    for (const r of rows) {
      if (!r.companyId) continue;
      let u = out.get(r.companyId);
      if (!u) {
        u = emptyUsage();
        out.set(r.companyId, u);
      }
      u[key] += Number(r.n);
    }
  };
  add(t, "tasks");
  add(pl, "peopleLinks");
  add(md, "metricDefinitions");
  add(pr, "projects");
  for (const rows of [oc, odv, odp, ofn, ocl, op, oj]) add(rows, "orgChart");
  for (const rows of [ff, ft, ld, lc]) add(rows, "holdingFlows");
  add(cp, "clientProjects");
  return out;
}

function emptyUsage(): CompanyUsage {
  return { tasks: 0, peopleLinks: 0, metricDefinitions: 0, projects: 0, orgChart: 0, holdingFlows: 0, clientProjects: 0 };
}

function isUnused(u: CompanyUsage): boolean {
  return Object.values(u).every((n) => n === 0);
}

const USAGE_LABELS: Record<keyof CompanyUsage, string> = {
  tasks: "tasks",
  peopleLinks: "people",
  metricDefinitions: "numbers",
  projects: "projects",
  orgChart: "org chart",
  holdingFlows: "holding flows",
  clientProjects: "client projects",
};

/** "12 tasks, 3 people" for a usage summary. */
export function describeUsage(u: CompanyUsage): string {
  return (Object.keys(USAGE_LABELS) as (keyof CompanyUsage)[])
    .filter((k) => u[k] > 0)
    .map((k) => `${u[k]} ${USAGE_LABELS[k]}`)
    .join(", ");
}

/** All companies, archived ones included (active first, in sidebar order). Founders only. */
export async function listCompaniesForSettings(ctx: ServiceContext): Promise<ManagedCompany[]> {
  assertFounder(ctx);
  const [rows, usage] = await Promise.all([
    ctx.db
      .select()
      .from(companies)
      .orderBy(sql`${companies.archivedAt} is not null`, asc(companies.sort), asc(companies.name)),
    usageByCompany(ctx.db),
  ]);
  return rows.map((c) => {
    const u = usage.get(c.id) ?? emptyUsage();
    return { ...c, usage: u, canDelete: isUnused(u) };
  });
}

export async function createCompany(ctx: ServiceContext, input: CompanyCreateInput): Promise<Company> {
  assertFounder(ctx);
  const data = companyCreateSchema.parse(input);
  if (data.slug && (await slugExists(ctx.db, data.slug))) slugTaken();
  const slug = data.slug ?? (await freeSlug(ctx.db, slugifyCompanyName(data.name)));
  const [agg] = await ctx.db.select({ top: max(companies.sort) }).from(companies);
  try {
    const [row] = await ctx.db
      .insert(companies)
      .values({
        slug,
        name: data.name,
        kind: data.kind,
        color: data.color,
        legalName: data.legalName,
        description: data.description,
        sort: (agg?.top ?? 0) + 10,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .returning();
    companiesChanged();
    return row!;
  } catch (err) {
    if (isUniqueViolation(err)) slugTaken();
    throw err;
  }
}

/** Rename, change slug, kind, color, legal name or description. */
export async function updateCompany(ctx: ServiceContext, id: string, input: CompanyUpdateInput): Promise<Company> {
  assertFounder(ctx);
  const current = await getCompanyRow(ctx.db, id);
  const data = companyUpdateSchema.parse(input);
  if (data.slug && data.slug !== current.slug && (await slugExists(ctx.db, data.slug, current.id))) slugTaken();
  const patch: Partial<typeof companies.$inferInsert> = { updatedAt: ctx.now };
  if (data.name !== undefined) patch.name = data.name;
  if (data.slug !== undefined) patch.slug = data.slug;
  if (data.kind !== undefined) patch.kind = data.kind;
  if (data.color !== undefined) patch.color = data.color;
  if (data.legalName !== undefined) patch.legalName = data.legalName;
  if (data.description !== undefined) patch.description = data.description;
  try {
    const [row] = await ctx.db.update(companies).set(patch).where(eq(companies.id, current.id)).returning();
    companiesChanged();
    return row!;
  } catch (err) {
    if (isUniqueViolation(err)) slugTaken();
    throw err;
  }
}

/** Soft delete: hidden everywhere, all data kept. Restorable. */
export async function archiveCompany(ctx: ServiceContext, id: string): Promise<Company> {
  assertFounder(ctx);
  const current = await getCompanyRow(ctx.db, id);
  if (current.archivedAt) return current;
  const [row] = await ctx.db
    .update(companies)
    .set({ archivedAt: ctx.now, updatedAt: ctx.now })
    .where(eq(companies.id, current.id))
    .returning();
  companiesChanged();
  return row!;
}

/** Brings an archived company back, at the end of the sidebar. */
export async function restoreCompany(ctx: ServiceContext, id: string): Promise<Company> {
  assertFounder(ctx);
  const current = await getCompanyRow(ctx.db, id);
  if (!current.archivedAt) return current;
  const [agg] = await ctx.db.select({ top: max(companies.sort) }).from(companies).where(activeCompaniesWhere());
  const [row] = await ctx.db
    .update(companies)
    .set({ archivedAt: null, sort: (agg?.top ?? 0) + 10, updatedAt: ctx.now })
    .where(eq(companies.id, current.id))
    .returning();
  companiesChanged();
  return row!;
}

/** Permanent delete, only for a company nothing refers to; otherwise "archive instead". */
export async function deleteCompany(ctx: ServiceContext, id: string): Promise<void> {
  assertFounder(ctx);
  const current = await getCompanyRow(ctx.db, id);
  const usage = (await usageByCompany(ctx.db, [current.id])).get(current.id) ?? emptyUsage();
  if (!isUnused(usage)) {
    throw new ServiceError(
      "conflict",
      `${current.name} still has ${describeUsage(usage)}, so it cannot be deleted. Archive it instead.`,
    );
  }
  try {
    await ctx.db.transaction(async (tx) => {
      await tx.delete(companies).where(eq(companies.id, current.id));
    });
    companiesChanged();
  } catch (err) {
    // Something else (AI roles, ...) still points at it: the database refuses.
    if (isFkViolation(err)) {
      throw new ServiceError("conflict", `${current.name} is still used elsewhere, so it cannot be deleted. Archive it instead.`);
    }
    throw err;
  }
}

/** Writes sort = 10, 20, 30 ... in the given order. */
async function writeOrder(db: Db, ids: string[], now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    for (const [i, id] of ids.entries()) {
      await tx.update(companies).set({ sort: (i + 1) * 10, updatedAt: now }).where(eq(companies.id, id));
    }
  });
  companiesChanged();
}

/**
 * New sidebar order. `ids` must list every active company exactly once (archived ones
 * keep their sort and come back at the end when restored).
 */
export async function reorderCompanies(ctx: ServiceContext, ids: string[]): Promise<Company[]> {
  assertFounder(ctx);
  const parsed = z.array(z.uuid()).max(500).safeParse(ids);
  if (!parsed.success) throw new ServiceError("validation", "Invalid order");
  const active = await queryCompanies(ctx);
  const activeIds = new Set(active.map((c) => c.id));
  const given = new Set(parsed.data);
  if (given.size !== parsed.data.length || given.size !== activeIds.size || ![...given].every((id) => activeIds.has(id))) {
    throw new ServiceError("conflict", "The company list changed meanwhile. Reload the page and try again.");
  }
  await writeOrder(ctx.db, parsed.data, ctx.now);
  return queryCompanies(ctx);
}

/** One step up or down in the sidebar order (active companies only). */
export async function moveCompany(ctx: ServiceContext, id: string, direction: "up" | "down"): Promise<Company[]> {
  assertFounder(ctx);
  if (direction !== "up" && direction !== "down") throw new ServiceError("validation", "Invalid direction");
  const current = await getCompanyRow(ctx.db, id);
  if (current.archivedAt) throw new ServiceError("validation", "Restore the company before moving it");
  const order = (await queryCompanies(ctx)).map((c) => c.id);
  const i = order.indexOf(current.id);
  const j = direction === "up" ? i - 1 : i + 1;
  if (i >= 0 && j >= 0 && j < order.length) [order[i], order[j]] = [order[j]!, order[i]!];
  await writeOrder(ctx.db, order, ctx.now);
  return queryCompanies(ctx);
}
