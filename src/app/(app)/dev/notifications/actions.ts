"use server";

import { revalidatePath } from "next/cache";
import { todayInTimeZone, zonedTimeToUtc } from "@/lib/dates";
import { getPageContext } from "@/server/context";
import { createDevRegistry } from "@/server/notifications/channels";
import { devToolsEnabled, telegramBotToken } from "@/server/notifications/config";
import { runStaffDevTick, runTick } from "@/server/notifications/tick";
import { assertStaffBotAccess } from "@/server/services/access";
import { getMyPreferences } from "@/server/services/notifications";

/**
 * Dev only: runs the scheduler for the SIGNED-IN founder only, delivering into the dev
 * inbox (never Telegram, even when a bot token is configured, e.g. on a preview).
 * "morning"/"evening" pretend it is that founder's summary time today.
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
  // Founders only, and never staff: a simulated "morning" must not plan or send people's messages
  // (it would use up their real slots and daily cap). Staff have their own button below.
  await runTick(ctx.db, now, { registry: createDevRegistry(), userIds: [ctx.user.id], staff: false });
  revalidatePath("/dev/notifications");
}

/**
 * Dev only: "Simulate staff tick" — staff (people) messages at the real current time into the dev
 * inbox. Refused while a Telegram bot token is set (see runStaffDevTick).
 */
export async function runStaffTickAction(): Promise<void> {
  if (!devToolsEnabled()) throw new Error("Developer tools are disabled");
  const ctx = await getPageContext();
  assertStaffBotAccess(ctx);
  await runStaffDevTick(ctx.db, new Date(), { registry: createDevRegistry(), telegramConfigured: !!telegramBotToken() });
  revalidatePath("/dev/notifications");
}
