import "./env";
import { connectDb } from "@/server/db/connect";
import { migrationDatabaseUrl, runMigrations } from "@/server/db/migrate";

async function main() {
  // MIGRATION_DATABASE_URL (optional) wins over DATABASE_URL; neither = the embedded database.
  const handle = await connectDb(migrationDatabaseUrl());
  console.log(`[db:migrate] driver=${handle.driver}`);
  await runMigrations(handle);
  await handle.close();
  console.log("[db:migrate] done");
}

main().catch((err) => {
  console.error("[db:migrate] failed:", err);
  process.exit(1);
});
