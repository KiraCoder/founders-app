import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, lt, max, min, or } from "drizzle-orm";
import { z } from "zod";
import { resolveSessionSecret } from "@/server/auth/session-token";
import type { SessionUser } from "@/server/auth/types";
import type { Db } from "@/server/db/connect";
import { oauthAuthCodes, oauthClients, oauthTokens, users } from "@/server/db/schema";
import { assertValidId } from "./access";
import type { ServiceContext } from "./context";
import { ServiceError } from "./errors";

/**
 * OAuth 2.1 authorization server for the "Founder Cockpit" Claude connector (remote MCP server
 * at /api/mcp). What claude.ai custom connectors need:
 *
 * - dynamic client registration (RFC 7591, POST /api/oauth/register);
 * - authorization-code flow with PKCE S256 only (GET /oauth/authorize: the signed-in FOUNDER sees
 *   a consent screen; POST /api/oauth/authorize issues a one-time code, 10 minutes);
 * - POST /api/oauth/token: code → access token (1 h) + refresh token (30 days); every refresh
 *   rotates the pair, and a refresh token that was already rotated revokes the whole grant;
 * - revocation (RFC 7009, POST /api/oauth/revoke) and Settings → Connected apps;
 * - metadata (RFC 8414 /.well-known/oauth-authorization-server, RFC 9728
 *   /.well-known/oauth-protected-resource).
 *
 * Tokens are opaque random strings; only their SHA-256 is stored. A token acts as the founder who
 * authorized it, through the normal services (all access rules apply), and only while that user is
 * still a founder.
 */

export const OAUTH_SCOPE = "cockpit";
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
export const AUTH_CODE_TTL_SECONDS = 10 * 60;
/** Registrations per IP per minute (ingest_rate_counters window). */
export const REGISTER_RATE_LIMIT = 10;

const ACCESS_PREFIX = "fca_";
const REFRESH_PREFIX = "fcr_";
const CODE_PREFIX = "fcc_";
const CLIENT_PREFIX = "fcl_";
const SECRET_PREFIX = "fcs_";

export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const random = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** RFC 7636 S256: BASE64URL(SHA256(ascii(code_verifier))). */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * The issuer / resource base: APP_URL when set (production domain), otherwise the origin the
 * request came to (each Vercel URL then is its own consistent issuer).
 */
export function oauthBaseUrl(req: Request, env: Record<string, string | undefined> = process.env): string {
  const app = env.APP_URL?.trim().replace(/\/+$/, "");
  if (app) return app;
  return new URL(req.url).origin;
}

export const mcpResourceUrl = (base: string) => `${base}/api/mcp`;
export const protectedResourceMetadataUrl = (base: string) => `${base}/.well-known/oauth-protected-resource`;

export function authorizationServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    revocation_endpoint: `${base}/api/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [OAUTH_SCOPE],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${base}/settings`,
  };
}

export function protectedResourceMetadata(base: string) {
  return {
    resource: mcpResourceUrl(base),
    authorization_servers: [base],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Founder Cockpit",
  };
}

// ---------------------------------------------------------------------------
// Errors (RFC 6749 §5.2 shape)
// ---------------------------------------------------------------------------

export class OAuthError extends Error {
  constructor(
    public readonly error: string,
    public readonly description: string,
    public readonly status = 400,
  ) {
    super(description);
    this.name = "OAuthError";
  }
  body() {
    return { error: this.error, error_description: this.description };
  }
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------

/** Claude's own callback hosts (claude.ai custom connectors). Others via OAUTH_EXTRA_REDIRECT_HOSTS. */
export const DEFAULT_REDIRECT_HOSTS = ["claude.ai", "claude.com"] as const;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Allowed redirect hosts: claude.ai, claude.com and OAUTH_EXTRA_REDIRECT_HOSTS (comma-separated host names). */
export function allowedRedirectHosts(env: Record<string, string | undefined> = process.env): Set<string> {
  const extra = (env.OAUTH_EXTRA_REDIRECT_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...DEFAULT_REDIRECT_HOSTS, ...extra]);
}

/**
 * A redirect_uri this server will ever send a browser to: https on an allowed host (exact host
 * name), or a loopback address (http or https, RFC 8252 §7.3); never a fragment or credentials.
 * Registration refuses anything else, so a self-registered client cannot turn /oauth/authorize
 * into an open redirect; the authorize step re-checks (clients registered before the allowlist).
 */
export function isAllowedRedirectUri(value: string, env: Record<string, string | undefined> = process.env): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return u.protocol === "http:" || u.protocol === "https:";
  return u.protocol === "https:" && allowedRedirectHosts(env).has(host);
}

const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
type AuthMethod = (typeof AUTH_METHODS)[number];

const registrationSchema = (env: Record<string, string | undefined>) =>
  z.object({
    redirect_uris: z
      .array(
        z
          .string()
          .max(2000)
          .refine(
            (v) => isAllowedRedirectUri(v, env),
            "redirect_uris must be https on an allowed host (claude.ai, claude.com, OAUTH_EXTRA_REDIRECT_HOSTS) or a loopback address, without a fragment",
          ),
      )
      .min(1, "redirect_uris is required")
      .max(10),
    client_name: z.string().trim().max(100).optional(),
    client_uri: z.url().max(2000).optional(),
    token_endpoint_auth_method: z.enum(AUTH_METHODS).optional(),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
    scope: z.string().max(200).optional(),
  });

export interface RegisteredClient {
  client_id: string;
  client_secret?: string;
  client_id_issued_at: number;
  client_secret_expires_at?: number;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: AuthMethod;
  scope: string;
}

export async function registerClient(
  db: Db,
  body: unknown,
  now: Date,
  env: Record<string, string | undefined> = process.env,
): Promise<RegisteredClient> {
  const parsed = registrationSchema(env).safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first?.path.join(".");
    const redirect = field?.startsWith("redirect_uris");
    throw new OAuthError(redirect ? "invalid_redirect_uri" : "invalid_client_metadata", `${field ? `${field}: ` : ""}${first?.message ?? "Invalid metadata"}`);
  }
  const m = parsed.data;
  const grantTypes = m.grant_types ?? ["authorization_code", "refresh_token"];
  if (grantTypes.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
    throw new OAuthError("invalid_client_metadata", "Only authorization_code and refresh_token grants are supported");
  }
  const responseTypes = m.response_types ?? ["code"];
  if (responseTypes.some((r) => r !== "code")) throw new OAuthError("invalid_client_metadata", "Only response_type code is supported");
  if (m.scope && m.scope.split(/\s+/).filter(Boolean).some((s) => s !== OAUTH_SCOPE)) {
    throw new OAuthError("invalid_client_metadata", `Unknown scope; supported: ${OAUTH_SCOPE}`);
  }
  // RFC 7591 default is client_secret_basic.
  const method: AuthMethod = m.token_endpoint_auth_method ?? "client_secret_basic";
  const clientId = random(CLIENT_PREFIX);
  const secret = method === "none" ? null : random(SECRET_PREFIX);
  const name = m.client_name || "MCP client";
  await db.insert(oauthClients).values({
    clientId,
    clientSecretHash: secret ? sha256(secret) : null,
    clientName: name,
    redirectUris: m.redirect_uris,
    tokenEndpointAuthMethod: method,
    clientUri: m.client_uri ?? null,
    createdAt: now,
  });
  return {
    client_id: clientId,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    client_name: name,
    redirect_uris: m.redirect_uris,
    grant_types: grantTypes,
    response_types: responseTypes,
    token_endpoint_auth_method: method,
    scope: OAUTH_SCOPE,
  };
}

type ClientRow = typeof oauthClients.$inferSelect;

async function findClient(db: Db, clientId: string | null | undefined): Promise<ClientRow | null> {
  if (!clientId || clientId.length > 200) return null;
  const [row] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Authorization request (GET /oauth/authorize, POST /api/oauth/authorize)
// ---------------------------------------------------------------------------

export interface AuthorizeParams {
  response_type?: string | null;
  client_id?: string | null;
  redirect_uri?: string | null;
  code_challenge?: string | null;
  code_challenge_method?: string | null;
  state?: string | null;
  scope?: string | null;
  resource?: string | null;
}

export interface ValidAuthorizeRequest {
  client: { id: string; clientId: string; name: string };
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scope: string;
  resource: string | null;
}

/**
 * A request whose client / redirect_uri cannot be trusted is shown as an error page (never
 * redirected, RFC 6749 §4.1.2.1); other problems go back to the client as `error=` redirects.
 */
export type AuthorizeCheck =
  | { ok: true; request: ValidAuthorizeRequest }
  | { ok: false; kind: "page"; message: string }
  | { ok: false; kind: "redirect"; redirectUri: string; error: string; description: string; state: string | null };

const CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;

export async function checkAuthorizeRequest(
  db: Db,
  p: AuthorizeParams,
  base: string,
  env: Record<string, string | undefined> = process.env,
): Promise<AuthorizeCheck> {
  const client = await findClient(db, p.client_id);
  if (!client) return { ok: false, kind: "page", message: "This app is not registered with Founder Cockpit (unknown client_id). Add the connector again in Claude." };
  const redirectUri = p.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : null);
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return { ok: false, kind: "page", message: "The redirect address does not match the one this app registered." };
  }
  // Registered before the host allowlist (or the allowlist shrank): never redirect there.
  if (!isAllowedRedirectUri(redirectUri, env)) {
    return { ok: false, kind: "page", message: "This app's redirect address is not allowed. Add the connector again in Claude." };
  }
  const state = p.state ?? null;
  const fail = (error: string, description: string): AuthorizeCheck => ({ ok: false, kind: "redirect", redirectUri, error, description, state });
  if (p.response_type !== "code") return fail("unsupported_response_type", "response_type must be code");
  if (!p.code_challenge || !CHALLENGE.test(p.code_challenge)) return fail("invalid_request", "PKCE code_challenge is required");
  if (p.code_challenge_method !== "S256") return fail("invalid_request", "code_challenge_method must be S256");
  const scopes = (p.scope ?? "").split(/\s+/).filter(Boolean);
  if (scopes.some((s) => s !== OAUTH_SCOPE)) return fail("invalid_scope", `Supported scope: ${OAUTH_SCOPE}`);
  const resource = p.resource || null;
  if (resource && resource.replace(/\/+$/, "") !== mcpResourceUrl(base)) return fail("invalid_target", "Unknown resource");
  return {
    ok: true,
    request: {
      client: { id: client.id, clientId: client.clientId, name: client.clientName },
      redirectUri,
      codeChallenge: p.code_challenge,
      state,
      scope: OAUTH_SCOPE,
      resource,
    },
  };
}

/** Only founders can connect apps; a token acts as them. */
export function assertCanAuthorize(user: SessionUser): void {
  if (user.role !== "founder") throw new ServiceError("forbidden", "Only the founders can connect apps to Founder Cockpit");
}

/** Consent-form CSRF token: HMAC over who consents to what, valid 30 minutes. */
export function consentToken(userId: string, r: Pick<ValidAuthorizeRequest, "redirectUri" | "codeChallenge"> & { clientId: string }, now: Date): string {
  const exp = Math.floor(now.getTime() / 1000) + 30 * 60;
  return `${exp}.${consentMac(userId, r, exp)}`;
}

function consentMac(userId: string, r: { clientId: string; redirectUri: string; codeChallenge: string }, exp: number): string {
  return createHmac("sha256", resolveSessionSecret())
    .update(["oauth-consent", userId, r.clientId, r.redirectUri, r.codeChallenge, String(exp)].join("\n"))
    .digest("base64url");
}

export function verifyConsentToken(token: string | null | undefined, userId: string, r: { clientId: string; redirectUri: string; codeChallenge: string }, now: Date): boolean {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token ?? "");
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp < Math.floor(now.getTime() / 1000)) return false;
  return safeEqual(m[2]!, consentMac(userId, r, exp));
}

/** The founder clicked Allow: a one-time code bound to client, redirect_uri, PKCE challenge and user. */
export async function issueAuthorizationCode(db: Db, user: SessionUser, r: ValidAuthorizeRequest, now: Date): Promise<string> {
  assertCanAuthorize(user);
  const code = random(CODE_PREFIX);
  await db.insert(oauthAuthCodes).values({
    codeHash: sha256(code),
    clientId: r.client.id,
    userId: user.id,
    redirectUri: r.redirectUri,
    codeChallenge: r.codeChallenge,
    scope: r.scope,
    resource: r.resource,
    expiresAt: new Date(now.getTime() + AUTH_CODE_TTL_SECONDS * 1000),
    createdAt: now,
  });
  // Housekeeping: codes older than a day are useless.
  await db.delete(oauthAuthCodes).where(lt(oauthAuthCodes.expiresAt, new Date(now.getTime() - 86_400_000)));
  return code;
}

export function redirectWith(redirectUri: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/**
 * Client authentication at the token / revocation endpoints. Public clients send client_id only
 * (PKCE protects the code); confidential ones client_secret_post or HTTP Basic.
 */
export async function authenticateClient(db: Db, form: URLSearchParams, authorization: string | null): Promise<ClientRow> {
  let clientId = form.get("client_id");
  let secret = form.get("client_secret");
  let viaBasic = false;
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(authorization ?? "");
  if (basic) {
    const decoded = Buffer.from(basic[1]!, "base64").toString("utf8");
    const i = decoded.indexOf(":");
    if (i < 0) throw new OAuthError("invalid_client", "Malformed client credentials", 401);
    try {
      clientId = decodeURIComponent(decoded.slice(0, i));
      secret = decodeURIComponent(decoded.slice(i + 1));
    } catch {
      throw new OAuthError("invalid_client", "Malformed client credentials", 401);
    }
    viaBasic = true;
  }
  const client = await findClient(db, clientId);
  if (!client) throw new OAuthError("invalid_client", "Unknown client", 401);
  if (client.tokenEndpointAuthMethod === "none") {
    if (secret) throw new OAuthError("invalid_client", "This client is public and has no secret", 401);
    return client;
  }
  if (!secret || !client.clientSecretHash || !safeEqual(sha256(secret), client.clientSecretHash)) {
    throw new OAuthError("invalid_client", "Client authentication failed", 401);
  }
  if (viaBasic !== (client.tokenEndpointAuthMethod === "client_secret_basic")) {
    throw new OAuthError("invalid_client", `This client authenticates with ${client.tokenEndpointAuthMethod}`, 401);
  }
  return client;
}

async function founderUser(db: Db, userId: string): Promise<SessionUser | null> {
  const [u] = await db
    .select({ id: users.id, email: users.email, name: users.name, shortName: users.shortName, role: users.role })
    .from(users)
    .where(eq(users.id, userId));
  return u && u.role === "founder" ? u : null;
}

async function issuePair(
  db: Db,
  grant: { grantId: string; clientId: string; userId: string; scope: string; resource: string | null },
  now: Date,
): Promise<TokenResponse> {
  const access = random(ACCESS_PREFIX);
  const refresh = random(REFRESH_PREFIX);
  await db.insert(oauthTokens).values({
    grantId: grant.grantId,
    clientId: grant.clientId,
    userId: grant.userId,
    accessTokenHash: sha256(access),
    refreshTokenHash: sha256(refresh),
    scope: grant.scope,
    resource: grant.resource,
    accessExpiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000),
    refreshExpiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000),
    createdAt: now,
  });
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token: refresh, scope: grant.scope };
}

async function revokeGrant(db: Db, grantId: string, now: Date): Promise<void> {
  await db.update(oauthTokens).set({ revokedAt: now }).where(and(eq(oauthTokens.grantId, grantId), isNull(oauthTokens.revokedAt)));
}

/** grant_type=authorization_code */
export async function exchangeAuthorizationCode(db: Db, client: ClientRow, form: URLSearchParams, base: string, now: Date): Promise<TokenResponse> {
  const code = form.get("code");
  const verifier = form.get("code_verifier");
  if (!code) throw new OAuthError("invalid_request", "code is required");
  if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthError("invalid_request", "A valid PKCE code_verifier is required");
  const [row] = await db.select().from(oauthAuthCodes).where(eq(oauthAuthCodes.codeHash, sha256(code)));
  if (!row || row.clientId !== client.id) throw new OAuthError("invalid_grant", "Unknown authorization code");
  if (row.usedAt) {
    // A code used twice: someone may have stolen it — revoke what it issued (grant id = code id).
    await revokeGrant(db, row.id, now);
    throw new OAuthError("invalid_grant", "Authorization code already used");
  }
  if (row.expiresAt.getTime() <= now.getTime()) throw new OAuthError("invalid_grant", "Authorization code expired");
  const redirectUri = form.get("redirect_uri");
  if (redirectUri !== null && redirectUri !== row.redirectUri) throw new OAuthError("invalid_grant", "redirect_uri does not match");
  if (!safeEqual(pkceChallenge(verifier), row.codeChallenge)) throw new OAuthError("invalid_grant", "PKCE verification failed");
  const resource = form.get("resource");
  if (resource && resource.replace(/\/+$/, "") !== mcpResourceUrl(base)) throw new OAuthError("invalid_target", "Unknown resource");
  // One-time: only the request that flips used_at gets tokens.
  const [claimed] = await db
    .update(oauthAuthCodes)
    .set({ usedAt: now })
    .where(and(eq(oauthAuthCodes.id, row.id), isNull(oauthAuthCodes.usedAt)))
    .returning({ id: oauthAuthCodes.id });
  if (!claimed) throw new OAuthError("invalid_grant", "Authorization code already used");
  if (!(await founderUser(db, row.userId))) throw new OAuthError("invalid_grant", "The user who authorized this app is no longer a founder");
  return issuePair(db, { grantId: row.id, clientId: client.id, userId: row.userId, scope: row.scope, resource: row.resource ?? resource ?? null }, now);
}

/** grant_type=refresh_token — rotates the pair; reuse of a rotated refresh token revokes the grant. */
export async function refreshAccessToken(db: Db, client: ClientRow, form: URLSearchParams, now: Date): Promise<TokenResponse> {
  const refresh = form.get("refresh_token");
  if (!refresh) throw new OAuthError("invalid_request", "refresh_token is required");
  const [row] = await db.select().from(oauthTokens).where(eq(oauthTokens.refreshTokenHash, sha256(refresh)));
  if (!row || row.clientId !== client.id) throw new OAuthError("invalid_grant", "Unknown refresh token");
  if (row.revokedAt) throw new OAuthError("invalid_grant", "Refresh token revoked");
  if (row.rotatedAt) {
    await revokeGrant(db, row.grantId, now);
    throw new OAuthError("invalid_grant", "Refresh token already used; the connection was revoked for safety. Connect again.");
  }
  if (row.refreshExpiresAt.getTime() <= now.getTime()) throw new OAuthError("invalid_grant", "Refresh token expired");
  const scope = form.get("scope");
  if (scope && scope.split(/\s+/).filter(Boolean).some((s) => s !== OAUTH_SCOPE)) throw new OAuthError("invalid_scope", "Scope cannot be widened");
  if (!(await founderUser(db, row.userId))) {
    await revokeGrant(db, row.grantId, now);
    throw new OAuthError("invalid_grant", "The user who authorized this app is no longer a founder");
  }
  const [claimed] = await db
    .update(oauthTokens)
    .set({ rotatedAt: now })
    .where(and(eq(oauthTokens.id, row.id), isNull(oauthTokens.rotatedAt), isNull(oauthTokens.revokedAt)))
    .returning({ id: oauthTokens.id });
  if (!claimed) throw new OAuthError("invalid_grant", "Refresh token already used");
  return issuePair(db, { grantId: row.grantId, clientId: row.clientId, userId: row.userId, scope: row.scope, resource: row.resource }, now);
}

/** RFC 7009: revokes the grant of an access or refresh token of this client. Unknown tokens are fine. */
export async function revokeTokenForClient(db: Db, client: ClientRow, token: string | null, now: Date): Promise<void> {
  if (!token) throw new OAuthError("invalid_request", "token is required");
  const hash = sha256(token);
  const [row] = await db
    .select({ grantId: oauthTokens.grantId, clientId: oauthTokens.clientId })
    .from(oauthTokens)
    .where(or(eq(oauthTokens.accessTokenHash, hash), eq(oauthTokens.refreshTokenHash, hash)));
  if (row && row.clientId === client.id) await revokeGrant(db, row.grantId, now);
}

// ---------------------------------------------------------------------------
// Resource server: bearer access tokens on /api/mcp
// ---------------------------------------------------------------------------

const BEARER = /^Bearer\s+(fca_[A-Za-z0-9_-]{43})\s*$/i;

export type AccessCheck = { ok: true; user: SessionUser; grantId: string; clientName: string } | { ok: false; reason: "missing" | "invalid" };

/**
 * A bearer token for /api/mcp: live, not rotated / revoked, of a user who is still a founder, and
 * — when it was issued for a resource (RFC 8707) — for THIS server's MCP resource (`base`).
 */
export async function authenticateAccessToken(db: Db, authorization: string | null, now: Date, base: string): Promise<AccessCheck> {
  if (!authorization) return { ok: false, reason: "missing" };
  const m = BEARER.exec(authorization);
  if (!m) return { ok: false, reason: "invalid" };
  const [row] = await db
    .select({ token: oauthTokens, clientName: oauthClients.clientName })
    .from(oauthTokens)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthTokens.clientId))
    .where(
      and(
        eq(oauthTokens.accessTokenHash, sha256(m[1]!)),
        isNull(oauthTokens.revokedAt),
        isNull(oauthTokens.rotatedAt),
        gt(oauthTokens.accessExpiresAt, now),
      ),
    );
  if (!row) return { ok: false, reason: "invalid" };
  if (row.token.resource && row.token.resource.replace(/\/+$/, "") !== mcpResourceUrl(base.replace(/\/+$/, ""))) {
    return { ok: false, reason: "invalid" };
  }
  const user = await founderUser(db, row.token.userId);
  if (!user) return { ok: false, reason: "invalid" };
  if (!row.token.lastUsedAt || now.getTime() - row.token.lastUsedAt.getTime() > 60_000) {
    await db.update(oauthTokens).set({ lastUsedAt: now }).where(eq(oauthTokens.id, row.token.id));
  }
  return { ok: true, user, grantId: row.token.grantId, clientName: row.clientName };
}

// ---------------------------------------------------------------------------
// Settings → Connected apps
// ---------------------------------------------------------------------------

export interface ConnectedAppView {
  grantId: string;
  clientName: string;
  connectedAt: Date;
  lastUsedAt: Date | null;
}

/** The signed-in founder's live connections (a grant with a usable refresh token). */
export async function listConnectedApps(ctx: ServiceContext): Promise<ConnectedAppView[]> {
  assertCanAuthorize(ctx.user);
  const live = ctx.db
    .select({ grantId: oauthTokens.grantId })
    .from(oauthTokens)
    .where(
      and(
        eq(oauthTokens.userId, ctx.user.id),
        isNull(oauthTokens.revokedAt),
        isNull(oauthTokens.rotatedAt),
        gt(oauthTokens.refreshExpiresAt, ctx.now),
      ),
    );
  const rows = await ctx.db
    .select({
      grantId: oauthTokens.grantId,
      clientName: oauthClients.clientName,
      connectedAt: min(oauthTokens.createdAt),
      lastUsedAt: max(oauthTokens.lastUsedAt),
    })
    .from(oauthTokens)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthTokens.clientId))
    .where(and(eq(oauthTokens.userId, ctx.user.id), inArray(oauthTokens.grantId, live)))
    .groupBy(oauthTokens.grantId, oauthClients.clientName)
    .orderBy(desc(min(oauthTokens.createdAt)));
  return rows.map((r) => ({ grantId: r.grantId, clientName: r.clientName, connectedAt: r.connectedAt!, lastUsedAt: r.lastUsedAt ?? null }));
}

/** Disconnects one of the founder's own apps (another founder's grant is "not found"). */
export async function revokeConnectedApp(ctx: ServiceContext, grantId: unknown): Promise<void> {
  assertCanAuthorize(ctx.user);
  assertValidId(grantId, "Connection");
  const revoked = await ctx.db
    .update(oauthTokens)
    .set({ revokedAt: ctx.now })
    .where(and(eq(oauthTokens.grantId, grantId), eq(oauthTokens.userId, ctx.user.id), isNull(oauthTokens.revokedAt)))
    .returning({ id: oauthTokens.id });
  if (revoked.length === 0) throw new ServiceError("not_found", "Connection not found");
}
