import "server-only";
import type { Db } from "@/server/db/connect";
import type { ChannelRegistry } from "./channels";
import { dispatch, type DispatchReport } from "./dispatcher";
import { planTick, type PlanReport } from "./planner";

export interface TickReport {
  now: string;
  plan: PlanReport;
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
  const sent = await dispatch(db, now, { registry: opts.registry, userIds: opts.userIds });
  return { now: now.toISOString(), plan, dispatch: sent };
}
