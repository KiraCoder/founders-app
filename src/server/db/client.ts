import "server-only";
import { connectDb, resolveDatabaseUrl, type Db, type DbHandle } from "./connect";

export type { Db } from "./connect";

/**
 * Process-wide database handle. Cached on globalThis so Next.js dev hot reloads and
 * separate module layers never open a second PGlite instance on the same directory.
 */
const globalForDb = globalThis as unknown as { __foundersDb?: Promise<DbHandle> };

export function getDb(): Promise<Db> {
  if (!globalForDb.__foundersDb) {
    // resolveDatabaseUrl refuses production without DATABASE_URL (no silent PGlite fallback).
    globalForDb.__foundersDb = Promise.resolve()
      .then(() => connectDb(resolveDatabaseUrl() ?? ""))
      .catch((err: unknown) => {
        globalForDb.__foundersDb = undefined;
        throw err;
      });
  }
  return globalForDb.__foundersDb.then((h) => h.db);
}
