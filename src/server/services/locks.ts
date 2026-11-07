import "server-only";
import { sql } from "drizzle-orm";
import type { Db } from "@/server/db/connect";

/**
 * Transaction-scoped advisory lock (`pg_advisory_xact_lock`), released at commit or
 * rollback. Used so two imports into the same place never run their "plan then write"
 * at the same time (both would plan "create" and write duplicates). Works on Postgres
 * and on the embedded PGlite (verified in tests). Must be called inside a transaction,
 * BEFORE reading the rows the transaction will plan from.
 */
export async function lockTransaction(tx: Db, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}
