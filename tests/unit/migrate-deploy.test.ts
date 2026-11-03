import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { isTransactionPoolerUrl, postgresClientOptions, withoutPgbouncerParam } from "@/server/db/connect";
import { migrateOnBuildDecision, migrationDatabaseUrl } from "@/server/db/migrate";

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

describe("MIGRATION_DATABASE_URL (optional, e.g. Supabase Session pooler)", () => {
  it("wins over DATABASE_URL for migrations, falls back to DATABASE_URL", () => {
    const pooler = "postgresql://postgres.abc:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres";
    const session = "postgresql://postgres.abc:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres";
    expect(migrationDatabaseUrl({ DATABASE_URL: pooler })).toBe(pooler);
    expect(migrationDatabaseUrl({ DATABASE_URL: pooler, MIGRATION_DATABASE_URL: session })).toBe(session);
    expect(migrationDatabaseUrl({ DATABASE_URL: pooler, MIGRATION_DATABASE_URL: "  " })).toBe(pooler);
    expect(migrationDatabaseUrl({})).toBeUndefined();
    const d = migrateOnBuildDecision({ MIGRATE_ON_BUILD: "1", DATABASE_URL: pooler, MIGRATION_DATABASE_URL: session });
    expect(d).toMatchObject({ run: true, url: session });
    expect(d.message).toContain("MIGRATION_DATABASE_URL");
    expect(migrateOnBuildDecision({ MIGRATE_ON_BUILD: "1", MIGRATION_DATABASE_URL: session })).toMatchObject({ run: true, url: session });
  });
});

describe("postgres-js options behind Supabase's poolers", () => {
  it("never uses prepared statements (transaction pooler 6543 / pgbouncer=true, and also elsewhere)", () => {
    const tx = "postgresql://postgres.abc:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres";
    const session = "postgresql://postgres.abc:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres";
    expect(isTransactionPoolerUrl(tx)).toBe(true);
    expect(isTransactionPoolerUrl("postgres://u:p@db.example.com:5432/x?pgbouncer=true")).toBe(true);
    expect(isTransactionPoolerUrl(session)).toBe(false);
    expect(isTransactionPoolerUrl("postgres://u:p@localhost/x")).toBe(false);
    for (const url of [tx, session, "postgres://u:p@localhost/x", "not a url :6543/"]) {
      const o = postgresClientOptions(url);
      expect(o.prepare).toBe(false);
      expect(o.connect_timeout).toBeGreaterThan(0);
    }
  });

  it("drops the pgbouncer=true marker before connecting (postgres-js would send it to the server)", () => {
    expect(withoutPgbouncerParam("postgres://u:p@h.example.com:6543/db?pgbouncer=true&sslmode=require")).toBe(
      "postgres://u:p@h.example.com:6543/db?sslmode=require",
    );
    const plain = "postgresql://postgres.abc:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres";
    expect(withoutPgbouncerParam(plain)).toBe(plain);
  });
});
