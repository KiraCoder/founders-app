/**
 * `npm run db:seed:deploy` (part of `npm run vercel-build`): seeds the real database during a
 * deploy build, but only when asked and only once.
 *
 * - Runs only with SEED_ON_BUILD=1 and a DATABASE_URL; otherwise prints "skipped" (exit 0).
 * - Runs only while the database has NO founder yet (the first deploy). Once the founders
 *   exist every later build skips, so leaving SEED_ON_BUILD=1 on is harmless: nothing a
 *   founder changed (an email, a company) is ever overwritten or re-created by a deploy, and
 *   DEV_FOUNDER_PASSWORD can be removed from Vercel after the first deploy.
 *   (`npm run db:seed` by hand still re-runs the full, idempotent seed.)
 * - Keeps every guard of `npm run db:seed` (planSeed): a real database needs a private
 *   DEV_FOUNDER_PASSWORD of 12+ characters (never the dev default), no "[sample]" tasks on
 *   Postgres unless SEED_SAMPLES=1, and existing passwords are never reset.
 *   A refused guard fails the build with the reason, so a half-configured deploy is visible.
 *
 * No "server-only": used by the CLI script and tests.
 */
import { eq } from "drizzle-orm";
import type { DbHandle } from "./connect";
import { seed } from "./seed";
import { planSeed } from "./seed-config";
import { users } from "./schema";

type Env = Record<string, string | undefined>;

export function seedOnBuildDecision(env: Env): { run: boolean; message: string } {
  if (env.SEED_ON_BUILD?.trim() !== "1") {
    return { run: false, message: "SEED_ON_BUILD is not 1: skipped." };
  }
  if (!env.DATABASE_URL?.trim()) {
    return { run: false, message: "SEED_ON_BUILD=1 but DATABASE_URL is not set: skipped (nothing to seed)." };
  }
  return { run: true, message: "SEED_ON_BUILD=1: seeding DATABASE_URL if it has no founders yet." };
}

export type DeploySeedResult =
  | { status: "skipped"; message: string }
  | { status: "refused"; message: string }
  | { status: "seeded"; message: string };

/** The part after the env decision: needs a migrated database. */
export async function runDeploySeed(handle: DbHandle, env: Env, opts: { bcryptRounds?: number; now?: Date } = {}): Promise<DeploySeedResult> {
  const existing = await handle.db.select({ id: users.id }).from(users).where(eq(users.role, "founder")).limit(1);
  if (existing.length > 0) {
    return {
      status: "skipped",
      message: "the database already has founders: skipped (nothing is changed on later deploys; run `npm run db:seed` by hand for a full re-seed).",
    };
  }
  const decision = planSeed(handle.driver, env);
  if (!decision.ok) return { status: "refused", message: decision.error };
  const { plan } = decision;
  await seed(handle.db, {
    password: plan.password,
    withSamples: plan.withSamples,
    resetPasswords: false, // a deploy never resets passwords (there are no founders yet anyway)
    timeZone: env.APP_TIMEZONE,
    bcryptRounds: opts.bcryptRounds,
    now: opts.now,
  });
  return {
    status: "seeded",
    message:
      `seeded (driver=${handle.driver}, samples=${plan.withSamples ? "yes" : "no"}). ` +
      "Founders: nuraaly@founders.local, talant@founders.local with DEV_FOUNDER_PASSWORD.",
  };
}
