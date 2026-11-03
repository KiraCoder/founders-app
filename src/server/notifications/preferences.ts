import "server-only";
import { eq } from "drizzle-orm";
import { isHmTime } from "@/lib/dates";
import { DEFAULT_OVERDUE_CHASE_STYLE, OVERDUE_CHASE_STYLES, type OverdueChaseStyle } from "@/lib/schemas";
import type { Db } from "@/server/db/connect";
import { notificationPreferences, type NotificationPreferences } from "@/server/db/schema";

export type Preferences = Omit<NotificationPreferences, "userId" | "updatedAt" | "overdueChaseStyle"> & {
  overdueChaseStyle: OverdueChaseStyle;
};

/** Defaults agreed in the brief: 08:30 summary, 19:00 check, quiet 21:00–08:00, 3 extra pushes. */
export const DEFAULT_PREFERENCES: Preferences = {
  morningSummaryTime: "08:30",
  eveningCheckEnabled: true,
  eveningCheckTime: "19:00",
  quietStart: "21:00",
  quietEnd: "08:00",
  maxOtherPerDay: 3,
  urgentAtNight: false,
  overdueChaseStyle: DEFAULT_OVERDUE_CHASE_STYLE,
};

/** The user's saved preferences, or the defaults when they never saved any. */
export async function loadPreferences(db: Db, userId: string): Promise<Preferences> {
  const [row] = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId));
  if (!row) return { ...DEFAULT_PREFERENCES };
  const { userId: _u, updatedAt: _t, ...prefs } = row;
  void _u;
  void _t;
  // The DB has CHECK constraints (migration 0005); this keeps one bad value from ever
  // breaking a dispatch run.
  const hm = (v: string, d: string) => (isHmTime(v) ? v : d);
  const D = DEFAULT_PREFERENCES;
  return {
    ...prefs,
    morningSummaryTime: hm(prefs.morningSummaryTime, D.morningSummaryTime),
    eveningCheckTime: hm(prefs.eveningCheckTime, D.eveningCheckTime),
    quietStart: hm(prefs.quietStart, D.quietStart),
    quietEnd: hm(prefs.quietEnd, D.quietEnd),
    overdueChaseStyle: (OVERDUE_CHASE_STYLES as readonly string[]).includes(prefs.overdueChaseStyle)
      ? (prefs.overdueChaseStyle as OverdueChaseStyle)
      : D.overdueChaseStyle,
    maxOtherPerDay: Number.isInteger(prefs.maxOtherPerDay) && prefs.maxOtherPerDay >= 0 ? Math.min(prefs.maxOtherPerDay, 10) : D.maxOtherPerDay,
  };
}
