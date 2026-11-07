import "./env";
import { connectDb } from "@/server/db/connect";
import { seed } from "@/server/db/seed";
import { planSeed } from "@/server/db/seed-config";

async function main() {
  const handle = await connectDb();
  const decision = planSeed(handle.driver, process.env);
  if (!decision.ok) {
    console.error(`[db:seed] ${decision.error}`);
    await handle.close();
    process.exit(1);
  }
  const { plan } = decision;
  await seed(handle.db, {
    password: plan.password,
    withSamples: plan.withSamples,
    resetPasswords: plan.resetPasswords,
    timeZone: process.env.APP_TIMEZONE,
  });
  await handle.close();
  console.log(
    `[db:seed] done (driver=${handle.driver}, samples=${plan.withSamples ? "yes" : "no"}, ` +
      `passwords=${plan.resetPasswords ? "reset, sessions revoked" : "kept for existing founders"}). ` +
      "Founders: nuraaly@founders.local, talant@founders.local",
  );
}

main().catch((err) => {
  console.error("[db:seed] failed:", err);
  process.exit(1);
});
