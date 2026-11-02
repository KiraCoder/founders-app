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

/** One scheduler run: plan (enqueue what is due today) then dispatch (send what is due now). */
export async function runTick(db: Db, now: Date, opts: { registry?: ChannelRegistry } = {}): Promise<TickReport> {
  const plan = await planTick(db, now);
  const sent = await dispatch(db, now, { registry: opts.registry });
  return { now: now.toISOString(), plan, dispatch: sent };
}
