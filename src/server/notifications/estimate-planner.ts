import "server-only";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { workingMinutesBetween } from "@/lib/work-hours";
import { effectiveStaffSettings, parsePersonOverride, parseTaskOverride, taskChaseSettings } from "@/lib/staff-schemas";
import { prefixFromSlug, PERSONAL_PREFIX, taskKey } from "@/lib/task-keys";
import type { Db } from "@/server/db/connect";
import { companies, people, tasks, telegramLinks, users } from "@/server/db/schema";
import { workWindowsFor } from "@/server/services/estimates";
import { loadStaffDefaults } from "@/server/services/staff";
import { RU } from "./messages-ru";
import { enqueueForPerson } from "./outbox";
import { notifyFounders } from "./staff-notify";

/**
 * "Over estimate" (0034): a task In Progress longer than its estimate (1 point = 1 working hour
 * of the assignee's work window, Mon–Sat, Asia/Bishkek) is flagged once per In Progress stint
 * (tasks.over_estimate_notified_at, claimed atomically so two ticks never both send):
 * - the assigned PERSON gets one Russian nudge with the task's buttons — unless the task's
 *   chasing is off or paused, or the bot may not message them (the staff dispatcher still applies
 *   quiet hours and their daily cap);
 * - the task's founder (and a founder assignee) gets ONE line in the next summary (no push).
 */
export async function planOverEstimates(db: Db, now: Date, timeZone: string): Promise<{ flagged: number; nudged: number }> {
  const out = { flagged: 0, nudged: 0 };
  const rows = await db
    .select({
      t: tasks,
      companySlug: companies.slug,
      companyPrefix: companies.taskPrefix,
      personName: people.fullName,
      personShort: people.shortName,
      personChase: people.staffChase,
      botEnabled: people.botEnabled,
      pausedUntil: people.botPausedUntil,
      leftAt: people.leftAt,
      linkStopped: telegramLinks.stoppedAt,
      linkId: telegramLinks.id,
      founderName: users.shortName,
    })
    .from(tasks)
    .leftJoin(companies, eq(companies.id, tasks.companyId))
    .leftJoin(people, eq(people.id, tasks.assigneePersonId))
    .leftJoin(telegramLinks, eq(telegramLinks.personId, tasks.assigneePersonId))
    .leftJoin(users, eq(users.id, tasks.assigneeUserId))
    .where(
      and(
        eq(tasks.status, "in_progress"),
        isNotNull(tasks.estimate),
        isNotNull(tasks.startedAt),
        isNull(tasks.overEstimateNotifiedAt),
        sql`(${tasks.companyId} is null or ${companies.archivedAt} is null)`,
      ),
    );
  if (!rows.length) return out;
  const windows = await workWindowsFor(db, timeZone, rows.map((r) => r.t));
  const defaults = await loadStaffDefaults(db);
  for (const r of rows) {
    const t = r.t;
    const w = windows.get(t.id);
    if (!w || !t.estimate || !t.startedAt) continue;
    const minutes = workingMinutesBetween(t.startedAt, now, w);
    if (minutes <= t.estimate * 60) continue;
    // Claim it: only one tick sends the nudge for this stint.
    const claimed = await db
      .update(tasks)
      .set({ overEstimateNotifiedAt: now })
      .where(and(eq(tasks.id, t.id), isNull(tasks.overEstimateNotifiedAt), eq(tasks.status, "in_progress")))
      .returning({ id: tasks.id });
    if (!claimed.length) continue;
    out.flagged++;
    const key = taskKey(t.companyId ? (r.companyPrefix ?? prefixFromSlug(r.companySlug ?? "")) : PERSONAL_PREFIX, t.number);
    const hours = Math.round((minutes / 60) * 10) / 10;
    const who = t.assigneePersonId ? (r.personShort || r.personName || "?") : t.assigneeUserId ? (r.founderName ?? "?") : "nobody";
    const stint = t.startedAt.toISOString();

    if (t.assigneePersonId && t.visibility === "shared") {
      const settings = effectiveStaffSettings(defaults, parsePersonOverride(r.personChase));
      const chase = taskChaseSettings(settings, parseTaskOverride(t.staffChase));
      const reachable = !!r.linkId && !r.linkStopped && r.botEnabled && !r.leftAt && !(r.pausedUntil && r.pausedUntil.getTime() > now.getTime());
      if (chase.chaseEnabled && reachable) {
        const created = await enqueueForPerson(db, {
          personId: t.assigneePersonId,
          kind: "staff_info",
          taskId: t.id,
          dedupeKey: `estimate:${t.id}:${stint}`,
          scheduledFor: now,
          expiresAt: new Date(now.getTime() + 24 * 3_600_000),
          priority: "normal",
          payload: { text: RU.overEstimate(t.title, t.estimate), reason: "over_estimate" },
        });
        if (created.created) out.nudged++;
      }
    }
    const recipients = [...new Set([t.ownerUserId, ...(t.assigneeUserId ? [t.assigneeUserId] : [])])];
    await notifyFounders(db, {
      userIds: recipients,
      line: `Over estimate: ${key} ${t.title} — ▲ ${t.estimate} (${t.estimate} h), in progress ${hours} working h (${who})`,
      taskId: t.id,
      dedupeKey: `estimate:${t.id}:${stint}`,
      now,
    });
  }
  return out;
}
