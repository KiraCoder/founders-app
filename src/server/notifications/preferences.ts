import "server-only";
import { eq } from "drizzle-orm";
import type { Db } from "@/server/db/connect";
import { notificationPreferences, type NotificationPreferences } from "@/server/db/schema";

export type Preferences = Omit<NotificationPreferences, "userId" | "updatedAt">;

/** Defaults agreed in the brief: 08:30 summary, 19:00 check, quiet 21:00–08:00, 3 extra pushes. */
export const DEFAULT_PREFERENCES: Preferences = {
  morningSummaryTime: "08:30",
  eveningCheckEnabled: true,
  eveningCheckTime: "19:00",
  quietStart: "21:00",
  quietEnd: "08:00",
  maxOtherPerDay: 3,
  urgentAtNight: false,
};

/** The user's saved preferences, or the defaults when they never saved any. */
export async function loadPreferences(db: Db, userId: string): Promise<Preferences> {
  const [row] = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId));
  if (!row) return { ...DEFAULT_PREFERENCES };
  const { userId: _u, updatedAt: _t, ...prefs } = row;
  void _u;
  void _t;
  return prefs;
}
