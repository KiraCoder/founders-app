import "server-only";
import { and, eq, isNull, or, type SQL } from "drizzle-orm";
import { companies, taskEvents, tasks } from "@/server/db/schema";
import type { ServiceContext } from "./context";
import { ServiceError } from "./errors";

/**
 * Central access rules. Every query in the services composes these, so there is
 * exactly one place to change when staff accounts arrive.
 *
 * - Founders can see every company and every SHARED task.
 * - A PRIVATE task (personal todo) is visible only to its owner.
 */
export function visibleTasksWhere(ctx: ServiceContext): SQL {
  return or(eq(tasks.visibility, "shared"), eq(tasks.ownerUserId, ctx.user.id))!;
}

/**
 * Audit-log rows follow the same rule as their task. task_events carries a copy of the
 * task's visibility/owner (kept after the task is deleted), so history of a private
 * todo, including deleted ones and tasks that were shared earlier, never leaks.
 */
export function visibleEventsWhere(ctx: ServiceContext): SQL {
  return or(eq(taskEvents.visibility, "shared"), eq(taskEvents.ownerUserId, ctx.user.id))!;
}

/** SQL filter for companies the user may access. */
export function accessibleCompaniesWhere(ctx: ServiceContext): SQL | undefined {
  if (ctx.user.role === "founder") return undefined;
  // Staff membership is a later chunk; until then staff see no companies.
  return eq(companies.id, "00000000-0000-0000-0000-000000000000");
}

export async function assertCompanyAccess(ctx: ServiceContext, companyId: string): Promise<void> {
  const [row] = await ctx.db
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.id, companyId), isNull(companies.archivedAt), accessibleCompaniesWhere(ctx)));
  if (!row) throw new ServiceError("not_found", "Company not found");
}
