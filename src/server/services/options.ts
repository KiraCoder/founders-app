import "server-only";
import { CACHE_TAGS, sharedCache } from "@/server/cache";
import { listCompanies } from "./companies";
import type { ServiceContext } from "./context";
import { assignablePeopleByCompany, listFounders } from "./people";
import { orgDepartmentOptionsByCompany } from "./org";
import { listProjectOptions } from "./projects";
import type { PersonChaseSettings } from "@/lib/task-chase";
import { personChaseSettings } from "./task-activity";

/** Everything the task form needs for its pickers (serializable for client components). */
export interface TaskFormOptions {
  currentUserId: string;
  companies: { id: string; name: string; color: string }[];
  projects: { id: string; name: string; companyId: string }[];
  founders: { id: string; shortName: string }[];
  peopleByCompany: Record<string, { id: string; name: string }[]>;
  /** Org chart departments per company ("21 Отдел владельца"); companies without a chart have none. */
  departmentsByCompany: Record<string, { id: string; label: string }[]>;
  /** Each person's own chase settings, for the form's live chase summary (founders only; else empty). */
  personChase?: Record<string, PersonChaseSettings>;
}

/**
 * The task form's pickers. Every part is shared founder data read through the shared cache
 * (companies, open projects, founders, people, departments, the people's chase settings), so a
 * warm page pays no query for it; staff read the database directly.
 */
export async function getTaskFormOptions(ctx: ServiceContext): Promise<TaskFormOptions> {
  const [companies, projects, founders, peopleByCompany, departmentsByCompany] = await Promise.all([
    listCompanies(ctx),
    listProjectOptions(ctx),
    listFounders(ctx),
    assignablePeopleByCompany(ctx),
    orgDepartmentOptionsByCompany(ctx),
  ]);
  const personIds = [...new Set(Object.values(peopleByCompany).flat().map((p) => p.id))].sort();
  const loadChase = () => personChaseSettings(ctx, personIds, { reachability: false });
  return {
    currentUserId: ctx.user.id,
    companies: companies.map((c) => ({ id: c.id, name: c.name, color: c.color })),
    projects: projects.map((p) => ({ id: p.id, name: p.name, companyId: p.companyId })),
    founders: founders.map((f) => ({ id: f.id, shortName: f.shortName })),
    peopleByCompany,
    departmentsByCompany,
    personChase:
      ctx.user.role === "founder" && personIds.length
        ? await sharedCache(["tasks:person-chase", ...personIds], [CACHE_TAGS.people, CACHE_TAGS.staffSettings], loadChase)
        : await loadChase(),
  };
}
