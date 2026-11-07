import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { defaultRegistry, type ConnectorRegistry } from "@/server/connectors/registry";
import { checkRange, RUN_STALE_MS, runConnector, type RunResult } from "@/server/connectors/runner";
import { companies, connectorRuns } from "@/server/db/schema";
import { assertCompanyAccess, inAccessibleCompany } from "./access";
import type { ServiceContext } from "./context";
import { ServiceError } from "./errors";
import { listCompanies } from "./companies";

export type ConnectorState = "ok" | "not_configured" | "error" | "running" | "unknown";

/**
 * Status of each data source for the companies the user can access. Read from the
 * connector's static setup and the LAST recorded run: rendering a page never calls a
 * source (healthCheck runs only on "Check now" / a scheduled run).
 */
export interface ConnectorStatus {
  id: string;
  name: string;
  companyId: string;
  companySlug: string;
  companyName: string;
  health: { state: ConnectorState; message: string; envVars: string[]; missingEnv: string[] };
  lastRun: { status: string; message: string | null; at: string; valuesWritten: number; conflicts: number } | null;
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
  return list.map((c) => {
    const company = bySlug.get(c.companySlug)!;
    const last = runs.find((r) => r.connectorId === c.id && r.companyId === company.id);
    const setup = c.setup();
    const interrupted = last?.status === "running" && ctx.now.getTime() - last.startedAt.getTime() > RUN_STALE_MS;
    let state: ConnectorState;
    let message: string;
    if (!setup.configured) {
      state = "not_configured";
      message = setup.message;
    } else if (!last) {
      state = "unknown";
      message = "Not checked yet";
    } else if (interrupted) {
      state = "error";
      message = "The last check did not finish";
    } else {
      state = last.status;
      message = last.message ?? "";
    }
    return {
      id: c.id,
      name: c.name,
      companyId: company.id,
      companySlug: company.slug,
      companyName: company.name,
      health: { state, message, envVars: setup.envVars, missingEnv: setup.missingEnv },
      lastRun: last
        ? {
            status: interrupted ? "interrupted" : last.status,
            message: last.message,
            at: last.startedAt.toISOString(),
            valuesWritten: last.valuesWritten,
            conflicts: last.details?.conflicts?.length ?? 0,
          }
        : null,
    };
  });
}

/** "Check now": runs a connector (from the 1st of last month to yesterday), as the signed-in founder. */
export async function checkConnector(ctx: ServiceContext, id: string, registry?: ConnectorRegistry): Promise<RunResult> {
  const reg = registry ?? defaultRegistry();
  const connector = reg.get(id);
  if (!connector) throw new ServiceError("not_found", "Data source not found");
  const [company] = await ctx.db.select({ id: companies.id }).from(companies).where(eq(companies.slug, connector.companySlug));
  if (!company) throw new ServiceError("not_found", "Data source not found");
  await assertCompanyAccess(ctx, company.id);
  return runConnector(ctx.db, id, checkRange(ctx.now, ctx.timeZone), {
    registry: reg,
    now: ctx.now,
    timeZone: ctx.timeZone,
    triggeredBy: ctx.user.id,
  });
}
