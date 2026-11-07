import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { middleware } from "@/middleware";
import { oauthAuthCodes, oauthClients, oauthTokens, users } from "@/server/db/schema";
import { authorizationServerMetadataResponse, handleRegister, handleRevoke, protectedResourceMetadataResponse } from "@/server/http/oauth";
import { handleMcpRequest } from "@/server/http/mcp";
import type { SessionUser } from "@/server/auth/types";
import {
  allowedRedirectHosts,
  authenticateAccessToken,
  checkAuthorizeRequest,
  consentToken,
  issueAuthorizationCode,
  listConnectedApps,
  revokeConnectedApp,
  sha256,
} from "@/server/services/oauth";
import { createTestDb, FIXED_NOW, type TestDb } from "../helpers/db";
import { authorize, BASE, codeFrom, connect, ENV, formPost, jsonPost, pkcePair, REDIRECT, register, token } from "../helpers/oauth";

let t: TestDb;
const now = FIXED_NOW;
const later = (ms: number) => new Date(now.getTime() + ms);

function mcpPing(access: string, at = now) {
  return handleMcpRequest(
    new Request(`${BASE}/api/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
    { db: t.handle.db, now: () => at, env: ENV },
  );
}

async function insertUser(role: "founder" | "staff", key: string): Promise<SessionUser> {
  const [u] = await t.handle.db
    .insert(users)
    .values({ email: `${key}@founders.local`, name: key, shortName: key, role })
    .returning();
  return { id: u!.id, email: u!.email, name: u!.name, shortName: u!.shortName, role };
}

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.handle.close();
});

describe("discovery metadata", () => {
  it("authorization server (RFC 8414) and protected resource (RFC 9728) documents", async () => {
    const as = await authorizationServerMetadataResponse(new Request(`${BASE}/.well-known/oauth-authorization-server`), ENV).json();
    expect(as).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/api/oauth/token`,
      registration_endpoint: `${BASE}/api/oauth/register`,
      revocation_endpoint: `${BASE}/api/oauth/revoke`,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      response_types_supported: ["code"],
    });
    expect(as.token_endpoint_auth_methods_supported).toContain("none");
    const pr = await protectedResourceMetadataResponse(new Request(`${BASE}/.well-known/oauth-protected-resource`), ENV).json();
    expect(pr).toEqual(expect.objectContaining({ resource: `${BASE}/api/mcp`, authorization_servers: [BASE], bearer_methods_supported: ["header"] }));
    // APP_URL wins over the request's origin.
    const pinned = await protectedResourceMetadataResponse(new Request("http://internal:3000/.well-known/oauth-protected-resource"), { APP_URL: "https://founders-app-one.vercel.app/" }).json();
    expect(pinned.resource).toBe("https://founders-app-one.vercel.app/api/mcp");
  });

  it("/api/mcp without a token: 401 with WWW-Authenticate pointing at the resource metadata", async () => {
    const res = await handleMcpRequest(new Request(`${BASE}/api/mcp`, { method: "POST", body: "{}" }), { db: t.handle.db, env: ENV });
    expect(res.status).toBe(401);
    const www = res.headers.get("www-authenticate")!;
    expect(www).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);
    expect(www).not.toContain("invalid_token");
    const bad = await mcpPing("fca_" + "x".repeat(43));
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect((await handleMcpRequest(new Request(`${BASE}/api/mcp`, { method: "POST", headers: { authorization: "Bearer nope" } }), { db: t.handle.db, env: ENV })).status).toBe(401);
  });
});

describe("dynamic client registration (RFC 7591)", () => {
  it("registers a public client; stores no secret", async () => {
    const { res, body } = await register(t.handle.db, now);
    expect(res.status).toBe(201);
    expect(body.client_id).toMatch(/^fcl_/);
    expect(body).not.toHaveProperty("client_secret");
    expect(body).toMatchObject({ token_endpoint_auth_method: "none", redirect_uris: [REDIRECT], client_name: "Claude" });
    const [row] = await t.handle.db.select().from(oauthClients).where(eq(oauthClients.clientId, body.client_id!));
    expect(row!.clientSecretHash).toBeNull();
  });

  it("confidential clients get a secret once (only its hash is stored)", async () => {
    const { body } = await register(t.handle.db, now, { token_endpoint_auth_method: "client_secret_post" }, "10.0.0.2");
    expect(body.client_secret).toMatch(/^fcs_/);
    const [row] = await t.handle.db.select().from(oauthClients).where(eq(oauthClients.clientId, body.client_id!));
    expect(row!.clientSecretHash).toBe(sha256(body.client_secret!));
  });

  it("refuses bad metadata: no redirect, http redirect, fragment, unknown grant", async () => {
    for (const extra of [
      { redirect_uris: [] },
      { redirect_uris: ["http://evil.example/cb"] },
      { redirect_uris: ["https://claude.ai/cb#x"] },
      { grant_types: ["client_credentials"] },
    ]) {
      const { res, body } = await register(t.handle.db, now, extra, "10.0.0.3");
      expect(res.status).toBe(400);
      expect(body.error).toMatch(/invalid_(redirect_uri|client_metadata)/);
    }
    const { res } = await register(t.handle.db, now, { redirect_uris: ["http://localhost:6274/cb"] }, "10.0.0.3");
    expect(res.status).toBe(201);
  });

  it("rate-limits registrations per IP", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await register(t.handle.db, now, {}, "10.0.0.99")).res.status);
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});

describe("authorization code + PKCE", () => {
  it("full flow: consent → code → tokens → MCP works; the code is one-time", async () => {
    const { body: client } = await register(t.handle.db, now, {}, "10.1.0.1");
    const { verifier, challenge } = pkcePair();
    const res = await authorize({ db: t.handle.db, user: t.founders.nuraaly, clientId: client.client_id!, challenge, now, state: "s-123", resource: `${BASE}/api/mcp` });
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
    expect(loc.searchParams.get("state")).toBe("s-123");
    expect(loc.searchParams.get("iss")).toBe(BASE);
    const code = loc.searchParams.get("code")!;
    expect(code).toMatch(/^fcc_/);
    const [stored] = await t.handle.db.select().from(oauthAuthCodes).where(eq(oauthAuthCodes.codeHash, sha256(code)));
    expect(stored).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain(code);

    const { res: tr, body } = await token(t.handle.db, now, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT, resource: `${BASE}/api/mcp` });
    expect(tr.status).toBe(200);
    expect(tr.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "cockpit" });
    expect(body.access_token).toMatch(/^fca_/);
    expect(body.refresh_token).toMatch(/^fcr_/);
    const rows = await t.handle.db.select().from(oauthTokens).where(eq(oauthTokens.accessTokenHash, sha256(body.access_token as string)));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(body.access_token as string);

    expect((await mcpPing(body.access_token as string)).status).toBe(200);
    // Access token TTL is 1 hour.
    expect((await mcpPing(body.access_token as string, later(3601_000))).status).toBe(401);

    // Using the same code again fails and revokes what it issued.
    const again = await token(t.handle.db, now, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT });
    expect(again.res.status).toBe(400);
    expect(again.body.error).toBe("invalid_grant");
    expect((await mcpPing(body.access_token as string)).status).toBe(401);
  });

  it("wrong verifier, wrong redirect_uri, other client and an expired code are refused", async () => {
    const { body: client } = await register(t.handle.db, now, {}, "10.1.0.2");
    const { body: other } = await register(t.handle.db, now, {}, "10.1.0.2");
    const { verifier, challenge } = pkcePair();
    const fresh = async () => codeFrom(await authorize({ db: t.handle.db, user: t.founders.nuraaly, clientId: client.client_id!, challenge, now }));

    const wrong = await token(t.handle.db, now, { grant_type: "authorization_code", code: await fresh(), code_verifier: pkcePair().verifier, client_id: client.client_id });
    expect(wrong.body).toMatchObject({ error: "invalid_grant", error_description: "PKCE verification failed" });
    const missing = await token(t.handle.db, now, { grant_type: "authorization_code", code: await fresh(), client_id: client.client_id });
    expect(missing.body.error).toBe("invalid_request");
    const redirect = await token(t.handle.db, now, { grant_type: "authorization_code", code: await fresh(), code_verifier: verifier, client_id: client.client_id, redirect_uri: "https://claude.ai/other" });
    expect(redirect.body.error).toBe("invalid_grant");
    const stolen = await token(t.handle.db, now, { grant_type: "authorization_code", code: await fresh(), code_verifier: verifier, client_id: other.client_id });
    expect(stolen.body.error).toBe("invalid_grant");
    const expired = await token(t.handle.db, later(11 * 60_000), { grant_type: "authorization_code", code: await fresh(), code_verifier: verifier, client_id: client.client_id });
    expect(expired.body).toMatchObject({ error: "invalid_grant", error_description: "Authorization code expired" });
    const unknownClient = await token(t.handle.db, now, { grant_type: "authorization_code", code: await fresh(), code_verifier: verifier, client_id: "fcl_nope" });
    expect(unknownClient.res.status).toBe(401);
    expect(unknownClient.body.error).toBe("invalid_client");
    const grant = await token(t.handle.db, now, { grant_type: "password", client_id: client.client_id });
    expect(grant.body.error).toBe("unsupported_grant_type");
  });

  it("confidential client: the secret is required (post or basic, as registered)", async () => {
    const { body: c } = await register(t.handle.db, now, { token_endpoint_auth_method: "client_secret_basic" }, "10.1.0.3");
    const { verifier, challenge } = pkcePair();
    const code = codeFrom(await authorize({ db: t.handle.db, user: t.founders.talant, clientId: c.client_id!, challenge, now }));
    const noSecret = await token(t.handle.db, now, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: c.client_id });
    expect(noSecret.res.status).toBe(401);
    const basic = `Basic ${Buffer.from(`${c.client_id}:${c.client_secret}`).toString("base64")}`;
    const ok = await token(t.handle.db, now, { grant_type: "authorization_code", code, code_verifier: verifier }, { authorization: basic });
    expect(ok.res.status).toBe(200);
  });

  it("authorize request errors: bad PKCE method redirects back with an error; unknown client is not redirected", async () => {
    const { body: client } = await register(t.handle.db, now, {}, "10.1.0.4");
    const { challenge } = pkcePair();
    const req = (fields: Record<string, string>) =>
      formPost("/api/oauth/authorize", {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        consent_token: consentToken(t.founders.nuraaly.id, { clientId: client.client_id!, redirectUri: REDIRECT, codeChallenge: challenge }, now),
        decision: "allow",
        ...fields,
      }, { origin: BASE });
    const { handleAuthorizePost } = await import("@/server/http/oauth");
    const deps = { db: t.handle.db, user: t.founders.nuraaly, now: () => now, env: ENV };
    const plain = await handleAuthorizePost(req({ code_challenge_method: "plain" }), deps);
    expect(plain.status).toBe(303);
    expect(new URL(plain.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    const noPkce = await handleAuthorizePost(req({ code_challenge: "" }), deps);
    expect(new URL(noPkce.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    const target = await handleAuthorizePost(req({ resource: "https://evil.example/mcp" }), deps);
    expect(new URL(target.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
    const unknown = await handleAuthorizePost(req({ client_id: "fcl_unknown" }), deps);
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get("location")).toBeNull();
    const otherRedirect = await handleAuthorizePost(req({ redirect_uri: "https://evil.example/cb" }), deps);
    expect(otherRedirect.status).toBe(400);
    expect(otherRedirect.headers.get("location")).toBeNull();
    const deny = await handleAuthorizePost(req({ decision: "deny" }), deps);
    expect(new URL(deny.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
    expect(new URL(deny.headers.get("location")!).searchParams.get("code")).toBeNull();
  });

  it("consent POST CSRF: cross-site / missing Origin, wrong or expired consent token, no session → refused", async () => {
    const { body: client } = await register(t.handle.db, now, {}, "10.1.0.5");
    const { challenge } = pkcePair();
    const base = { db: t.handle.db, user: t.founders.nuraaly, clientId: client.client_id!, challenge, now };
    expect((await authorize({ ...base, headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await authorize({ ...base, headers: {} })).status).toBe(403);
    expect((await authorize({ ...base, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await authorize({ ...base, headers: { "sec-fetch-site": "same-origin" } })).status).toBe(303);
    // A token minted for Talant does not work for Nuraaly; nor one for another challenge; nor an old one.
    const talants = consentToken(t.founders.talant.id, { clientId: client.client_id!, redirectUri: REDIRECT, codeChallenge: challenge }, now);
    expect((await authorize({ ...base, token: talants })).status).toBe(403);
    const otherChallenge = consentToken(t.founders.nuraaly.id, { clientId: client.client_id!, redirectUri: REDIRECT, codeChallenge: pkcePair().challenge }, now);
    expect((await authorize({ ...base, token: otherChallenge })).status).toBe(403);
    const minted = consentToken(t.founders.nuraaly.id, { clientId: client.client_id!, redirectUri: REDIRECT, codeChallenge: challenge }, now);
    expect((await authorize({ ...base, token: minted, now: later(31 * 60_000) })).status).toBe(403);
    expect((await authorize({ ...base, token: minted, now: later(29 * 60_000) })).status).toBe(303);
    expect((await authorize({ ...base, token: "garbage" })).status).toBe(403);
    const { handleAuthorizePost } = await import("@/server/http/oauth");
    const anon = await handleAuthorizePost(formPost("/api/oauth/authorize", { client_id: client.client_id }, { origin: BASE }), { db: t.handle.db, user: null, env: ENV });
    expect(anon.status).toBe(401);
  });

  it("only founders can authorize; a demoted founder's tokens stop working", async () => {
    const staff = await insertUser("staff", "staffer");
    const { body: client } = await register(t.handle.db, now, {}, "10.1.0.6");
    const { verifier, challenge } = pkcePair();
    const refused = await authorize({ db: t.handle.db, user: staff, clientId: client.client_id!, challenge, now });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("location")).toBeNull();
    await expect(
      issueAuthorizationCode(t.handle.db, staff, { client: { id: "x", clientId: client.client_id!, name: "x" }, redirectUri: REDIRECT, codeChallenge: challenge, state: null, scope: "cockpit", resource: null }, now),
    ).rejects.toMatchObject({ code: "forbidden" });

    // A third founder connects, then is demoted: access and refresh both stop.
    const third = await insertUser("founder", "third");
    const pair = await connect(t.handle.db, third, now);
    expect((await mcpPing(pair.access)).status).toBe(200);
    // Code issued while founder but exchanged after demotion is refused too.
    const code = codeFrom(await authorize({ db: t.handle.db, user: third, clientId: client.client_id!, challenge, now }));
    await t.handle.db.update(users).set({ role: "staff" }).where(eq(users.id, third.id));
    expect((await mcpPing(pair.access)).status).toBe(401);
    const r = await token(t.handle.db, now, { grant_type: "refresh_token", refresh_token: pair.refresh, client_id: pair.clientId });
    expect(r.body.error).toBe("invalid_grant");
    const c = await token(t.handle.db, now, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id });
    expect(c.body.error).toBe("invalid_grant");
  });
});

describe("refresh rotation and revocation", () => {
  it("refresh issues a new pair and retires the old one; reusing an old refresh token revokes the connection", async () => {
    const pair = await connect(t.handle.db, t.founders.nuraaly, now);
    const r1 = await token(t.handle.db, later(30 * 60_000), { grant_type: "refresh_token", refresh_token: pair.refresh, client_id: pair.clientId });
    expect(r1.res.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(pair.refresh);
    expect(r1.body.access_token).not.toBe(pair.access);
    expect((await mcpPing(pair.access)).status).toBe(401); // rotated
    expect((await mcpPing(r1.body.access_token as string)).status).toBe(200);
    // New access token lives 1 h from the refresh.
    expect((await mcpPing(r1.body.access_token as string, later(80 * 60_000))).status).toBe(200);

    const r2 = await token(t.handle.db, later(40 * 60_000), { grant_type: "refresh_token", refresh_token: r1.body.refresh_token as string, client_id: pair.clientId });
    expect(r2.res.status).toBe(200);

    // Replay of the first (already rotated) refresh token: refused, and the whole grant is revoked.
    const replay = await token(t.handle.db, later(41 * 60_000), { grant_type: "refresh_token", refresh_token: pair.refresh, client_id: pair.clientId });
    expect(replay.body.error).toBe("invalid_grant");
    expect((await mcpPing(r2.body.access_token as string)).status).toBe(401);
    const after = await token(t.handle.db, later(42 * 60_000), { grant_type: "refresh_token", refresh_token: r2.body.refresh_token as string, client_id: pair.clientId });
    expect(after.body.error).toBe("invalid_grant");
  });

  it("refresh tokens expire after 30 days and belong to their client", async () => {
    const pair = await connect(t.handle.db, t.founders.talant, now);
    const { body: other } = await register(t.handle.db, now, {}, "10.2.0.1");
    const wrongClient = await token(t.handle.db, now, { grant_type: "refresh_token", refresh_token: pair.refresh, client_id: other.client_id });
    expect(wrongClient.body.error).toBe("invalid_grant");
    const old = await token(t.handle.db, later(31 * 86_400_000), { grant_type: "refresh_token", refresh_token: pair.refresh, client_id: pair.clientId });
    expect(old.body).toMatchObject({ error: "invalid_grant", error_description: "Refresh token expired" });
  });

  it("RFC 7009 revocation endpoint revokes the grant (unknown tokens → 200)", async () => {
    const pair = await connect(t.handle.db, t.founders.nuraaly, now);
    const revoke = (tok: string, clientId = pair.clientId) => handleRevoke(formPost("/api/oauth/revoke", { token: tok, client_id: clientId }), { db: t.handle.db, now: () => now, env: ENV });
    expect((await revoke("fca_unknown")).status).toBe(200);
    // Another client cannot revoke it.
    const { body: other } = await register(t.handle.db, now, {}, "10.2.0.2");
    await revoke(pair.access, other.client_id);
    expect((await mcpPing(pair.access)).status).toBe(200);
    expect((await revoke(pair.refresh)).status).toBe(200);
    expect((await mcpPing(pair.access)).status).toBe(401);
    const r = await token(t.handle.db, now, { grant_type: "refresh_token", refresh_token: pair.refresh, client_id: pair.clientId });
    expect(r.body.error).toBe("invalid_grant");
  });

  it("Settings → Connected apps: each founder lists and revokes only their own", async () => {
    const db = t.handle.db;
    await db.update(oauthTokens).set({ revokedAt: now }); // start clean
    const n = await connect(db, t.founders.nuraaly, now);
    await connect(db, t.founders.talant, now);
    // A rotation keeps it one connection.
    await token(db, now, { grant_type: "refresh_token", refresh_token: n.refresh, client_id: n.clientId });
    await mcpPing((await connect(db, t.founders.nuraaly, now)).access);
    const mine = await listConnectedApps(t.ctx("nuraaly"));
    expect(mine).toHaveLength(2);
    expect(mine.every((a) => a.clientName === "Claude")).toBe(true);
    expect(mine.some((a) => a.lastUsedAt)).toBe(true);
    expect(await listConnectedApps(t.ctx("talant"))).toHaveLength(1);
    await expect(revokeConnectedApp(t.ctx("talant"), mine[0]!.grantId)).rejects.toMatchObject({ code: "not_found" });
    await revokeConnectedApp(t.ctx("nuraaly"), mine[0]!.grantId);
    expect(await listConnectedApps(t.ctx("nuraaly"))).toHaveLength(1);
    const staffCtx = { ...t.ctx("nuraaly"), user: { ...t.founders.nuraaly, role: "staff" as const } };
    await expect(listConnectedApps(staffCtx)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("middleware exemptions are exact", () => {
  const pass = (r: Response) => r.headers.get("x-middleware-next") === "1";
  const mw = (path: string, method = "POST") => middleware(new NextRequest(`${BASE}${path}`, { method, headers: { origin: "https://claude.ai", "content-type": "application/x-www-form-urlencoded" } }));

  it("MCP, register, token, revoke and the well-known documents need no session", async () => {
    for (const p of ["/api/mcp", "/api/oauth/register", "/api/oauth/token", "/api/oauth/revoke"]) expect(pass(await mw(p))).toBe(true);
    for (const p of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/api/mcp"]) {
      expect(pass(await mw(p, "GET"))).toBe(true);
    }
  });

  it("look-alikes, sub-paths and the consent endpoints still need a session", async () => {
    for (const p of ["/api/mcpx", "/api/mcp/x", "/api/oauth", "/api/oauth/authorize", "/api/oauth/tokens", "/api/oauth/token/x", "/api/oauth/register/x", "/api/v1/tasks", "/.well-knownx"]) {
      const res = await mw(p);
      expect(pass(res)).toBe(false);
      expect([401, 403, 307]).toContain(res.status); // 403: /api/v1 cross-site guard; 307: page → /login
    }
    const page = await mw("/oauth/authorize?client_id=x", "GET");
    expect(page.status).toBe(307);
    const loc = new URL(page.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("next")).toBe("/oauth/authorize?client_id=x");
  });

  it("JSON body on the token endpoint works too (lenient)", async () => {
    const { handleToken } = await import("@/server/http/oauth");
    const res = await handleToken(jsonPost("/api/oauth/token", { grant_type: "refresh_token", refresh_token: "fcr_x", client_id: "fcl_x" }), { db: t.handle.db, env: ENV });
    expect(res.status).toBe(401);
    const bad = await handleToken(new Request(`${BASE}/api/oauth/token`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" }), { db: t.handle.db, env: ENV });
    expect(bad.status).toBe(400);
  });
});

describe("review fixes: redirect allowlist and token audience", () => {
  it("registration accepts only claude.ai / claude.com / loopback / OAUTH_EXTRA_REDIRECT_HOSTS redirect_uris", async () => {
    let ip = 0;
    const reg = (uris: string[], env: Record<string, string | undefined> = ENV) =>
      handleRegister(
        jsonPost("/api/oauth/register", { client_name: "X", redirect_uris: uris, token_endpoint_auth_method: "none" }, { "x-forwarded-for": `10.7.${++ip}.1` }),
        { db: t.handle.db, now: () => now, env },
      );
    for (const ok of [
      "https://claude.ai/api/mcp/auth_callback",
      "https://claude.com/api/mcp/auth_callback",
      "http://localhost:6274/cb",
      "http://127.0.0.1:33418/cb",
      "https://localhost/cb",
    ]) {
      expect((await reg([ok])).status, ok).toBe(201);
    }
    for (const bad of [
      "https://evil.example/cb",
      "https://claude.ai.evil.example/cb",
      "https://evil.claude.ai/cb",
      "http://claude.ai/cb",
      "https://user:pw@claude.ai/cb",
      "javascript:alert(1)",
    ]) {
      const res = await reg([bad]);
      expect(res.status, bad).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_redirect_uri");
    }
    // One bad URI spoils the registration.
    expect((await reg([REDIRECT, "https://evil.example/cb"])).status).toBe(400);
    // Extra hosts from the environment (comma list, case and spaces ignored); still https only.
    const env = { OAUTH_EXTRA_REDIRECT_HOSTS: " Tools.Example.com , other.example " };
    expect((await reg(["https://tools.example.com/cb"], env)).status).toBe(201);
    expect((await reg(["https://other.example/cb"], env)).status).toBe(201);
    expect((await reg(["http://tools.example.com/cb"], env)).status).toBe(400);
    expect(allowedRedirectHosts({}).has("claude.ai")).toBe(true);
  });

  it("a client registered with a now-disallowed redirect_uri gets an error page, never a redirect", async () => {
    const evil = "https://evil.example/cb";
    await t.handle.db.insert(oauthClients).values({
      clientId: "fcl_legacy_evil_client",
      clientSecretHash: null,
      clientName: "Legacy",
      redirectUris: [evil],
      tokenEndpointAuthMethod: "none",
      clientUri: null,
      createdAt: now,
    });
    // An invalid PKCE method would normally be an error= redirect back to the client.
    const check = await checkAuthorizeRequest(
      t.handle.db,
      { client_id: "fcl_legacy_evil_client", redirect_uri: evil, response_type: "code", code_challenge_method: "plain" },
      BASE,
      ENV,
    );
    expect(check).toMatchObject({ ok: false, kind: "page" });
    const { handleAuthorizePost } = await import("@/server/http/oauth");
    const res = await handleAuthorizePost(
      formPost("/api/oauth/authorize", { response_type: "token", client_id: "fcl_legacy_evil_client", redirect_uri: evil }, { origin: BASE }),
      { db: t.handle.db, user: t.founders.nuraaly, now: () => now, env: ENV },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    // Once the host is on the allowlist the redirect is trusted: errors go back as redirects.
    const allowed = await checkAuthorizeRequest(t.handle.db, { client_id: "fcl_legacy_evil_client", redirect_uri: evil, response_type: "token" }, BASE, {
      OAUTH_EXTRA_REDIRECT_HOSTS: "evil.example",
    });
    expect(allowed).toMatchObject({ ok: false, kind: "redirect", error: "unsupported_response_type" });
  });

  it("an access token issued for another resource is refused at /api/mcp (trailing slash normalised)", async () => {
    const { access } = await connect(t.handle.db, t.founders.nuraaly, now);
    expect((await mcpPing(access)).status).toBe(200);
    const hash = sha256(access);
    await t.handle.db.update(oauthTokens).set({ resource: `${BASE}/api/mcp/` }).where(eq(oauthTokens.accessTokenHash, hash));
    expect((await mcpPing(access)).status).toBe(200);
    await t.handle.db.update(oauthTokens).set({ resource: "https://other-cockpit.test/api/mcp" }).where(eq(oauthTokens.accessTokenHash, hash));
    expect((await mcpPing(access)).status).toBe(401);
    expect((await authenticateAccessToken(t.handle.db, `Bearer ${access}`, now, BASE)).ok).toBe(false);
    expect((await authenticateAccessToken(t.handle.db, `Bearer ${access}`, now, "https://other-cockpit.test/")).ok).toBe(true);
  });
});
