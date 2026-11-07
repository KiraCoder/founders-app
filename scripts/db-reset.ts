/**
 * LOCAL ONLY: wipes the database, re-applies migrations and re-seeds.
 * Refuses to run when DATABASE_URL points to a non-localhost host, so it can never
 * touch Supabase or any other real database.
 */
import "./env";
import { rmSync } from "node:fs";
import { sql } from "drizzle-orm";
import { connectDb, DEFAULT_PGLITE_DIR, isRemoteDatabaseUrl } from "@/server/db/connect";
import { runMigrations } from "@/server/db/migrate";
import { DEV_PASSWORD_DEFAULT, seed } from "@/server/db/seed";

async function main() {
  const url = process.env.DATABASE_URL;
  if (isRemoteDatabaseUrl(url) || process.env.NODE_ENV === "production") {
    console.error("[db:reset] Refusing: DATABASE_URL is not localhost (or NODE_ENV=production). Nothing was changed.");
    process.exit(1);
  }

  if (!url) {
    rmSync(DEFAULT_PGLITE_DIR, { recursive: true, force: true });
    console.log(`[db:reset] removed ${DEFAULT_PGLITE_DIR}`);
  }

  const handle = await connectDb(url);
  if (handle.driver === "postgres") {
    await handle.db.execute(sql`drop schema if exists drizzle cascade`);
    await handle.db.execute(sql`drop schema public cascade`);
    await handle.db.execute(sql`create schema public`);
    console.log("[db:reset] dropped local Postgres schemas");
  }
  await runMigrations(handle);
  await seed(handle.db, {
    password: process.env.DEV_FOUNDER_PASSWORD || DEV_PASSWORD_DEFAULT,
    withSamples: process.env.SEED_SAMPLES !== "0",
  });
  await handle.close();
  console.log("[db:reset] done");
}

main().catch((err) => {
  console.error("[db:reset] failed:", err);
  process.exit(1);
});
