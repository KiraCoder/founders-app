import "server-only";
import { createHash } from "node:crypto";
import { and, eq, gt, lt, or, sql } from "drizzle-orm";
import type { Db } from "@/server/db/connect";
import { loginAttempts } from "@/server/db/schema";

/**
 * Sign-in rate limit (C1 review finding 8), backed by the database so it works on
 * PGlite and Postgres and holds across serverless instances.
 *
 * - At most MAX_FAILURES_PER_EMAIL failed attempts per email in LOGIN_WINDOW_MS, and
 *   MAX_FAILURES_PER_IP per client IP (a bit higher: both founders may share an office
 *   IP). Once over, sign-in is refused without checking the password.
 * - Only failures are stored, as SHA-256 hashes; a successful sign-in clears that
 *   email's failures. Rows older than a day are pruned.
 * - Applies to unknown emails too, so the limit reveals nothing about which accounts exist.
 * Later, with more users: a shared store (e.g. Redis/Upstash) and per-account lockout
 * notifications.
 */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILURES_PER_EMAIL = 10;
export const MAX_FAILURES_PER_IP = 20;
const RETENTION_MS = 24 * 60 * 60 * 1000;

export interface LoginKey {
  email: string;
  ip: string | null;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function hashes(key: LoginKey) {
  return {
    emailHash: sha256(`email:${key.email.trim().toLowerCase()}`),
    ipHash: sha256(`ip:${key.ip?.trim() || "unknown"}`),
  };
}

export async function isLoginRateLimited(db: Db, key: LoginKey, now = new Date()): Promise<boolean> {
  const { emailHash, ipHash } = hashes(key);
  const since = new Date(now.getTime() - LOGIN_WINDOW_MS);
  const [row] = await db
    .select({
      byEmail: sql<number>`count(*) filter (where ${loginAttempts.emailHash} = ${emailHash})`.mapWith(Number),
      byIp: sql<number>`count(*) filter (where ${loginAttempts.ipHash} = ${ipHash})`.mapWith(Number),
    })
    .from(loginAttempts)
    .where(
      and(
        gt(loginAttempts.createdAt, since),
        or(eq(loginAttempts.emailHash, emailHash), eq(loginAttempts.ipHash, ipHash)),
      ),
    );
  return (row?.byEmail ?? 0) >= MAX_FAILURES_PER_EMAIL || (row?.byIp ?? 0) >= MAX_FAILURES_PER_IP;
}

export async function recordLoginFailure(db: Db, key: LoginKey, now = new Date()): Promise<void> {
  await db.insert(loginAttempts).values({ ...hashes(key), createdAt: now });
  await db.delete(loginAttempts).where(lt(loginAttempts.createdAt, new Date(now.getTime() - RETENTION_MS)));
}

export async function clearLoginFailures(db: Db, key: LoginKey): Promise<void> {
  await db.delete(loginAttempts).where(eq(loginAttempts.emailHash, hashes(key).emailHash));
}

/** Client IP from the proxy headers (Vercel sets x-forwarded-for; the first entry is the client). */
export function clientIpFromHeaders(headers: Pick<Headers, "get">): string | null {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || null;
}
