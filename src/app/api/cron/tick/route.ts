import { NextResponse } from "next/server";
import { getDb } from "@/server/db/client";
import { cronSecret } from "@/server/notifications/config";
import { bearerToken, safeEqual } from "@/server/notifications/secrets";
import { runTick } from "@/server/notifications/tick";

export const dynamic = "force-dynamic";

/**
 * Scheduler entry point: plan + dispatch. Call every 5–15 minutes from Supabase pg_cron,
 * a free external cron, or `npm run cron:tick`. Requires
 * `Authorization: Bearer $CRON_SECRET` (or `x-cron-secret`). No secret configured = always 401.
 */
async function handle(req: Request): Promise<Response> {
  if (!safeEqual(bearerToken(req, "x-cron-secret"), cronSecret())) {
    return NextResponse.json({ error: { code: "unauthorized", message: "Bad or missing cron secret" } }, { status: 401 });
  }
  const report = await runTick(await getDb(), new Date());
  return NextResponse.json({ ok: true, ...report });
}

export const POST = handle;
/** Vercel Cron sends GET with the same Authorization header. */
export const GET = handle;
