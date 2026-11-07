import { createHash, randomBytes } from "node:crypto";
import type { SessionUser } from "@/server/auth/types";
import type { Db } from "@/server/db/connect";
import { handleAuthorizePost, handleRegister, handleToken } from "@/server/http/oauth";
import { consentToken } from "@/server/services/oauth";

/** Test origin of the app (also the OAuth issuer and the MCP resource's base). */
export const BASE = "https://cockpit.test";
export const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
export const ENV: Record<string, string | undefined> = {};

export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function jsonPost(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

export function formPost(path: string, fields: Record<string, string | undefined>, headers: Record<string, string> = {}): Request {
  const body = new URLSearchParams(Object.entries(fields).filter((e): e is [string, string] => e[1] !== undefined)).toString();
  return new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body });
}

export async function register(db: Db, now: Date, extra: Record<string, unknown> = {}, ip = "10.0.0.1") {
  const res = await handleRegister(
    jsonPost("/api/oauth/register", { client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", ...extra }, { "x-forwarded-for": ip }),
    { db, now: () => now, env: ENV },
  );
  return { res, body: (await res.json()) as Record<string, string> };
}

export interface AuthorizeArgs {
  db: Db;
  user: SessionUser;
  clientId: string;
  challenge: string;
  now: Date;
  decision?: "allow" | "deny";
  state?: string;
  headers?: Record<string, string>;
  token?: string;
  resource?: string;
}

/** Posts the consent form as the browser would (same-origin, form-encoded, consent token). */
export async function authorize(a: AuthorizeArgs): Promise<Response> {
  const token = a.token ?? consentToken(a.user.id, { clientId: a.clientId, redirectUri: REDIRECT, codeChallenge: a.challenge }, a.now);
  return handleAuthorizePost(
    formPost(
      "/api/oauth/authorize",
      {
        response_type: "code",
        client_id: a.clientId,
        redirect_uri: REDIRECT,
        code_challenge: a.challenge,
        code_challenge_method: "S256",
        scope: "cockpit",
        state: a.state ?? "xyz",
        resource: a.resource,
        consent_token: token,
        decision: a.decision ?? "allow",
      },
      a.headers ?? { origin: BASE },
    ),
    { db: a.db, user: a.user, now: () => a.now, env: ENV },
  );
}

export function codeFrom(res: Response): string {
  return new URL(res.headers.get("location")!).searchParams.get("code")!;
}

export async function token(db: Db, now: Date, fields: Record<string, string | undefined>, headers: Record<string, string> = {}) {
  const res = await handleToken(formPost("/api/oauth/token", fields, headers), { db, now: () => now, env: ENV });
  return { res, body: (await res.json()) as Record<string, string | number> };
}

/** Register + consent + code exchange: an access/refresh pair for `user`. */
export async function connect(db: Db, user: SessionUser, now: Date) {
  const { body: client } = await register(db, now, {}, `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`);
  const { verifier, challenge } = pkcePair();
  const code = codeFrom(await authorize({ db, user, clientId: client.client_id!, challenge, now }));
  const { body } = await token(db, now, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT });
  return { clientId: client.client_id!, access: body.access_token as string, refresh: body.refresh_token as string };
}
