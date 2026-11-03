import "server-only";
import type { Db } from "@/server/db/connect";
import { makeContext } from "@/server/services/context";
import { toServiceError } from "@/server/services/errors";
import {
  authenticateKey,
  INGEST_MAX_BYTES,
  ingestEnvelopeSchema,
  ingestPoints,
  logIngest,
  rateLimited,
  type KeyAuth,
} from "@/server/services/extension";
import { allowedOrigins } from "./request-guard";

/**
 * POST /api/v1/ingest — the founders' Chrome extension sends numbers it read from web pages.
 *
 * - Auth: `Authorization: Bearer <personal key>` (Settings → Browser extension). No session
 *   cookie, so the route is exempt from the same-origin guard (src/middleware.ts) — the key is
 *   the proof. Missing / unknown / revoked key → 401.
 * - CORS for this route only: `chrome-extension://…` origins get Access-Control-Allow-Origin
 *   (and a preflight answer); any other web origin is refused (403). Calls without an Origin
 *   (scripts, curl) are fine.
 * - Limits: 60 requests per key per minute (429), 256 KB body (413), 500 points (400).
 * - Body: { source: "extension", adapterId, points: [{ companySlug, metricKey, periodStart,
 *   value (string), unitSlug? }] } → 200 { accepted, rejected: [{ index, reason }] }.
 * Every authenticated call (except rate-limited ones) is logged for Settings.
 */

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[A-Za-z0-9_-]{1,64}$/;

export function isExtensionOrigin(origin: string | null): origin is string {
  return !!origin && EXTENSION_ORIGIN.test(origin);
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (!isExtensionOrigin(origin)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders(origin), ...extra },
  });
}

const error = (status: number, code: string, message: string, origin: string | null, extra?: Record<string, string>) =>
  json({ error: { code, message } }, status, origin, extra);

/** A browser origin that is neither the extension nor this site: refused. */
function foreignOrigin(req: Request, origin: string | null): boolean {
  if (origin === null || isExtensionOrigin(origin)) return false;
  try {
    return !allowedOrigins(req).has(new URL(origin).origin);
  } catch {
    return true;
  }
}

/** CORS preflight (OPTIONS). */
export function handleIngestPreflight(req: Request): Response {
  const origin = req.headers.get("origin");
  if (!isExtensionOrigin(origin)) return error(403, "forbidden", "Only the browser extension may call this from a browser", origin);
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

/** Reads at most `limit` bytes; null when the body is larger. */
async function readLimited(req: Request, limit: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function handleIngestRequest(req: Request, deps: { db: Db; now?: () => Date }): Promise<Response> {
  const origin = req.headers.get("origin");
  const now = () => deps.now?.() ?? new Date();
  if (foreignOrigin(req, origin)) return error(403, "forbidden", "Cross-site request blocked", origin);

  const auth = await authenticateKey(deps.db, req.headers.get("authorization"));
  if (!auth) return error(401, "unauthorized", "A valid browser extension key is required (Settings → Browser extension)", origin);
  if (await rateLimited(deps.db, auth.keyId, now())) {
    return error(429, "rate_limited", "Too many requests for this key — at most 60 per minute", origin, { "Retry-After": "60" });
  }

  const invalid = async (status: number, code: string, message: string, adapterId: string | null = null, points = 0) => {
    await logIngest(deps.db, auth, { adapterId, status: "invalid", points, accepted: 0, rejected: [], conflicts: 0, message }, now());
    return error(status, code, message, origin);
  };

  const type = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") return invalid(415, "unsupported_media_type", "Content-Type must be application/json");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > INGEST_MAX_BYTES) return invalid(413, "too_large", "The body is larger than 256 KB — send fewer points per request");
  const text = await readLimited(req, INGEST_MAX_BYTES);
  if (text === null) return invalid(413, "too_large", "The body is larger than 256 KB — send fewer points per request");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return invalid(400, "validation", "Body must be JSON");
  }
  const env = ingestEnvelopeSchema.safeParse(body);
  if (!env.success) {
    const issue = env.error.issues[0]!;
    const adapter = typeof (body as { adapterId?: unknown })?.adapterId === "string" ? String((body as { adapterId: string }).adapterId).slice(0, 64) : null;
    const pts = Array.isArray((body as { points?: unknown })?.points) ? (body as { points: unknown[] }).points.length : 0;
    const field = issue.path.join(".");
    return invalid(400, "validation", `${field ? `${field}: ` : ""}${issue.message}`, adapter, pts);
  }
  return ingest(deps.db, auth, env.data, now(), origin);
}

async function ingest(db: Db, auth: KeyAuth, data: { adapterId: string; points: unknown[] }, now: Date, origin: string | null): Promise<Response> {
  const ctx = makeContext(db, auth.user, now);
  try {
    const result = await ingestPoints(ctx, data.adapterId, data.points);
    await logIngest(db, auth, { adapterId: data.adapterId, status: "ok", points: data.points.length, accepted: result.accepted, rejected: result.rejected, conflicts: result.conflicts }, now);
    return json({ accepted: result.accepted, rejected: result.rejected }, 200, origin);
  } catch (err) {
    const se = toServiceError(err);
    if (se) return error(se.status, se.code, se.message, origin);
    console.error("[ingest] unexpected error", err);
    return error(500, "internal", "Unexpected error", origin);
  }
}
