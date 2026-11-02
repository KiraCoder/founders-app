import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/server/db/client";
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

/** The signed-in user or null. Checks the cookie signature AND the session row. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return getAuthProvider().getUser(await getDb(), token);
}

/** For pages and server actions: redirects to /login when not signed in. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function signInWithPassword(
  email: string,
  password: string,
  userAgent: string | null,
): Promise<SessionUser | null> {
  const result = await getAuthProvider().signIn(await getDb(), email, password, { userAgent });
  if (!result) return null;
  (await cookies()).set(SESSION_COOKIE, result.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: result.expiresAt,
  });
  return result.user;
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  await getAuthProvider().signOut(await getDb(), token);
  jar.delete(SESSION_COOKIE);
}
