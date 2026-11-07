import "server-only";
import { and, asc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { projectCreateSchema, type ProjectCreateInput } from "@/lib/schemas";
import { CACHE_TAGS, invalidate, sharedCache } from "@/server/cache";
import { companies, projects, tasks, users, type Project } from "@/server/db/schema";
import { accessibleCompaniesWhere, assertCompanyAccess, assertValidId, visibleTasksWhere } from "./access";
import type { ServiceContext } from "./context";
import { ServiceError } from "./errors";

export interface ProjectView extends Project {
  companySlug: string;
  companyName: string;
  ownerName: string | null;
  totalTasks: number;
  doneTasks: number;
  /** 0..100, done / (all - cancelled). */
  progress: number;
}

function projectQuery(ctx: ServiceContext) {
  const visible = visibleTasksWhere(ctx);
  return ctx.db
    .select({
      project: projects,
      companySlug: companies.slug,
      companyName: companies.name,
      ownerName: users.shortName,
      totalTasks: sql<number>`(select count(*) from ${tasks} where ${tasks.projectId} = ${projects.id} and ${tasks.status} <> 'cancelled' and ${visible})`.mapWith(
        Number,
      ),
      doneTasks: sql<number>`(select count(*) from ${tasks} where ${tasks.projectId} = ${projects.id} and ${tasks.status} = 'done' and ${visible})`.mapWith(
        Number,
      ),
    })
    .from(projects)
    .innerJoin(companies, eq(companies.id, projects.companyId))
    .leftJoin(users, eq(users.id, projects.ownerUserId));
}

type Row = Awaited<ReturnType<ReturnType<typeof projectQuery>["execute"]>>[number];

function toView(r: Row): ProjectView {
  return {
    ...r.project,
    companySlug: r.companySlug,
    companyName: r.companyName,
    ownerName: r.ownerName,
    totalTasks: r.totalTasks,
    doneTasks: r.doneTasks,
    progress: r.totalTasks === 0 ? 0 : Math.round((r.doneTasks / r.totalTasks) * 100),
  };
}

export async function listProjects(ctx: ServiceContext, opts: { companyId?: string } = {}): Promise<ProjectView[]> {
  const rows = await projectQuery(ctx)
    .where(
      and(
        accessibleCompaniesWhere(ctx),
        isNull(companies.archivedAt),
        opts.companyId ? eq(projects.companyId, opts.companyId) : undefined,
      ),
    )
    .orderBy(asc(companies.sort), asc(projects.name));
  return rows.map(toView);
}

/** A project as the task form's picker needs it. */
export interface ProjectOption {
  id: string;
  name: string;
  companyId: string;
}

/**
 * Open projects (not done / cancelled) of live companies, for pickers. No task counts, so it is
 * the same for both founders: read through the shared cache (tags `projects`, `companies`).
 */
export async function listProjectOptions(ctx: ServiceContext): Promise<ProjectOption[]> {
  const load = () =>
    ctx.db
      .select({ id: projects.id, name: projects.name, companyId: projects.companyId })
      .from(projects)
      .innerJoin(companies, eq(companies.id, projects.companyId))
      .where(and(accessibleCompaniesWhere(ctx), isNull(companies.archivedAt), notInArray(projects.status, ["done", "cancelled"])))
      .orderBy(asc(companies.sort), asc(projects.name));
  return ctx.user.role === "founder" ? sharedCache(["projects:options"], [CACHE_TAGS.projects, CACHE_TAGS.companies], load) : load();
}

export async function getProject(ctx: ServiceContext, id: string): Promise<ProjectView> {
  assertValidId(id, "Project");
  const [row] = await projectQuery(ctx).where(and(eq(projects.id, id), accessibleCompaniesWhere(ctx)));
  if (!row) throw new ServiceError("not_found", "Project not found");
  return toView(row);
}

export async function createProject(ctx: ServiceContext, input: ProjectCreateInput): Promise<ProjectView> {
  const data = projectCreateSchema.parse(input);
  await assertCompanyAccess(ctx, data.companyId);
  if (data.startDate && data.dueDate && data.dueDate < data.startDate) {
    throw new ServiceError("validation", "Due date is before start date", { dueDate: ["Before start date"] });
  }
  const [row] = await ctx.db
    .insert(projects)
    .values({ ...data, description: data.description ?? null, ownerUserId: ctx.user.id })
    .returning({ id: projects.id });
  invalidate(CACHE_TAGS.projects);
  return getProject(ctx, row!.id);
}
