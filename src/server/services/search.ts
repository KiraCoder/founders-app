import "server-only";
import { and, asc, eq, ilike, isNull, or } from "drizzle-orm";
import { companies, projects } from "@/server/db/schema";
import { accessibleCompaniesWhere } from "./access";
import type { ServiceContext } from "./context";
import { listTasks, type TaskView } from "./tasks";

export interface SearchResults {
  q: string;
  companies: { id: string; slug: string; name: string }[];
  projects: { id: string; name: string }[];
  tasks: TaskView[];
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/** Simple server-side ILIKE search across companies, projects and visible tasks. */
export async function search(ctx: ServiceContext, rawQ: string): Promise<SearchResults> {
  const q = rawQ.trim().slice(0, 200);
  if (!q) return { q, companies: [], projects: [], tasks: [] };
  const pattern = `%${escapeLike(q)}%`;
  const [c, p, t] = await Promise.all([
    ctx.db
      .select({ id: companies.id, slug: companies.slug, name: companies.name })
      .from(companies)
      .where(
        and(
          isNull(companies.archivedAt),
          accessibleCompaniesWhere(ctx),
          or(ilike(companies.name, pattern), ilike(companies.legalName, pattern)),
        ),
      )
      .orderBy(asc(companies.sort))
      .limit(10),
    ctx.db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .innerJoin(companies, eq(companies.id, projects.companyId))
      .where(and(accessibleCompaniesWhere(ctx), ilike(projects.name, pattern)))
      .orderBy(asc(projects.name))
      .limit(20),
    listTasks(ctx, { q, status: "any", limit: 50 }),
  ]);
  return { q, companies: c, projects: p, tasks: t };
}
