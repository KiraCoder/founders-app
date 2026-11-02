import "server-only";
import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { companies, metricDefinitions, people, personCompanies, salaryViewers, taskEvents, tasks, users } from "@/server/db/schema";
import type { ServiceContext } from "./context";
import { ServiceError } from "./errors";

/**
 * Central access rules. Every query in the services composes these, so there is
 * exactly one place to change when staff accounts arrive.
 *
 * - Founders can see every company and every SHARED task.
 * - A PRIVATE task (personal todo) is visible only to its owner.
 * - Staff (later) see only companies they belong to; until then, none.
 */
export function visibleTasksWhere(ctx: ServiceContext): SQL {
  const own = eq(tasks.ownerUserId, ctx.user.id);
  const shared = eq(tasks.visibility, "shared");
  const companyFilter = inAccessibleCompany(ctx, tasks.companyId);
  return or(companyFilter ? and(shared, companyFilter)! : shared, own)!;
}

/**
 * Audit-log rows follow the same rule as their task. task_events carries a copy of the
 * task's visibility/owner (kept after the task is deleted), so history of a private
 * todo, including deleted ones and tasks that were shared earlier, never leaks.
 */
export function visibleEventsWhere(ctx: ServiceContext): SQL {
  const own = eq(taskEvents.ownerUserId, ctx.user.id);
  const shared = eq(taskEvents.visibility, "shared");
  const companyFilter = inAccessibleCompany(ctx, taskEvents.companyId);
  return or(companyFilter ? and(shared, companyFilter)! : shared, own)!;
}

/** SQL filter for companies the user may access. */
export function accessibleCompaniesWhere(ctx: ServiceContext): SQL | undefined {
  if (ctx.user.role === "founder") return undefined;
  // Staff membership is a later chunk; until then staff see no companies.
  return eq(companies.id, "00000000-0000-0000-0000-000000000000");
}

/**
 * For any table with a company id column (projects, person_companies, ...): rows of
 * companies the user may access. `undefined` means "no restriction" (founders).
 */
export function inAccessibleCompany(ctx: ServiceContext, companyIdColumn: AnyPgColumn): SQL | undefined {
  const where = accessibleCompaniesWhere(ctx);
  if (!where) return undefined;
  return inArray(companyIdColumn, ctx.db.select({ id: companies.id }).from(companies).where(where));
}

/** People the user may see: founders see everyone, others only people of their companies. */
export function visiblePeopleWhere(ctx: ServiceContext): SQL | undefined {
  const linkFilter = inAccessibleCompany(ctx, personCompanies.companyId);
  if (!linkFilter) return undefined;
  return inArray(
    people.id,
    ctx.db.select({ id: personCompanies.personId }).from(personCompanies).where(linkFilter),
  );
}

export async function assertCompanyAccess(ctx: ServiceContext, companyId: string): Promise<void> {
  const [row] = await ctx.db
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.id, companyId), isNull(companies.archivedAt), accessibleCompaniesWhere(ctx)));
  if (!row) throw new ServiceError("not_found", "Company not found");
}

const uuidSchema = z.uuid();

/**
 * Ids from URLs and forms are untrusted. A malformed id would make Postgres throw
 * (a 500); treat it as "not found" instead.
 */
export function assertValidId(id: unknown, what: string): asserts id is string {
  if (!uuidSchema.safeParse(id).success) throw new ServiceError("not_found", `${what} not found`);
}

// ---------------------------------------------------------------------------
// Salaries (restricted)
// ---------------------------------------------------------------------------

/**
 * Salary access rule: only users listed in `salary_viewers` may see or change salaries
 * (default: Nuraaly only; toggled in Settings → Access by an existing viewer). Everyone
 * else gets no salary data from any service, page, API, search or import preview.
 * Salary rows are additionally limited to companies the user can access
 * (`visibleLinksWhere`).
 */
export async function isSalaryViewer(ctx: ServiceContext): Promise<boolean> {
  // Re-checked in the database on every call: the user must still be a founder (a staff
  // account left in salary_viewers, or a stale session role, gets nothing).
  if (ctx.user.role !== "founder") return false;
  const [row] = await ctx.db
    .select({ userId: salaryViewers.userId })
    .from(salaryViewers)
    .innerJoin(users, eq(users.id, salaryViewers.userId))
    .where(and(eq(salaryViewers.userId, ctx.user.id), eq(users.role, "founder")))
    .limit(1);
  return !!row;
}

/** Throws `forbidden` unless the user is a salary viewer. Call before touching `salaries`. */
export async function assertSalaryViewer(ctx: ServiceContext): Promise<void> {
  if (!(await isSalaryViewer(ctx))) {
    throw new ServiceError("forbidden", "Only salary viewers can see or change salaries");
  }
}

/** Person-company links the user may see (links of accessible companies). */
export function visibleLinksWhere(ctx: ServiceContext): SQL | undefined {
  return inAccessibleCompany(ctx, personCompanies.companyId);
}

// ---------------------------------------------------------------------------
// Numbers (metric definitions and values)
// ---------------------------------------------------------------------------

/**
 * Metric rule: company data is shared between the founders, so a metric (and its values
 * and connector runs) is visible to whoever can access its company, and only there.
 * Archived metrics and metrics of archived companies are hidden. Values are always read
 * through a visible metric (`metric_values` has no company column of its own).
 */
export function visibleMetricsWhere(ctx: ServiceContext): SQL {
  const companyFilter = inAccessibleCompany(ctx, metricDefinitions.companyId);
  const live = and(
    isNull(metricDefinitions.archivedAt),
    inArray(metricDefinitions.companyId, ctx.db.select({ id: companies.id }).from(companies).where(isNull(companies.archivedAt))),
  )!;
  return companyFilter ? and(live, companyFilter)! : live;
}

/** Throws not_found unless the metric exists and is visible. Returns its company id. */
export async function assertMetricAccess(ctx: ServiceContext, metricId: unknown): Promise<string> {
  assertValidId(metricId, "Metric");
  const [row] = await ctx.db
    .select({ companyId: metricDefinitions.companyId })
    .from(metricDefinitions)
    .where(and(eq(metricDefinitions.id, metricId), visibleMetricsWhere(ctx)));
  if (!row) throw new ServiceError("not_found", "Metric not found");
  return row.companyId;
}
