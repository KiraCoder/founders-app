/**
 * `npm run db:seed:deploy` (Vercel build step): only with SEED_ON_BUILD=1 + DATABASE_URL, only
 * on a database without founders, with every guard of `npm run db:seed`.
 */
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { count, eq, like } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { connectDb, type DbHandle } from "@/server/db/connect";
import { runMigrations } from "@/server/db/migrate";
import { DEV_PASSWORD_DEFAULT } from "@/server/db/seed";
import { runDeploySeed, seedOnBuildDecision } from "@/server/db/seed-deploy";
import { salaryViewers, tasks, users } from "@/server/db/schema";

const SUPABASE = "postgresql://postgres.abc:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres";

describe("seedOnBuildDecision", () => {
  it("is off unless SEED_ON_BUILD=1, and skips (exit 0) without DATABASE_URL", () => {
    expect(seedOnBuildDecision({}).run).toBe(false);
    expect(seedOnBuildDecision({ SEED_ON_BUILD: "true", DATABASE_URL: SUPABASE }).run).toBe(false);
    const noDb = seedOnBuildDecision({ SEED_ON_BUILD: "1" });
    expect(noDb.run).toBe(false);
    expect(noDb.message).toContain("skipped");
    expect(seedOnBuildDecision({ SEED_ON_BUILD: "1", DATABASE_URL: SUPABASE }).run).toBe(true);
  });

  it("the npm script prints skipped and touches nothing when the flag is off or there is no database", () => {
    for (const env of [
      { SEED_ON_BUILD: "", DATABASE_URL: "postgresql://nobody@127.0.0.1:1/none" },
      { SEED_ON_BUILD: "1", DATABASE_URL: "" },
    ]) {
      const out = execFileSync("npx", ["tsx", "scripts/db-seed-deploy.ts"], { env: { ...process.env, ...env }, encoding: "utf8" });
      expect(out).toContain("skipped");
    }
  }, 60_000);
});

describe("runDeploySeed", () => {
  let handle: DbHandle;
  afterEach(async () => {
    await handle?.close();
  });

  async function fresh(): Promise<DbHandle> {
    handle = await connectDb("memory://");
    await runMigrations(handle);
    return handle;
  }
  /** The real-database guards apply to the postgres driver; PGlite stands in for it here. */
  const asPostgres = (h: DbHandle): DbHandle => ({ ...h, driver: "postgres" });

  it("refuses a real database without a strong password (dev default, short, missing)", async () => {
    const h = asPostgres(await fresh());
    for (const DEV_FOUNDER_PASSWORD of [undefined, DEV_PASSWORD_DEFAULT, "short-pw-11"]) {
      const r = await runDeploySeed(h, { DATABASE_URL: SUPABASE, DEV_FOUNDER_PASSWORD }, { bcryptRounds: 4 });
      expect(r.status).toBe("refused");
    }
    expect((await h.db.select({ n: count() }).from(users))[0]!.n).toBe(0);
  });

  it("seeds an empty real database once: both founders, both salary viewers, no samples", async () => {
    const h = asPostgres(await fresh());
    const env = { DATABASE_URL: SUPABASE, DEV_FOUNDER_PASSWORD: "a-private-pass-123" };
    const r = await runDeploySeed(h, env, { bcryptRounds: 4 });
    expect(r.status).toBe("seeded");
    const founders = await h.db.select().from(users).where(eq(users.role, "founder"));
    expect(founders.map((f) => f.email).sort()).toEqual(["nuraaly@founders.local", "talant@founders.local"]);
    expect(await bcrypt.compare("a-private-pass-123", founders[0]!.passwordHash!)).toBe(true);
    expect(await h.db.select().from(salaryViewers)).toHaveLength(2);
    expect(await h.db.select().from(tasks).where(like(tasks.title, "[sample]%"))).toHaveLength(0);

    // A later deploy changes nothing: not the password, not a changed email (no re-created founder).
    await h.db.update(users).set({ email: "nuraaly@asqa.kg" }).where(eq(users.email, "nuraaly@founders.local"));
    const again = await runDeploySeed(h, { ...env, DEV_FOUNDER_PASSWORD: "another-private-pass-456", SEED_RESET_PASSWORDS: "1" }, { bcryptRounds: 4 });
    expect(again.status).toBe("skipped");
    const after = await h.db.select().from(users).where(eq(users.role, "founder"));
    expect(after.map((f) => f.email).sort()).toEqual(["nuraaly@asqa.kg", "talant@founders.local"]);
    for (const f of after) expect(await bcrypt.compare("a-private-pass-123", f.passwordHash!)).toBe(true);
  });

  it("adds [sample] tasks on Postgres only with SEED_SAMPLES=1", async () => {
    const h = asPostgres(await fresh());
    const r = await runDeploySeed(h, { DATABASE_URL: SUPABASE, DEV_FOUNDER_PASSWORD: "a-private-pass-123", SEED_SAMPLES: "1" }, { bcryptRounds: 4 });
    expect(r.status).toBe("seeded");
    expect((await h.db.select().from(tasks).where(like(tasks.title, "[sample]%"))).length).toBeGreaterThan(0);
  });
});
