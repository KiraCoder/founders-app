import "server-only";
import { listCompanies } from "./companies";
import type { ServiceContext } from "./context";
import { assignablePeopleByCompany, listFounders } from "./people";
import { orgDepartmentOptionsByCompany } from "./org";
import { listProjects } from "./projects";
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

export async function getTaskFormOptions(ctx: ServiceContext): Promise<TaskFormOptions> {
  const [companies, projects, founders, peopleByCompany, departmentsByCompany] = await Promise.all([
    listCompanies(ctx),
    listProjects(ctx),
    listFounders(ctx),
    assignablePeopleByCompany(ctx),
    orgDepartmentOptionsByCompany(ctx),
  ]);
  return {
    currentUserId: ctx.user.id,
    companies: companies.map((c) => ({ id: c.id, name: c.name, color: c.color })),
    projects: projects
      .filter((p) => p.status !== "done" && p.status !== "cancelled")
      .map((p) => ({ id: p.id, name: p.name, companyId: p.companyId })),
    founders: founders.map((f) => ({ id: f.id, shortName: f.shortName })),
    peopleByCompany,
    departmentsByCompany,
    personChase: await personChaseSettings(ctx, [...new Set(Object.values(peopleByCompany).flat().map((p) => p.id))], { reachability: false }),
  };
}
