import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { migrateOnBuildDecision } from "@/server/db/migrate";

describe("db:migrate:deploy guard (whole-app review #2)", () => {
  it("is off unless MIGRATE_ON_BUILD=1", () => {
    expect(migrateOnBuildDecision({}).run).toBe(false);
    expect(migrateOnBuildDecision({ MIGRATE_ON_BUILD: "true", DATABASE_URL: "postgresql://x@db.example.com/p" }).run).toBe(false);
    expect(migrateOnBuildDecision({ MIGRATE_ON_BUILD: "0", DATABASE_URL: "postgresql://x@db.example.com/p" }).run).toBe(false);
  });

  it("with MIGRATE_ON_BUILD=1 it needs a real DATABASE_URL (never migrates the embedded DB on a build)", () => {
    expect(() => migrateOnBuildDecision({ MIGRATE_ON_BUILD: "1" })).toThrow(/DATABASE_URL is not set/);
    expect(migrateOnBuildDecision({ MIGRATE_ON_BUILD: "1", DATABASE_URL: "postgresql://x@db.example.com/p" }).run).toBe(true);
  });

  it("the npm script exits 0 and touches nothing when the flag is off", () => {
    const out = execFileSync("npx", ["tsx", "scripts/db-migrate-deploy.ts"], {
      env: { ...process.env, MIGRATE_ON_BUILD: "", DATABASE_URL: "postgresql://nobody@127.0.0.1:1/none" },
      encoding: "utf8",
    });
    expect(out).toContain("skipped");
  }, 30_000);
});
