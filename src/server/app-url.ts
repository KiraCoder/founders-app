/**
 * The site's public address. No imports and no "server-only": used by services, the
 * Telegram / reminder-clock setup and tests.
 *
 * APP_URL wins. On Vercel without APP_URL: the production domain
 * (VERCEL_PROJECT_PRODUCTION_URL, e.g. founders-app.vercel.app), else this deployment's own
 * URL (VERCEL_URL). Vercel gives both without "https://"; it is added.
 */
export type AppUrlSource = "APP_URL" | "VERCEL_PROJECT_PRODUCTION_URL" | "VERCEL_URL";

export function resolveAppBaseUrl(
  env: Record<string, string | undefined> = process.env,
): { url: string; source: AppUrlSource } | null {
  const app = env.APP_URL?.trim().replace(/\/+$/, "");
  if (app) return { url: app, source: "APP_URL" };
  for (const source of ["VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_URL"] as const) {
    const host = env[source]?.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (host) return { url: `https://${host}`, source };
  }
  return null;
}
