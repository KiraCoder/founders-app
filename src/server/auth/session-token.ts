/**
 * Signed session cookie (JWT, HS256 via `jose`).
 *
 * This module does NOT import "server-only" because `src/middleware.ts` (Edge runtime)
 * uses it to reject requests without a validly signed cookie. It never touches the
 * database and only reads SESSION_SECRET, which is never exposed to the browser.
 * The full check (session row exists and is not expired/revoked) happens in
 * `getCurrentUser()` on the server.
 */
import { jwtVerify, SignJWT } from "jose";

export const SESSION_COOKIE = "fc_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** Used ONLY in development/test when SESSION_SECRET is missing. Never valid in production. */
export const DEV_FALLBACK_SESSION_SECRET = "INSECURE-DEV-ONLY-session-secret-set-SESSION_SECRET";

let warned = false;

export function resolveSessionSecret(env: Record<string, string | undefined> = process.env): string {
  const secret = env.SESSION_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET is missing or shorter than 32 characters. Refusing to run in production.",
    );
  }
  if (secret) return secret; // short secret is tolerated in dev
  if (!warned) {
    warned = true;
    console.warn(
      "[auth] SESSION_SECRET is not set. Using the INSECURE dev fallback secret. Never do this in production.",
    );
  }
  return DEV_FALLBACK_SESSION_SECRET;
}

function key(): Uint8Array {
  return new TextEncoder().encode(resolveSessionSecret());
}

export interface SessionClaims {
  /** sessions.id */
  sid: string;
  /** users.id */
  uid: string;
}

export async function signSessionToken(claims: SessionClaims, expiresAt: Date): Promise<string> {
  return new SignJWT({ sid: claims.sid })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.uid)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(key());
}

export async function verifySessionToken(token: string | undefined): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    if (typeof payload.sid !== "string" || typeof payload.sub !== "string") return null;
    return { sid: payload.sid, uid: payload.sub };
  } catch {
    return null;
  }
}
