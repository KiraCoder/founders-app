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
