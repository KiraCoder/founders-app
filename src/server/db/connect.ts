/**
 * Database connection factory.
 *
 * - DATABASE_URL set   -> postgres-js driver (Supabase Postgres / any Postgres).
 * - DATABASE_URL empty -> PGlite, embedded Postgres stored in ./.data/pglite.
 * - "memory://"        -> in-memory PGlite (tests).
 *
 * Intentionally does NOT import "server-only": the CLI scripts (migrate/seed/reset) and
 * tests use it from plain Node. App code must go through `./client.ts` instead.
 */
import path from "node:path";
import { mkdirSync } from "node:fs";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export type Schema = typeof schema;
/** Driver-independent database handle used by every service. */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export type DbDriver = "postgres" | "pglite";

export interface DbHandle {
  db: Db;
  driver: DbDriver;
  close: () => Promise<void>;
}

/**
 * The database URL the APP may use. In production an empty DATABASE_URL is refused (the app
 * would silently fall back to the embedded PGlite database on the server's own disk, which on
 * Vercel is temporary and per instance: data would vanish). `ALLOW_LOCAL_DB=1` allows it for
 * a local production run (e2e). Called at server start (instrumentation.ts) and by getDb().
 */
export function resolveDatabaseUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  const url = env.DATABASE_URL?.trim() || undefined;
  if (!url && env.NODE_ENV === "production" && env.ALLOW_LOCAL_DB !== "1") {
    throw new Error(
      "DATABASE_URL is not set. Refusing to run in production with the embedded local database " +
        "(it would keep data on the server's temporary disk and lose it). Set DATABASE_URL to the " +
        "Supabase connection string (README → Moving to Supabase + Vercel), or ALLOW_LOCAL_DB=1 " +
        "for a local production test only.",
    );
  }
  return url;
}

export const DEFAULT_PGLITE_DIR = path.join(process.cwd(), ".data", "pglite");

export async function connectDb(databaseUrl = process.env.DATABASE_URL): Promise<DbHandle> {
  if (databaseUrl && databaseUrl !== "memory://") {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    // `prepare: false` keeps it compatible with Supabase's transaction pooler (pgbouncer).
    const client = postgres(databaseUrl, { prepare: false, max: 5 });
    const db = drizzle(client, { schema }) as unknown as Db;
    return { db, driver: "postgres", close: () => client.end() };
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  let client: InstanceType<typeof PGlite>;
  if (databaseUrl === "memory://") {
    client = new PGlite();
  } else {
    mkdirSync(DEFAULT_PGLITE_DIR, { recursive: true });
    client = new PGlite(DEFAULT_PGLITE_DIR);
  }
  await client.waitReady;
  const db = drizzle(client, { schema }) as unknown as Db;
  return { db, driver: "pglite", close: () => client.close() };
}

/** True when DATABASE_URL points somewhere other than this machine. */
export function isRemoteDatabaseUrl(databaseUrl: string | undefined): boolean {
  if (!databaseUrl || databaseUrl === "memory://") return false;
  try {
    const host = new URL(databaseUrl).hostname;
    return !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
  } catch {
    // Unparseable URL: be safe and treat it as remote.
    return true;
  }
}
