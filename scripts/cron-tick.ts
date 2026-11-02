/**
 * Runs one scheduler tick against a running app (plan + dispatch), exactly like an
 * external cron would:  POST $APP_URL/api/cron/tick  with  Authorization: Bearer $CRON_SECRET.
 *
 *   npm run cron:tick                     # app on http://localhost:3000
 *   APP_URL=https://… npm run cron:tick   # any deployment
 *
 * It calls the HTTP endpoint (not the database) so it also works while `npm run dev`
 * holds the embedded database.
 */
import "./env";

async function main() {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[cron:tick] CRON_SECRET is not set. Add it to .env.local (see .env.example).");
    process.exit(1);
  }
  const base = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
  const res = await fetch(`${base}/api/cron/tick`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
  const body = await res.text();
  console.log(`[cron:tick] ${res.status} ${body}`);
  if (!res.ok) process.exit(1);
}

main().catch((err) => {
  console.error("[cron:tick] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
