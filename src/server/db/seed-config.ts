/**
 * Decides how `npm run db:seed` may run (C1 review findings 2 and 7). Pure, so it is unit-tested.
 *
 * - A real Postgres database (DATABASE_URL set) is never seeded with the public dev
 *   password: DEV_FOUNDER_PASSWORD must be set, differ from it and have 12+ characters.
 *   The check uses the value actually loaded (also from .env), so a copied
 *   .env.example cannot slip the default through.
 * - "[sample]" tasks are added by default only to the local embedded database.
 *   On Postgres they need SEED_SAMPLES=1.
 * - Existing founders keep their password. SEED_RESET_PASSWORDS=1 re-hashes it and
 *   signs them out everywhere.
 */
import { isRemoteDatabaseUrl, type DbDriver } from "./connect";
import { DEV_PASSWORD_DEFAULT } from "./seed";

export const MIN_REAL_DB_PASSWORD_LENGTH = 12;

export interface SeedPlan {
  password: string;
  withSamples: boolean;
  resetPasswords: boolean;
}

type Env = Record<string, string | undefined>;

export function planSeed(driver: DbDriver, env: Env): { ok: true; plan: SeedPlan } | { ok: false; error: string } {
  const given = env.DEV_FOUNDER_PASSWORD?.trim() ? env.DEV_FOUNDER_PASSWORD : undefined;
  const realDb = driver === "postgres" || isRemoteDatabaseUrl(env.DATABASE_URL);

  if (realDb) {
    if (!given || given === DEV_PASSWORD_DEFAULT || given.length < MIN_REAL_DB_PASSWORD_LENGTH) {
      return {
        ok: false,
        error:
          "Refusing to seed a real Postgres database without a strong founder password. " +
          `Set DEV_FOUNDER_PASSWORD to a private password of at least ${MIN_REAL_DB_PASSWORD_LENGTH} characters ` +
          "(not the dev default).",
      };
    }
  }

  const samplesFlag = env.SEED_SAMPLES?.trim();
  const withSamples = realDb ? samplesFlag === "1" : samplesFlag !== "0";
  return {
    ok: true,
    plan: {
      password: given ?? DEV_PASSWORD_DEFAULT,
      withSamples,
      resetPasswords: env.SEED_RESET_PASSWORDS?.trim() === "1",
    },
  };
}
