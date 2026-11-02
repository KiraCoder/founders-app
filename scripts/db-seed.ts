import "./env";
import { connectDb } from "@/server/db/connect";
import { DEV_PASSWORD_DEFAULT, seed } from "@/server/db/seed";

async function main() {
  const handle = await connectDb();
  const password = process.env.DEV_FOUNDER_PASSWORD || DEV_PASSWORD_DEFAULT;
  if (handle.driver === "postgres" && !process.env.DEV_FOUNDER_PASSWORD) {
    console.error(
      "[db:seed] Refusing to seed a real Postgres database with the default dev password. " +
        "Set DEV_FOUNDER_PASSWORD to a strong password first.",
    );
    process.exit(1);
  }
  await seed(handle.db, { password, timeZone: process.env.APP_TIMEZONE });
  await handle.close();
  console.log(`[db:seed] done (driver=${handle.driver}). Founders: nuraaly@founders.local, talant@founders.local`);
}

main().catch((err) => {
  console.error("[db:seed] failed:", err);
  process.exit(1);
});
