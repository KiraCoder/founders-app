import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { companies, companyUnits, projects, type Company, type CompanyUnit } from "@/server/db/schema";
import { accessibleCompaniesWhere, inAccessibleCompany } from "./access";
import type { ServiceContext } from "./context";
import { ServiceError } from "./errors";
import { taskCountsByCompany } from "./tasks";

export interface CompanyCard extends Company {
  openTasks: number;
  overdueTasks: number;
  activeProjects: number;
}

/** Active (non-archived) companies the user can access, in sidebar order. */
export async function listCompanies(ctx: ServiceContext): Promise<Company[]> {
  return ctx.db
    .select()
    .from(companies)
    .where(and(isNull(companies.archivedAt), accessibleCompaniesWhere(ctx)))
    .orderBy(asc(companies.sort), asc(companies.name));
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

export async function getCompanyBySlug(
  ctx: ServiceContext,
  slug: string,
): Promise<CompanyCard & { units: CompanyUnit[] }> {
  const cards = await listCompanyCards(ctx);
  const company = cards.find((c) => c.slug === slug);
  if (!company) throw new ServiceError("not_found", "Company not found");
  const units = await ctx.db
    .select()
    .from(companyUnits)
    .where(and(eq(companyUnits.companyId, company.id), isNull(companyUnits.archivedAt)))
    .orderBy(asc(companyUnits.sort));
  return { ...company, units };
}
