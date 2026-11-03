import "server-only";
import { orchestrateTick } from "@/server/ai/orchestrator";
import type { AiPlanReport } from "@/server/services/ai-roles";
import type { Db } from "@/server/db/connect";
import { syncDebtMetric } from "@/server/services/holding";
import { cleanupUnattachedFiles } from "@/server/services/holding-files";
import type { ChannelRegistry } from "./channels";
import { dispatch, type DispatchReport } from "./dispatcher";
import { planTick, type PlanReport } from "./planner";

export interface TickReport {
  now: string;
  plan: PlanReport;
  ai?: AiPlanReport;
  dispatch: DispatchReport;
}

export interface TickOptions {
  registry?: ChannelRegistry;
  /** Only these founders (dev tools). Default: both founders. */
  userIds?: readonly string[];
}

/** One scheduler run: plan (enqueue what is due today) then dispatch (send what is due now). */
export async function runTick(db: Db, now: Date, opts: TickOptions = {}): Promise<TickReport> {
  const plan = await planTick(db, now, { userIds: opts.userIds });
  // Keep the Holding "Intercompany debt total" metric in step (derived; idempotent).
  await syncDebtMetric(db, now, process.env.APP_TIMEZONE || "Asia/Bishkek").catch((err: unknown) =>
    console.error("[tick] debt metric failed", err),
  );
  // AI roles (orchestrator): runs due by schedule, re-checks, data requests, report pushes.
  const ai = await orchestrateTick(db, now).catch((err: unknown) => {
    console.error("[tick] AI roles failed", err);
    return undefined;
  });
  // Uploads never attached to an акт / contract after 24 h (bounded per tick).
  await cleanupUnattachedFiles(db, now).catch((err: unknown) => console.error("[tick] file cleanup failed", err));
  const sent = await dispatch(db, now, { registry: opts.registry, userIds: opts.userIds });
  return { now: now.toISOString(), plan, ai, dispatch: sent };
}
