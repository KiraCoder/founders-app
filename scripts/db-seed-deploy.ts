/**
 * Guarded seed for a deploy build (`npm run vercel-build`, see vercel.json). Does nothing
 * unless SEED_ON_BUILD=1 and DATABASE_URL is set, and only seeds a database without founders.
 * Rules: src/server/db/seed-deploy.ts.
 */
import "./env";
import { connectDb } from "@/server/db/connect";
import { runDeploySeed, seedOnBuildDecision } from "@/server/db/seed-deploy";

async function main() {
  const decision = seedOnBuildDecision(process.env);
  console.log(`[db:seed:deploy] ${decision.message}`);
  if (!decision.run) return;
  const handle = await connectDb(process.env.DATABASE_URL!.trim());
  try {
    const result = await runDeploySeed(handle, process.env);
    if (result.status === "refused") {
      console.error(`[db:seed:deploy] refused: ${result.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[db:seed:deploy] ${result.message}`);
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error("[db:seed:deploy] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
