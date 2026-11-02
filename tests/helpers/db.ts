import { connectDb, type DbHandle } from "@/server/db/connect";
import { runMigrations } from "@/server/db/migrate";
import { FOUNDERS, seed, type SeedResult } from "@/server/db/seed";
import type { SessionUser } from "@/server/auth/types";
import type { ServiceContext } from "@/server/services/context";

export interface TestDb extends SeedResult {
  handle: DbHandle;
  founders: { nuraaly: SessionUser; talant: SessionUser };
  ctx: (who: "nuraaly" | "talant", now?: Date) => ServiceContext;
}

/** 2026-11-02 12:00 in Bishkek (06:00 UTC). */
export const FIXED_NOW = new Date("2026-11-02T06:00:00Z");

export async function createTestDb(opts: { withSamples?: boolean; now?: Date } = {}): Promise<TestDb> {
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
  const mk = (key: "nuraaly" | "talant"): SessionUser => {
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
