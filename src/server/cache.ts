import "server-only";
import { revalidateTag, unstable_cache } from "next/cache";

/**
 * Cross-request cache for slow-changing, SHARED data (Next.js data cache, `unstable_cache`).
 *
 * Rules (see docs in the PR "perf/caching"):
 * - Only data that is identical for both founders goes in: company list, people pickers, org
 *   chart structure, metric definitions, AI role configs, project pickers, the bot's defaults. Never salaries, never personal todos
 *   or anything else filtered by the signed-in user (callers only use it for founders, whose
 *   access rules are identical; staff read the database directly).
 * - Every service write to one of these entities calls `invalidate(tag)`; Next drops the
 *   entries at the end of that request (after the transaction committed). `revalidate` is a
 *   short safety net for any write that bypasses the services (SQL console, a seed).
 * - Write paths never read through this cache (a write followed by a read in the same request
 *   would see the old entry: tags are only dropped when the request ends).
 *
 * Outside a Next.js request (Vitest, CLI scripts) there is no data cache: `sharedCache` calls
 * straight through and `invalidate` is a no-op.
 */
export const CACHE_TAGS = {
  companies: "companies",
  people: "people",
  metrics: "metrics",
  aiRoles: "ai-roles",
  /** Project pickers (task form). */
  projects: "projects",
  /** The bot's global chase defaults (Settings → Team on Telegram). */
  staffSettings: "staff-settings",
  /** Task labels (pickers; Settings → Labels). */
  labels: "labels",
  /** Every org chart (department pickers across charts). */
  org: "org",
  /** One chart's structure. */
  orgChart: (chartId: string) => `org:${chartId}`,
  // Change signals for `refreshAfterWrite`: nothing is cached under these (yet), so revalidating
  // one drops no entry; it only makes Next re-render the page the action was called from.
  tasks: "tasks",
  routines: "routines",
  /** Team on Telegram (bot switch, pause, link, invite). */
  staff: "staff",
  salaries: "salaries",
  metricValues: "metric-values",
} as const;

/** Seconds a cached entry lives at most (writes through the services drop it at once). */
export const SHARED_CACHE_SECONDS = 300;

/**
 * Part of every key: Vercel's data cache outlives a deployment, and a new deployment may bring
 * a migration (new columns) or new seed data, so entries are never shared between deployments.
 * Locally (no Vercel id) the key changes with every server start: `.next/cache` survives a
 * `db:reset` / re-seed (done with the server stopped), and old entries would point at rows that
 * no longer exist.
 */
const BUILD_ID = process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_GIT_COMMIT_SHA ?? `local-${Date.now().toString(36)}`;

// Dates survive the JSON round trip of the data cache as {"$d": iso}.
function encode(value: unknown): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, key, v) {
    const raw = this[key];
    return raw instanceof Date ? { $d: raw.toISOString() } : v;
  });
}

function decode<T>(text: string): T {
  return JSON.parse(text, (_key, v) => (v && typeof v === "object" && typeof v.$d === "string" && Object.keys(v).length === 1 ? new Date(v.$d) : v)) as T;
}

function outsideNext(err: unknown): boolean {
  return err instanceof Error && /incrementalCache missing/.test(err.message);
}

/**
 * Reads through the data cache. `key` must identify the query and all its inputs (no user ids:
 * entries are shared); `tags` are what writes invalidate.
 */
export async function sharedCache<T>(key: readonly string[], tags: readonly string[], load: () => Promise<T>): Promise<T> {
  const cached = unstable_cache(async () => encode(await load()), ["fc:v1", BUILD_ID, ...key], { tags: [...tags], revalidate: SHARED_CACHE_SECONDS });
  let text: string;
  try {
    text = await cached();
  } catch (err) {
    if (outsideNext(err)) return load();
    throw err;
  }
  return decode<T>(text);
}

/**
 * The end of a server action that wrote something: revalidate the touched entity's tag (the
 * services already dropped the cached entries they own). Any revalidation makes Next send the
 * calling page re-rendered (layout included) with the action result and makes the browser drop
 * its router cache; every app page is dynamic, so all other pages are rendered fresh on the next
 * visit. Deliberately NOT `revalidatePath("/", "layout")` (or any path): a path's implicit tag
 * is on every cached entry read on that path, so it would refill the shared cache for nothing.
 */
export function refreshAfterWrite(...tags: string[]): void {
  invalidate(...tags);
}

/**
 * Drops cached entries with these tags (at the end of the current request). Safe to call
 * anywhere: outside a request (tests, scripts) there is nothing to drop.
 */
export function invalidate(...tags: string[]): void {
  for (const tag of tags) {
    try {
      revalidateTag(tag);
    } catch {
      // No request store (Vitest, CLI) — nothing is cached there. During a render Next refuses
      // revalidation; no service write runs during a render (writes are actions / API routes).
    }
  }
}
