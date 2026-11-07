import "server-only";
import type { Db } from "@/server/db/connect";
import { clearLoginFailures, isLoginRateLimited, recordLoginFailure } from "./login-limiter";
import type { AuthProvider, SignInResult } from "./types";

export type LoginOutcome = { ok: true; result: SignInResult } | { ok: false; reason: "invalid" | "rate_limited" };

/** Password sign-in with the rate limit applied. No cookies here, so it is testable. */
export async function attemptSignIn(
  db: Db,
  provider: AuthProvider,
  email: string,
  password: string,
  meta: { userAgent: string | null; ip: string | null },
  now = new Date(),
): Promise<LoginOutcome> {
  const key = { email, ip: meta.ip };
  if (await isLoginRateLimited(db, key, now)) return { ok: false, reason: "rate_limited" };
  const result = await provider.signIn(db, email, password, { userAgent: meta.userAgent });
  if (!result) {
    await recordLoginFailure(db, key, now);
    return { ok: false, reason: "invalid" };
  }
  await clearLoginFailures(db, key);
  return { ok: true, result };
}
