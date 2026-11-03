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
export function migrateOnBuildDecision(env: Record<string, string | undefined> = process.env): { run: boolean; message: string } {
  if (env.MIGRATE_ON_BUILD !== "1") {
    return { run: false, message: "MIGRATE_ON_BUILD is not 1: skipped (run `npm run db:migrate` against Supabase yourself)." };
  }
  if (!env.DATABASE_URL?.trim()) {
    throw new Error("MIGRATE_ON_BUILD=1 but DATABASE_URL is not set: nothing to migrate. Set DATABASE_URL for this environment.");
  }
  return { run: true, message: "MIGRATE_ON_BUILD=1: applying migrations to DATABASE_URL." };
}
