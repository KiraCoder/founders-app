import { sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Public, read-only health check: can this server reach the database, and how fast?
 * Returns no data, no secrets: only timing, the Vercel region and a short error code.
 */
export async function GET() {
  const started = Date.now();
  const region = process.env.VERCEL_REGION ?? null;
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(Object.assign(new Error("Database did not answer within 10 s"), { code: "TIMEOUT" })), 10_000),
  );
  try {
    const db = await Promise.race([getDb(), timeout]);
    const connectedMs = Date.now() - started;
    await Promise.race([db.execute(sql`select 1`), timeout]);
    const t2 = Date.now();
    await Promise.race([db.execute(sql`select 1`), timeout]);
    return Response.json(
      { ok: true, region, firstQueryMs: t2 - started, connectMs: connectedMs, secondQueryMs: Date.now() - t2 },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    const e = err as { code?: string; message?: string };
    const message = String(e?.message ?? "unknown error").replace(/postgres(ql)?:\/\/\S+/gi, "[url]").slice(0, 200);
    return Response.json(
      { ok: false, region, afterMs: Date.now() - started, code: e?.code ?? null, message },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
