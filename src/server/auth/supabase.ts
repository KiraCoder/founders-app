import "server-only";
import type { AuthProvider } from "./types";

/**
 * Supabase Auth provider — STUB (not implemented in this chunk).
 *
 * TODO(supabase):
 * - Add `@supabase/ssr` and create a server client from NEXT_PUBLIC_SUPABASE_URL +
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY using Next.js cookies().
 * - signIn: supabase.auth.signInWithPassword (or magic link / Telegram login).
 * - getUser: supabase.auth.getUser(), then map auth user id -> users.external_auth_id.
 * - signOut: supabase.auth.signOut().
 * - Middleware: refresh the Supabase session cookie instead of verifying our own JWT.
 * - Apply supabase/policies.sql so RLS mirrors the service-layer rules.
 */
function notImplemented(): never {
  throw new Error("AUTH_MODE=supabase is not implemented yet. Use AUTH_MODE=local.");
}

export const supabaseAuthProvider: AuthProvider = {
  mode: "supabase",
  signIn: async () => notImplemented(),
  getUser: async () => notImplemented(),
  signOut: async () => notImplemented(),
};
