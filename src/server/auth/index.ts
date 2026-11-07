import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { redirect } from "next/navigation";
import { getDb } from "@/server/db/client";
import { attemptSignIn } from "./login";
import { localAuthProvider } from "./local";
import { SESSION_COOKIE } from "./session-token";
import { supabaseAuthProvider } from "./supabase";
import type { AuthMode, AuthProvider, SessionUser } from "./types";

export type { SessionUser } from "./types";

export function authMode(): AuthMode {
  const mode = process.env.AUTH_MODE || "local";
  if (mode !== "local" && mode !== "supabase") {
    throw new Error(`Unknown AUTH_MODE "${mode}". Use "local" or "supabase".`);
  }
  return mode;
}

export function getAuthProvider(): AuthProvider {
  return authMode() === "supabase" ? supabaseAuthProvider : localAuthProvider;
}

/**
 * The signed-in user or null. Checks the cookie signature AND the session row.
 * Memoized per request (React `cache`): the layout, the page and generateMetadata share one
 * session lookup. Outside a render (server actions, API routes) every call checks again.
 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return getAuthProvider().getUser(await getDb(), token);
});

/** For pages and server actions: redirects to /login when not signed in. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** Signs in (rate limited, see login-limiter.ts) and sets the session cookie. */
export async function signInWithPassword(
  email: string,
  password: string,
  meta: { userAgent: string | null; ip: string | null },
): Promise<{ ok: true; user: SessionUser } | { ok: false; reason: "invalid" | "rate_limited" }> {
  const outcome = await attemptSignIn(await getDb(), getAuthProvider(), email, password, meta);
  if (!outcome.ok) return outcome;
  const { result } = outcome;
  (await cookies()).set(SESSION_COOKIE, result.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: result.expiresAt,
  });
  return { ok: true, user: result.user };
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  await getAuthProvider().signOut(await getDb(), token);
  jar.delete(SESSION_COOKIE);
}
