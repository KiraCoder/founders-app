import { describe, expect, it } from "vitest";
import { isRemoteDatabaseUrl } from "@/server/db/connect";
import { DEV_PASSWORD_DEFAULT } from "@/server/db/seed";
import { planSeed } from "@/server/db/seed-config";

const SUPABASE = "postgresql://postgres.abc:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres";

describe("isRemoteDatabaseUrl", () => {
  it("treats only this machine (or no URL) as local", () => {
    expect(isRemoteDatabaseUrl(undefined)).toBe(false);
    expect(isRemoteDatabaseUrl("")).toBe(false);
    expect(isRemoteDatabaseUrl("memory://")).toBe(false);
    expect(isRemoteDatabaseUrl("postgres://u:p@localhost:5432/db")).toBe(false);
    expect(isRemoteDatabaseUrl("postgres://u:p@127.0.0.1/db")).toBe(false);
    expect(isRemoteDatabaseUrl("postgres://u:p@[::1]:5432/db")).toBe(false);
    expect(isRemoteDatabaseUrl(SUPABASE)).toBe(true);
    expect(isRemoteDatabaseUrl("postgres://u:p@localhost.evil.com/db")).toBe(true);
    expect(isRemoteDatabaseUrl("not a url")).toBe(true);
  });
});

describe("seed guard (planSeed)", () => {
  it("refuses a real database with a missing, default or short password", () => {
    for (const DEV_FOUNDER_PASSWORD of [undefined, "", "   ", DEV_PASSWORD_DEFAULT, "short-pw-11"]) {
      const r = planSeed("postgres", { DATABASE_URL: SUPABASE, DEV_FOUNDER_PASSWORD });
      expect(r.ok, String(DEV_FOUNDER_PASSWORD)).toBe(false);
    }
    // Also on a local Postgres (any postgres driver counts as a real database).
    expect(planSeed("postgres", { DATABASE_URL: "postgres://localhost/db", DEV_FOUNDER_PASSWORD: DEV_PASSWORD_DEFAULT }).ok).toBe(false);
  });

  it("accepts a strong password on a real database, with samples off unless asked", () => {
    const r = planSeed("postgres", { DATABASE_URL: SUPABASE, DEV_FOUNDER_PASSWORD: "a-private-pass-123" });
    expect(r).toEqual({ ok: true, plan: { password: "a-private-pass-123", withSamples: false, resetPasswords: false } });
    const withSamples = planSeed("postgres", {
      DATABASE_URL: SUPABASE,
      DEV_FOUNDER_PASSWORD: "a-private-pass-123",
      SEED_SAMPLES: "1",
      SEED_RESET_PASSWORDS: "1",
    });
    expect(withSamples.ok && withSamples.plan).toMatchObject({ withSamples: true, resetPasswords: true });
  });

  it("local embedded DB uses the dev password and samples by default", () => {
    expect(planSeed("pglite", {})).toEqual({
      ok: true,
      plan: { password: DEV_PASSWORD_DEFAULT, withSamples: true, resetPasswords: false },
    });
    const off = planSeed("pglite", { SEED_SAMPLES: "0" });
    expect(off.ok && off.plan.withSamples).toBe(false);
  });
});
