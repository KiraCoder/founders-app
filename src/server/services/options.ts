import "server-only";
import { listCompanies } from "./companies";
import type { ServiceContext } from "./context";
import { assignablePeopleByCompany, listFounders } from "./people";
import { listProjects } from "./projects";

/** Everything the task form needs for its pickers (serializable for client components). */
export interface TaskFormOptions {
  currentUserId: string;
  companies: { id: string; name: string; color: string }[];
  projects: { id: string; name: string; companyId: string }[];
  founders: { id: string; shortName: string }[];
  peopleByCompany: Record<string, { id: string; name: string }[]>;
}

export async function getTaskFormOptions(ctx: ServiceContext): Promise<TaskFormOptions> {
  const [companies, projects, founders, peopleByCompany] = await Promise.all([
    listCompanies(ctx),
    listProjects(ctx),
    listFounders(ctx),
    assignablePeopleByCompany(ctx),
  ]);
  return {
    currentUserId: ctx.user.id,
    companies: companies.map((c) => ({ id: c.id, name: c.name, color: c.color })),
    projects: projects
      .filter((p) => p.status !== "done" && p.status !== "cancelled")
      .map((p) => ({ id: p.id, name: p.name, companyId: p.companyId })),
    founders: founders.map((f) => ({ id: f.id, shortName: f.shortName })),
    peopleByCompany,
  };
}
