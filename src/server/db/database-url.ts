/** No imports on purpose: instrumentation.ts loads this in every runtime (edge included). */

/**
 * The database URL the APP may use. In production an empty DATABASE_URL is refused (the app
 * would silently fall back to the embedded PGlite database on the server's own disk, which on
 * Vercel is temporary and per instance: data would vanish). `ALLOW_LOCAL_DB=1` allows it for
 * a local production run (e2e). Called at server start (instrumentation.ts) and by getDb().
 */
export function resolveDatabaseUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  const url = env.DATABASE_URL?.trim() || undefined;
  if (!url && env.NODE_ENV === "production" && env.ALLOW_LOCAL_DB !== "1") {
    throw new Error(
      "DATABASE_URL is not set. Refusing to run in production with the embedded local database " +
        "(it would keep data on the server's temporary disk and lose it). Set DATABASE_URL to the " +
        "Supabase connection string (README → Moving to Supabase + Vercel), or ALLOW_LOCAL_DB=1 " +
        "for a local production test only.",
    );
  }
  return url;
}
