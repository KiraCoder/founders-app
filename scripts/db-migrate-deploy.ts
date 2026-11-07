/**
 * Guarded migration for a deploy build (`npm run vercel-build`, see vercel.json). Does nothing
 * unless MIGRATE_ON_BUILD=1. Uses MIGRATION_DATABASE_URL when set, else DATABASE_URL.
 */
import "./env";
import { connectDb } from "@/server/db/connect";
import { migrateOnBuildDecision, runMigrations } from "@/server/db/migrate";

async function main() {
  const decision = migrateOnBuildDecision();
  console.log(`[db:migrate:deploy] ${decision.message}`);
  if (!decision.run) return;
  const handle = await connectDb(decision.url);
  await runMigrations(handle);
  await handle.close();
  console.log("[db:migrate:deploy] done");
}

main().catch((err) => {
  console.error("[db:migrate:deploy] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
