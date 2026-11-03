/**
 * Guarded migration for a deploy build (e.g. Vercel Build Command
 * `npm run db:migrate:deploy && npm run build`). Does nothing unless MIGRATE_ON_BUILD=1.
 */
import "./env";
import { connectDb } from "@/server/db/connect";
import { migrateOnBuildDecision, runMigrations } from "@/server/db/migrate";

async function main() {
  const decision = migrateOnBuildDecision();
  console.log(`[db:migrate:deploy] ${decision.message}`);
  if (!decision.run) return;
  const handle = await connectDb(process.env.DATABASE_URL!.trim());
  await runMigrations(handle);
  await handle.close();
  console.log("[db:migrate:deploy] done");
}

main().catch((err) => {
  console.error("[db:migrate:deploy] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
