import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { defaultRegistry, type ConnectorRegistry } from "@/server/connectors/registry";
import { recentRange, runConnector, type RunResult } from "@/server/connectors/runner";
import type { ConnectorHealth } from "@/server/connectors/types";
import { companies, connectorRuns } from "@/server/db/schema";
import { assertCompanyAccess, inAccessibleCompany } from "./access";
import type { ServiceContext } from "./context";
import { ServiceError } from "./errors";
import { listCompanies } from "./companies";

/** Status of each data source for the companies the user can access. */
export interface ConnectorStatus {
  id: string;
  name: string;
  companyId: string;
  companySlug: string;
  companyName: string;
  health: ConnectorHealth;
  lastRun: { status: string; message: string | null; at: string; valuesWritten: number } | null;
}

export async function listConnectorStatuses(
  ctx: ServiceContext,
  opts: { companyId?: string; registry?: ConnectorRegistry } = {},
): Promise<ConnectorStatus[]> {
  const registry = opts.registry ?? defaultRegistry();
  const visible = await listCompanies(ctx);
  const bySlug = new Map(visible.map((c) => [c.slug, c]));
  const list = registry
    .all()
    .filter((c) => bySlug.has(c.companySlug) && (!opts.companyId || bySlug.get(c.companySlug)!.id === opts.companyId));
  if (list.length === 0) return [];
  const runs = await ctx.db
    .select()
    .from(connectorRuns)
    .where(and(inArray(connectorRuns.connectorId, list.map((c) => c.id)), inAccessibleCompany(ctx, connectorRuns.companyId)))
    .orderBy(desc(connectorRuns.startedAt))
    .limit(200);
  return Promise.all(
    list.map(async (c) => {
      const company = bySlug.get(c.companySlug)!;
      const last = runs.find((r) => r.connectorId === c.id && r.companyId === company.id);
      return {
        id: c.id,
        name: c.name,
        companyId: company.id,
        companySlug: company.slug,
        companyName: company.name,
        health: await c.healthCheck(),
        lastRun: last
          ? { status: last.status, message: last.message, at: last.startedAt.toISOString(), valuesWritten: last.valuesWritten }
          : null,
      };
    }),
  );
}

/** "Check now": runs a connector for the last 7 days, as the signed-in founder. */
export async function checkConnector(ctx: ServiceContext, id: string, registry?: ConnectorRegistry): Promise<RunResult> {
  const reg = registry ?? defaultRegistry();
  const connector = reg.get(id);
  if (!connector) throw new ServiceError("not_found", "Data source not found");
  const [company] = await ctx.db.select({ id: companies.id }).from(companies).where(eq(companies.slug, connector.companySlug));
  if (!company) throw new ServiceError("not_found", "Data source not found");
  await assertCompanyAccess(ctx, company.id);
  return runConnector(ctx.db, id, recentRange(ctx.now, 7, ctx.timeZone), {
    registry: reg,
    now: ctx.now,
    timeZone: ctx.timeZone,
    triggeredBy: ctx.user.id,
  });
}
