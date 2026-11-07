/**
 * Applies the SQL migrations in ./drizzle using the matching Drizzle migrator.
 * Shared by `npm run db:migrate` and the test harness (no "server-only" on purpose).
 */
import path from "node:path";
import type { DbHandle } from "./connect";

export const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");

export async function runMigrations(handle: DbHandle): Promise<void> {
  if (handle.driver === "pglite") {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    // The PGlite and postgres-js handles share the same runtime API surface.
    await migrate(handle.db as never, { migrationsFolder: MIGRATIONS_FOLDER });
  } else {
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await migrate(handle.db as never, { migrationsFolder: MIGRATIONS_FOLDER });
  }
}

/**
 * `npm run db:migrate:deploy` (meant as a Vercel build step): migrates ONLY when
 * MIGRATE_ON_BUILD=1, and then only a real database (DATABASE_URL set). Off by default, so a
 * build never touches a database unless the founders turned it on.
 */
export function migrateOnBuildDecision(
  env: Record<string, string | undefined> = process.env,
): { run: false; message: string } | { run: true; message: string; url: string } {
  if (env.MIGRATE_ON_BUILD !== "1") {
    return { run: false, message: "MIGRATE_ON_BUILD is not 1: skipped (run `npm run db:migrate` against Supabase yourself)." };
  }
  const notProd = nonProductionVercelEnv(env);
  if (notProd) {
    return {
      run: false,
      message: `VERCEL_ENV=${notProd} (not production): skipped — only production deploys migrate the real database.`,
    };
  }
  const url = migrationDatabaseUrl(env);
  if (!url) {
    throw new Error("MIGRATE_ON_BUILD=1 but DATABASE_URL is not set: nothing to migrate. Set DATABASE_URL for this environment.");
  }
  const which = env.MIGRATION_DATABASE_URL?.trim() ? "MIGRATION_DATABASE_URL" : "DATABASE_URL";
  return { run: true, url, message: `MIGRATE_ON_BUILD=1: applying migrations to ${which}.` };
}

/**
 * The database URL migrations use: MIGRATION_DATABASE_URL when set (optional; e.g. Supabase's
 * Session pooler, port 5432 on the same pooler host), otherwise DATABASE_URL. Drizzle's
 * migrator runs each migration in one transaction without prepared statements or session
 * state, so it also works through the Transaction pooler (6543); the override is only a
 * way out if a future migration ever needs a session-level feature.
 */
export function migrationDatabaseUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.MIGRATION_DATABASE_URL?.trim() || env.DATABASE_URL?.trim() || undefined;
}

/**
 * A Vercel preview / development build must never migrate or seed the real database (deploy
 * review #1): Drizzle compares only the last applied migration's timestamp, so a branch's
 * migration applied by a preview could make a later production migration be skipped
 * silently. Returns the VERCEL_ENV value when it is set and not "production", else null
 * (local builds have no VERCEL_ENV and are decided by the …_ON_BUILD flags alone).
 */
export function nonProductionVercelEnv(env: Record<string, string | undefined> = process.env): string | null {
  const v = env.VERCEL_ENV?.trim();
  if (!v || v === "production") return null;
  return v;
}
