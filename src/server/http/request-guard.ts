/**
 * CSRF guard for the cookie-authenticated REST API (C1 review finding 9).
 * Used by src/middleware.ts (Edge runtime), so it is pure: no database, no "server-only".
 *
 * For mutating /api/v1 requests (POST, PUT, PATCH, DELETE):
 *  - a browser `Origin` header must be this site (the request's own host) or APP_URL;
 *    without Origin, `Sec-Fetch-Site` (if sent) must be same-origin. Non-browser
 *    clients send neither and cannot carry a victim's cookies, so they pass;
 *  - requests with a body must be `Content-Type: application/json`. HTML forms cannot
 *    send that cross-site without a CORS preflight, which this app never allows.
 * SameSite=Lax cookies remain the first line of defence.
 */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const WITH_BODY = new Set(["POST", "PUT", "PATCH"]);

export type GuardResult = { ok: true } | { ok: false; status: 403 | 415; code: string; message: string };

function originOf(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** Origins that count as "this site" for the request. */
export function allowedOrigins(req: Request, env: Record<string, string | undefined> = process.env): Set<string> {
  const out = new Set<string>();
  const self = originOf(req.url);
  if (self) out.add(self);
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host")?.trim();
  if (host) {
    const proto =
      req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || (self ? new URL(self).protocol.replace(":", "") : "https");
    const fromHost = originOf(`${proto}://${host}`);
    if (fromHost) out.add(fromHost);
  }
  const app = originOf(env.APP_URL);
  if (app) out.add(app);
  return out;
}

export function checkMutatingApiRequest(
  req: Request,
  env: Record<string, string | undefined> = process.env,
): GuardResult {
  const method = req.method.toUpperCase();
  if (!MUTATING.has(method)) return { ok: true };

  const forbidden: GuardResult = {
    ok: false,
    status: 403,
    code: "forbidden",
    message: "Cross-site request blocked",
  };
  const origin = req.headers.get("origin");
  if (origin !== null) {
    const normalized = originOf(origin);
    if (!normalized || !allowedOrigins(req, env).has(normalized)) return forbidden;
  } else {
    const site = req.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return forbidden;
  }

  if (WITH_BODY.has(method)) {
    const type = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") {
      return {
        ok: false,
        status: 415,
        code: "unsupported_media_type",
        message: "Content-Type must be application/json",
      };
    }
  }
  return { ok: true };
}
