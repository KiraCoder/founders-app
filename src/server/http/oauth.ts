import "server-only";
import type { SessionUser } from "@/server/auth/types";
import type { Db } from "@/server/db/connect";
import { hitRateCounter } from "@/server/services/extension";
import {
  authenticateClient,
  authorizationServerMetadata,
  checkAuthorizeRequest,
  exchangeAuthorizationCode,
  issueAuthorizationCode,
  OAuthError,
  oauthBaseUrl,
  protectedResourceMetadata,
  redirectWith,
  refreshAccessToken,
  registerClient,
  REGISTER_RATE_LIMIT,
  revokeTokenForClient,
  verifyConsentToken,
} from "@/server/services/oauth";
import { clientIp } from "./ingest";
import { allowedOrigins } from "./request-guard";

/**
 * HTTP side of the Claude connector's OAuth server (rules in services/oauth.ts).
 *
 * Public (exempt from the session middleware, exact paths only): the two metadata documents,
 * POST /api/oauth/register, /api/oauth/token and /api/oauth/revoke — they take no cookie and
 * answer CORS for any origin (no credentials), like every OAuth server used by browser clients.
 * POST /api/oauth/authorize is NOT public: it needs the founder's session, a same-origin Origin
 * and the consent form's HMAC token.
 */

export interface OAuthDeps {
  db: Db;
  now?: () => Date;
  env?: Record<string, string | undefined>;
}

export const PUBLIC_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
  "Access-Control-Max-Age": "600",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", Pragma: "no-cache", ...PUBLIC_CORS, ...extra },
  });
}

function oauthError(err: OAuthError): Response {
  return json(err.body(), err.status, err.status === 401 ? { "WWW-Authenticate": 'Basic realm="founder-cockpit"' } : {});
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: PUBLIC_CORS });
}

export function authorizationServerMetadataResponse(req: Request, env?: Record<string, string | undefined>): Response {
  return json(authorizationServerMetadata(oauthBaseUrl(req, env)), 200, { "Cache-Control": "public, max-age=300" });
}

export function protectedResourceMetadataResponse(req: Request, env?: Record<string, string | undefined>): Response {
  return json(protectedResourceMetadata(oauthBaseUrl(req, env)), 200, { "Cache-Control": "public, max-age=300" });
}

const MAX_BODY = 16 * 1024;

async function readText(req: Request): Promise<string> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) throw new OAuthError("invalid_request", "Request too large", 413);
  const text = await req.text();
  if (text.length > MAX_BODY) throw new OAuthError("invalid_request", "Request too large", 413);
  return text;
}

/** Token / revocation bodies: form-encoded per RFC 6749 (JSON accepted too). */
async function readForm(req: Request): Promise<URLSearchParams> {
  const type = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const text = await readText(req);
  if (type === "application/json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new OAuthError("invalid_request", "Body is not valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new OAuthError("invalid_request", "Body must be an object");
    const out = new URLSearchParams();
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out.set(k, v);
    return out;
  }
  if (type !== "application/x-www-form-urlencoded") {
    throw new OAuthError("invalid_request", "Content-Type must be application/x-www-form-urlencoded");
  }
  return new URLSearchParams(text);
}

async function guard(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OAuthError) return oauthError(err);
    console.error("[oauth] unexpected error", err);
    return json({ error: "server_error", error_description: "Unexpected error" }, 500);
  }
}

/** POST /api/oauth/register — RFC 7591 dynamic client registration (10 per IP per minute). */
export function handleRegister(req: Request, deps: OAuthDeps): Promise<Response> {
  return guard(async () => {
    const now = deps.now?.() ?? new Date();
    const { n, retryAfter } = await hitRateCounter(deps.db, `oauthreg:${clientIp(req)}`, now);
    if (n > REGISTER_RATE_LIMIT) {
      return json({ error: "slow_down", error_description: "Too many registrations; try again in a minute" }, 429, { "Retry-After": String(retryAfter) });
    }
    const text = await readText(req);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new OAuthError("invalid_client_metadata", "Body must be JSON client metadata");
    }
    return json(await registerClient(deps.db, body, now), 201);
  });
}

/** POST /api/oauth/token — authorization_code (PKCE) and refresh_token (rotating). */
export function handleToken(req: Request, deps: OAuthDeps): Promise<Response> {
  return guard(async () => {
    const now = deps.now?.() ?? new Date();
    const form = await readForm(req);
    const client = await authenticateClient(deps.db, form, req.headers.get("authorization"));
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      return json(await exchangeAuthorizationCode(deps.db, client, form, oauthBaseUrl(req, deps.env), now));
    }
    if (grantType === "refresh_token") return json(await refreshAccessToken(deps.db, client, form, now));
    throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  });
}

/** POST /api/oauth/revoke — RFC 7009 (200 also for unknown tokens). */
export function handleRevoke(req: Request, deps: OAuthDeps): Promise<Response> {
  return guard(async () => {
    const now = deps.now?.() ?? new Date();
    const form = await readForm(req);
    const client = await authenticateClient(deps.db, form, req.headers.get("authorization"));
    await revokeTokenForClient(deps.db, client, form.get("token"), now);
    return json({}, 200);
  });
}

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
}

function plainError(status: number, message: string): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

/**
 * POST /api/oauth/authorize — the consent form (src/app/oauth/authorize/page.tsx).
 * CSRF: the request must come from this site (Origin, or Sec-Fetch-Site: same-origin when a
 * browser omits Origin; neither header → refused) AND carry the HMAC consent token bound to this
 * founder, client, redirect_uri and PKCE challenge. Non-founders are refused.
 */
export async function handleAuthorizePost(req: Request, deps: OAuthDeps & { user: SessionUser | null }): Promise<Response> {
  const now = deps.now?.() ?? new Date();
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  const sameSite = origin !== null ? allowedOrigins(req, deps.env).has(origin) : site === "same-origin";
  if (!sameSite) return plainError(403, "Cross-site request blocked");
  if (!deps.user) return plainError(401, "Sign in to Founder Cockpit first");
  if (deps.user.role !== "founder") return plainError(403, "Only the founders can connect apps to Founder Cockpit");

  const type = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return plainError(415, "Form post expected");
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await readText(req));
  } catch {
    return plainError(413, "Request too large");
  }
  const check = await checkAuthorizeRequest(
    deps.db,
    {
      response_type: form.get("response_type"),
      client_id: form.get("client_id"),
      redirect_uri: form.get("redirect_uri"),
      code_challenge: form.get("code_challenge"),
      code_challenge_method: form.get("code_challenge_method"),
      state: form.get("state"),
      scope: form.get("scope"),
      resource: form.get("resource"),
    },
    oauthBaseUrl(req, deps.env),
  );
  if (!check.ok) {
    if (check.kind === "page") return plainError(400, check.message);
    return seeOther(redirectWith(check.redirectUri, { error: check.error, error_description: check.description, state: check.state }));
  }
  const r = check.request;
  if (!verifyConsentToken(form.get("consent_token"), deps.user.id, { clientId: r.client.clientId, redirectUri: r.redirectUri, codeChallenge: r.codeChallenge }, now)) {
    return plainError(403, "This consent screen expired. Go back to Claude and connect again.");
  }
  const iss = oauthBaseUrl(req, deps.env);
  if (form.get("decision") !== "allow") {
    return seeOther(redirectWith(r.redirectUri, { error: "access_denied", error_description: "The founder declined", state: r.state, iss }));
  }
  const code = await issueAuthorizationCode(deps.db, deps.user, r, now);
  return seeOther(redirectWith(r.redirectUri, { code, state: r.state, iss }));
}
