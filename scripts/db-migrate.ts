import "./env";
import { connectDb } from "@/server/db/connect";
import { runMigrations } from "@/server/db/migrate";

async function main() {
  const handle = await connectDb();
  console.log(`[db:migrate] driver=${handle.driver}`);
  await runMigrations(handle);
  await handle.close();
  console.log("[db:migrate] done");
}

main().catch((err) => {
  console.error("[db:migrate] failed:", err);
  process.exit(1);
});
