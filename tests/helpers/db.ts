import { connectDb, type DbHandle } from "@/server/db/connect";
import { runMigrations } from "@/server/db/migrate";
import { inArray } from "drizzle-orm";
import { FOUNDERS, seed, type SeedResult } from "@/server/db/seed";
import { notificationPreferences, salaryViewers } from "@/server/db/schema";
import type { OverdueChaseStyle } from "@/lib/schemas";
import type { SessionUser } from "@/server/auth/types";
import type { ServiceContext } from "@/server/services/context";

export interface TestDb extends SeedResult {
  handle: DbHandle;
  founders: { nuraaly: SessionUser; talant: SessionUser };
  ctx: (who: "nuraaly" | "talant", now?: Date) => ServiceContext;
}

/** 2026-11-02 12:00 in Bishkek (06:00 UTC). */
export const FIXED_NOW = new Date("2026-11-02T06:00:00Z");

type FounderKey = "nuraaly" | "talant";

export interface TestDbOptions {
  withSamples?: boolean;
  now?: Date;
  /**
   * Who sees salaries. Default: the seed's (both founders, the founders' decision). Tests of
   * the "not a salary viewer" rules pass ["nuraaly"].
   */
  salaryViewers?: FounderKey[];
  /**
   * Saved overdue chase style for both founders. Default: none saved (the app default,
   * "grouped"). Tests of one push per task pass "separate".
   */
  overdueChaseStyle?: OverdueChaseStyle;
}

export async function createTestDb(opts: TestDbOptions = {}): Promise<TestDb> {
  const handle = await connectDb("memory://");
  await runMigrations(handle);
  const now = opts.now ?? FIXED_NOW;
  const seeded = await seed(handle.db, {
    password: "test-password",
    bcryptRounds: 4,
    now,
    timeZone: "Asia/Bishkek",
    withSamples: opts.withSamples ?? false,
  });
  if (opts.salaryViewers) {
    const keep = new Set(opts.salaryViewers.map((k) => seeded.userIds[k]));
    const drop = Object.values(seeded.userIds).filter((id) => !keep.has(id));
    if (drop.length) await handle.db.delete(salaryViewers).where(inArray(salaryViewers.userId, drop));
  }
  if (opts.overdueChaseStyle) await saveChaseStyle(handle.db, Object.values(seeded.userIds), opts.overdueChaseStyle);
  const mk = (key: FounderKey): SessionUser => {
    const f = FOUNDERS.find((x) => x.key === key)!;
    return { id: seeded.userIds[key], email: f.email, name: f.name, shortName: f.shortName, role: "founder" };
  };
  const founders = { nuraaly: mk("nuraaly"), talant: mk("talant") };
  return {
    ...seeded,
    handle,
    founders,
    ctx: (who, at = now) => ({ db: handle.db, user: founders[who], now: at, timeZone: "Asia/Bishkek" }),
  };
}

/** Saves an overdue chase style (other preferences at their defaults) for these users. */
export async function saveChaseStyle(db: DbHandle["db"], userIds: string[], style: OverdueChaseStyle): Promise<void> {
  await db
    .insert(notificationPreferences)
    .values(userIds.map((userId) => ({ userId, overdueChaseStyle: style })))
    .onConflictDoUpdate({ target: notificationPreferences.userId, set: { overdueChaseStyle: style } });
}
