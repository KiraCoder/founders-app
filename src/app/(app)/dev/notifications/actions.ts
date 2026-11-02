"use server";

import { revalidatePath } from "next/cache";
import { todayInTimeZone, zonedTimeToUtc } from "@/lib/dates";
import { getPageContext } from "@/server/context";
import { devToolsEnabled } from "@/server/notifications/config";
import { runTick } from "@/server/notifications/tick";
import { getMyPreferences } from "@/server/services/notifications";

/**
 * Dev only: runs the scheduler (for both founders, exactly like the cron would).
 * "morning"/"evening" pretend it is the signed-in founder's summary time today.
 */
export async function runTickAction(fd: FormData): Promise<void> {
  if (!devToolsEnabled()) throw new Error("Developer tools are disabled");
  const ctx = await getPageContext();
  const mode = String(fd.get("mode") ?? "now");
  let now = new Date();
  if (mode === "morning" || mode === "evening") {
    const prefs = await getMyPreferences(ctx);
    const day = todayInTimeZone(now, ctx.timeZone);
    now = zonedTimeToUtc(day, mode === "morning" ? prefs.morningSummaryTime : prefs.eveningCheckTime, ctx.timeZone);
  }
  await runTick(ctx.db, now);
  revalidatePath("/dev/notifications");
}
