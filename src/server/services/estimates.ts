import "server-only";
import { eq, inArray } from "drizzle-orm";
import { DEFAULT_STAFF_SETTINGS, effectiveStaffSettings, parsePersonOverride, parseStaffDefaults, STAFF_DEFAULTS_KEY } from "@/lib/staff-schemas";
import { isOverEstimate, type WorkWindow } from "@/lib/work-hours";
import type { Db } from "@/server/db/connect";
import { appSettings, people } from "@/server/db/schema";

/**
 * Estimates (0034): 1 point = 1 working hour of the assignee's work window (Settings → Team on
 * Telegram: the person's own hours, else the team defaults), Monday–Saturday, Asia/Bishkek.
 * A task In Progress longer than that is "Over estimate" (a badge; one nudge, planner.ts).
 */

export interface EstimateCandidate {
  id: string;
  status: string;
  estimate: number | null;
  startedAt: Date | null;
  assigneePersonId: string | null;
}

const candidate = (t: EstimateCandidate) => t.status === "in_progress" && !!t.estimate && !!t.startedAt;

/** The work window of each task's assignee (only tasks that can be over estimate are looked up). */
export async function workWindowsFor(db: Db, timeZone: string, list: readonly EstimateCandidate[]): Promise<Map<string, WorkWindow>> {
  const out = new Map<string, WorkWindow>();
  const todo = list.filter(candidate);
  if (!todo.length) return out;
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, STAFF_DEFAULTS_KEY));
  const defaults = row ? parseStaffDefaults(row.value) : { ...DEFAULT_STAFF_SETTINGS };
  const personIds = [...new Set(todo.flatMap((t) => (t.assigneePersonId ? [t.assigneePersonId] : [])))];
  const overrides = personIds.length ? await db.select({ id: people.id, c: people.staffChase }).from(people).where(inArray(people.id, personIds)) : [];
  const byPerson = new Map(overrides.map((p) => [p.id, effectiveStaffSettings(defaults, parsePersonOverride(p.c))]));
  for (const t of todo) {
    const s = (t.assigneePersonId && byPerson.get(t.assigneePersonId)) || defaults;
    out.set(t.id, { workStart: s.workStart, workEnd: s.workEnd, timeZone });
  }
  return out;
}

/** Ids of the tasks that are In Progress longer than their estimate (working hours). */
export async function overEstimateIds(db: Db, timeZone: string, now: Date, list: readonly EstimateCandidate[]): Promise<Set<string>> {
  const windows = await workWindowsFor(db, timeZone, list);
  const out = new Set<string>();
  for (const t of list) {
    const w = windows.get(t.id);
    if (w && isOverEstimate(t, now, w)) out.add(t.id);
  }
  return out;
}
