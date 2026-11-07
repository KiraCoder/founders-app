import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { localAuthProvider } from "@/server/auth/local";
import { attemptSignIn } from "@/server/auth/login";
import {
  clientIpFromHeaders,
  LOGIN_WINDOW_MS,
  MAX_FAILURES_PER_EMAIL,
  MAX_FAILURES_PER_IP,
} from "@/server/auth/login-limiter";
import { loginAttempts } from "@/server/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.handle.close();
});
beforeEach(async () => {
  await t.handle.db.delete(loginAttempts);
});

const T0 = new Date("2026-11-02T06:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const login = (email: string, password: string, ip: string | null, now: Date) =>
  attemptSignIn(t.handle.db, localAuthProvider, email, password, { userAgent: "vitest", ip }, now);

describe("login rate limit", () => {
  it("blocks an email after 10 failures in 15 minutes, even with the right password", async () => {
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL; i++) {
      expect(await login("talant@founders.local", `wrong-${i}`, `10.0.0.${i}`, at(i * 1000))).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
    expect(await login("talant@founders.local", "test-password", "10.0.1.1", at(20_000))).toEqual({
      ok: false,
      reason: "rate_limited",
    });
    // Other accounts are not affected by this email's failures.
    expect((await login("nuraaly@founders.local", "test-password", "10.0.1.1", at(21_000))).ok).toBe(true);
    // After the window it works again, and success clears the counter.
    expect((await login("talant@founders.local", "test-password", "10.0.1.1", at(LOGIN_WINDOW_MS + 10_000))).ok).toBe(true);
    expect(await t.handle.db.select().from(loginAttempts)).toHaveLength(0);
  });

  it("blocks an IP after too many failures across emails", async () => {
    for (let i = 0; i < MAX_FAILURES_PER_IP; i++) {
      await login(`ghost-${i}@example.test`, "x", "203.0.113.9", at(i * 1000));
    }
    expect((await login("nuraaly@founders.local", "test-password", "203.0.113.9", at(30_000))).ok).toBe(false);
    expect((await login("nuraaly@founders.local", "test-password", "203.0.113.10", at(31_000))).ok).toBe(true);
  });

  it("limits unknown emails the same way (reveals nothing about which accounts exist)", async () => {
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL; i++) {
      await login("Nobody@Example.test ", "x", `198.51.100.${i}`, at(i));
    }
    expect(await login("nobody@example.test", "x", "198.51.100.200", at(100))).toEqual({ ok: false, reason: "rate_limited" });
  });

  it("stores only hashes", async () => {
    await login("talant@founders.local", "nope", "192.0.2.1", T0);
    const [row] = await t.handle.db.select().from(loginAttempts);
    expect(row!.emailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain("talant");
    expect(JSON.stringify(row)).not.toContain("192.0.2.1");
  });

  it("reads the client IP from proxy headers", () => {
    expect(clientIpFromHeaders(new Headers({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" }))).toBe("203.0.113.5");
    expect(clientIpFromHeaders(new Headers({ "x-real-ip": "198.51.100.7" }))).toBe("198.51.100.7");
    expect(clientIpFromHeaders(new Headers())).toBeNull();
    // Vercel's own headers win over a (spoofable) x-forwarded-for.
    expect(clientIpFromHeaders(new Headers({ "x-forwarded-for": "6.6.6.6", "x-real-ip": "198.51.100.7" }))).toBe("198.51.100.7");
    expect(clientIpFromHeaders(new Headers({ "x-forwarded-for": "6.6.6.6", "x-vercel-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
    expect(clientIpFromHeaders(new Headers({ "x-real-ip": " ", "x-forwarded-for": "203.0.113.5" }))).toBe("203.0.113.5");
  });
});
