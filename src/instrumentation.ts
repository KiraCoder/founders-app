/** Runs once when the Next.js server starts. Fail fast on unsafe production config. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { resolveSessionSecret } = await import("@/server/auth/session-token");
  resolveSessionSecret(); // throws in production when SESSION_SECRET is missing
  const { resolveDatabaseUrl } = await import("@/server/db/connect");
  resolveDatabaseUrl(); // throws in production when DATABASE_URL is missing (no silent PGlite)
  const mode = process.env.AUTH_MODE || "local";
  if (mode !== "local" && mode !== "supabase") {
    throw new Error(`Unknown AUTH_MODE "${mode}".`);
  }
}
