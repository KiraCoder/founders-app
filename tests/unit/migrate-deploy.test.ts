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

  it("skips (with the reason) on a Vercel preview / development build, runs on production (deploy review #1)", () => {
    const base = { MIGRATE_ON_BUILD: "1", DATABASE_URL: "postgresql://x@db.example.com/p" };
    for (const VERCEL_ENV of ["preview", "development", "something-else"]) {
      const d = migrateOnBuildDecision({ ...base, VERCEL_ENV });
      expect(d.run).toBe(false);
      expect(d.message).toContain(`VERCEL_ENV=${VERCEL_ENV}`);
      expect(d.message).toContain("skipped");
    }
    expect(migrateOnBuildDecision({ ...base, VERCEL_ENV: "production" }).run).toBe(true);
    expect(migrateOnBuildDecision({ ...base, VERCEL_ENV: "" }).run).toBe(true); // local build: flags decide
    // A preview never throws for a missing DATABASE_URL either: it just skips.
    expect(migrateOnBuildDecision({ MIGRATE_ON_BUILD: "1", VERCEL_ENV: "preview" }).run).toBe(false);
  });

  it("the npm script prints the preview skip and touches nothing", () => {
    const out = execFileSync("npx", ["tsx", "scripts/db-migrate-deploy.ts"], {
      env: { ...process.env, MIGRATE_ON_BUILD: "1", VERCEL_ENV: "preview", DATABASE_URL: "postgresql://nobody@127.0.0.1:1/none" },
      encoding: "utf8",
    });
    expect(out).toContain("VERCEL_ENV=preview");
  }, 30_000);

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

describe("Supabase Transaction pooler is moved to the Session pooler", () => {
  it("rewrites only *.pooler.supabase.com:6543", async () => {
    const { toSessionPooler, describeDatabaseUrl } = await import("@/server/db/connect");
    expect(toSessionPooler("postgresql://postgres.abc:p%40ss@aws-0-eu-central-1.pooler.supabase.com:6543/postgres")).toBe(
      "postgresql://postgres.abc:p%40ss@aws-0-eu-central-1.pooler.supabase.com:5432/postgres",
    );
    const keep = ["postgresql://u:p@aws-0-eu-central-1.pooler.supabase.com:5432/postgres", "postgres://u:p@db.x.supabase.co:5432/postgres", "postgres://u:p@localhost:6543/x", "not a url"];
    for (const url of keep) expect(toSessionPooler(url)).toBe(url);
    expect(describeDatabaseUrl("postgresql://u:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres")).toEqual({ host: "supabase-pooler", port: "5432" });
    expect(JSON.stringify(describeDatabaseUrl("postgresql://u:secret@h.example.com/x"))).not.toContain("secret");
  });
});
