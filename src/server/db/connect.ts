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

export { resolveDatabaseUrl } from "./database-url";

export const DEFAULT_PGLITE_DIR = path.join(process.cwd(), ".data", "pglite");

export async function connectDb(databaseUrl = process.env.DATABASE_URL): Promise<DbHandle> {
  if (databaseUrl && databaseUrl !== "memory://") {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const client = postgres(withoutPgbouncerParam(databaseUrl), postgresClientOptions(databaseUrl));
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

/**
 * True for a connection through a transaction-mode pooler: Supabase's Transaction pooler
 * (port 6543) or any URL marked `pgbouncer=true`. Such a pooler hands each transaction to
 * any server connection, so named prepared statements would break.
 */
export function isTransactionPoolerUrl(databaseUrl: string): boolean {
  try {
    const u = new URL(databaseUrl);
    return u.port === "6543" || u.searchParams.get("pgbouncer") === "true";
  } catch {
    return /:6543(\/|$|\?)/.test(databaseUrl) || /[?&]pgbouncer=true\b/.test(databaseUrl);
  }
}

/**
 * postgres-js options. Prepared statements are ALWAYS off: required behind Supabase's
 * transaction pooler (port 6543, `isTransactionPoolerUrl`) and harmless on a direct or
 * session-pooler connection, so a URL copied from the wrong tab still works.
 * `connect_timeout` keeps an unreachable database from hanging a build step or a request.
 */
export function postgresClientOptions(_databaseUrl: string): {
  prepare: false;
  max: number;
  connect_timeout: number;
  idle_timeout: number;
  max_lifetime: number;
  onnotice: () => void;
} {
  return {
    prepare: false,
    // ONE connection per server instance, one query at a time. Through Supabase's pooler,
    // several queries in flight at once (e.g. the Today page's Promise.all of 5) left the
    // server sessions stuck in "active / ClientRead" and every later request hung until the
    // 300 s function timeout (seen in production, Nov 2026). Serial queries never hung.
    // Two founders do not need parallel connections; postgres-js queues the rest.
    max: 1,
    connect_timeout: 15,
    // Close idle sockets quickly: a serverless instance that was frozen between requests can
    // otherwise wake up holding a dead connection and hang the next query.
    idle_timeout: 20,
    max_lifetime: 60 * 10,
    // "relation already exists, skipping" and similar notices are noise in build logs.
    onnotice: () => {},
  };
}

/**
 * `pgbouncer=true` is a marker for tools (Prisma, us), not a Postgres setting: postgres-js
 * would send it to the server as a startup parameter and the connection would be refused.
 */
export function withoutPgbouncerParam(databaseUrl: string): string {
  try {
    const u = new URL(databaseUrl);
    if (!u.searchParams.has("pgbouncer")) return databaseUrl;
    u.searchParams.delete("pgbouncer");
    return u.toString();
  } catch {
    return databaseUrl;
  }
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
