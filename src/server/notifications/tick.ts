import "server-only";
import { orchestrateTick } from "@/server/ai/orchestrator";
import type { AiPlanReport } from "@/server/services/ai-roles";
import type { Db } from "@/server/db/connect";
import { syncDebtMetric } from "@/server/services/holding";
import { cleanupUnattachedFiles } from "@/server/services/holding-files";
import type { ChannelRegistry } from "./channels";
import { dispatch, type DispatchReport } from "./dispatcher";
import { planStaffTick, planTick, type PlanReport } from "./planner";
import { planRoutinesTick } from "./routine-planner";

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
  /** Plan and send staff (person) messages too. Default true; the founders' dev tick passes false. */
  staff?: boolean;
}

/** One scheduler run: plan (enqueue what is due today) then dispatch (send what is due now). */
export async function runTick(db: Db, now: Date, opts: TickOptions = {}): Promise<TickReport> {
  const plan = await planTick(db, now, { userIds: opts.userIds, staff: opts.staff });
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
  const sent = await dispatch(db, now, { registry: opts.registry, userIds: opts.userIds, staff: opts.staff });
  return { now: now.toISOString(), plan, ai, dispatch: sent };
}

/**
 * Dev tools only: plans and sends STAFF (person) messages at the real current time, into the dev
 * inbox. Refused while a Telegram bot token is configured: real people's messages then go only
 * through the real tick (a simulated run would mark their rows "sent via dev" and use up their
 * slots and daily cap without them ever seeing a message). Without a token the dev inbox IS the
 * only channel, so this is exactly what the next real tick would do — no extra slot, no cap used
 * that the real tick would not have used.
 */
export async function runStaffDevTick(db: Db, now: Date, opts: { registry: ChannelRegistry; telegramConfigured: boolean }) {
  if (opts.telegramConfigured) {
    throw new Error("Staff simulation is off while a Telegram bot token is set: real people are messaged by the real tick only");
  }
  const timeZone = process.env.APP_TIMEZONE || "Asia/Bishkek";
  const plan = await planStaffTick(db, now, timeZone);
  const routines = await planRoutinesTick(db, now, { founders: false });
  const sent = await dispatch(db, now, { registry: opts.registry, onlyStaff: true, timeZone });
  return { now: now.toISOString(), plan, routines, dispatch: sent };
}
