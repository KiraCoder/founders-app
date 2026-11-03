/**
 * Settings → "Start reminder clock": pg_cron + pg_net call /api/cron/tick every 10 minutes,
 * URL and CRON_SECRET in Supabase Vault (never in the job's SQL text). Tested on PGlite:
 * plain (no extensions → clear "unavailable", nothing changed) and with stand-ins for
 * Supabase's cron / net / vault schemas (the real flow, idempotent).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { connectDb, type DbHandle } from "@/server/db/connect";
import {
  buildSchedule,
  buildTickJobCommand,
  buildVaultCreate,
  buildVaultUpdate,
  errMessage,
  reminderClockConfig,
  reminderClockStatus,
  REMINDER_JOB_NAME,
  startReminderClock,
  TICK_TIMEOUT_MS,
  VAULT_CRON_SECRET,
  VAULT_TICK_URL,
} from "@/server/notifications/reminder-clock";
import { getReminderClockStatus, startAppReminderClock } from "@/server/services/app-setup";
import { createTestDb, type TestDb } from "../helpers/db";

const SECRET = "test-cron-secret-0123456789abcdef";
const ENV = { APP_URL: "https://cockpit.example.com", CRON_SECRET: SECRET };
const dialect = new PgDialect();

describe("SQL builder", () => {
  it("the job reads URL and secret from Vault, waits 60 s, and contains neither value", () => {
    const cmd = buildTickJobCommand();
    expect(cmd).toContain("net.http_post(");
    expect(cmd).toContain(`vault.decrypted_secrets where name = '${VAULT_TICK_URL}'`);
    expect(cmd).toContain(`vault.decrypted_secrets where name = '${VAULT_CRON_SECRET}'`);
    expect(cmd).toContain("'Authorization', 'Bearer ' ||");
    expect(cmd).toContain(`timeout_milliseconds := ${TICK_TIMEOUT_MS}`);
    expect(TICK_TIMEOUT_MS).toBe(60000);
    expect(cmd).not.toContain(SECRET);
    expect(cmd).not.toContain("cockpit.example.com");
  });

  it("schedules 'founders-tick' every 10 minutes; Vault values are bind parameters, not SQL text", () => {
    const schedule = dialect.sqlToQuery(buildSchedule());
    expect(schedule.sql).toBe("select cron.schedule($1, $2, $3) as jobid");
    expect(schedule.params).toEqual([REMINDER_JOB_NAME, "*/10 * * * *", buildTickJobCommand()]);
    const create = dialect.sqlToQuery(buildVaultCreate(VAULT_CRON_SECRET, SECRET, "d"));
    expect(create.sql).not.toContain(SECRET);
    expect(create.params).toContain(SECRET);
    const update = dialect.sqlToQuery(buildVaultUpdate("00000000-0000-4000-8000-000000000000", SECRET));
    expect(update.sql).not.toContain(SECRET);
    expect(update.params).toContain(SECRET);
  });

  it("needs APP_URL (or Vercel's address) and CRON_SECRET", () => {
    expect(reminderClockConfig({}).missing).toEqual(["APP_URL", "CRON_SECRET"]);
    expect(reminderClockConfig({ VERCEL_PROJECT_PRODUCTION_URL: "founders.vercel.app", CRON_SECRET: "x" })).toEqual({
      missing: [],
      tickUrl: "https://founders.vercel.app/api/cron/tick",
      appUrlSource: "VERCEL_PROJECT_PRODUCTION_URL",
    });
  });

  it("an error shown on the page never carries the secret (drizzle appends params)", () => {
    const err = new Error(`Failed query: select vault.create_secret($1, $2, $3)\nparams: ${SECRET},founders_cron_secret,d`, {
      cause: new Error(`permission denied for function create_secret`),
    });
    expect(errMessage(err, [SECRET])).toBe("permission denied for function create_secret");
    expect(errMessage(new Error(`boom ${SECRET}\nparams: ${SECRET}`), [SECRET])).toBe("boom ***");
  });
});

describe("a database without pg_cron / pg_net / Vault (local PGlite)", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await connectDb("memory://");
  });
  afterAll(async () => {
    await h.close();
  });

  it("says what is missing and where to look, and changes nothing", async () => {
    const r = await startReminderClock(h.db, ENV);
    expect(r).toMatchObject({ ok: false, step: "unavailable" });
    expect(r.message).toContain("pg_cron, pg_net, Vault");
    expect(r.message).toContain("cron-job.org");
    const schemas = await h.db.execute(sql`select nspname from pg_namespace where nspname in ('cron', 'net', 'vault')`);
    expect((schemas as unknown as { rows: unknown[] }).rows).toHaveLength(0);
    const status = await reminderClockStatus(h.db, ENV);
    expect(status).toMatchObject({ ok: false, step: "unavailable", status: { jobExists: false } });
  });

  it("missing env: names the variables and touches nothing", async () => {
    const r = await startReminderClock(h.db, {});
    expect(r).toMatchObject({ ok: false, step: "config" });
    expect(r.message).toContain("APP_URL, CRON_SECRET");
  });
});

/** Minimal stand-ins for Supabase's pg_cron, pg_net and Vault (same names and signatures used). */
const SUPABASE_STANDINS = `
  create schema vault;
  create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text not null, description text);
  create function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid
    language sql as $$ insert into vault.secrets (name, secret, description) values (new_name, new_secret, new_description) returning id $$;
  create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null) returns void
    language sql as $$ update vault.secrets set secret = coalesce(new_secret, secret) where id = secret_id $$;
  create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;

  create schema cron;
  create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean default true);
  create table cron.job_run_details (jobid bigint, status text, return_message text, start_time timestamptz);
  create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
    insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
    on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
    returning jobid $$;

  create schema net;
  create table net.requests (id bigserial primary key, url text, headers jsonb, body jsonb, timeout_milliseconds int);
  create table net._http_response (id bigint, status_code int, error_msg text, created timestamptz default now());
  create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000) returns bigint
    language sql as $$ insert into net.requests (url, headers, body, timeout_milliseconds) values (url, headers, body, timeout_milliseconds) returning id $$;
`;

describe("on Supabase (stand-ins for pg_cron / pg_net / Vault)", () => {
  let t: TestDb;
  const rows = async <T>(q: ReturnType<typeof sql>) => (await t.handle.db.execute(q)) as unknown as { rows: T[] };

  beforeAll(async () => {
    t = await createTestDb();
    await (t.handle.db as unknown as { $client: { exec: (q: string) => Promise<unknown> } }).$client.exec(SUPABASE_STANDINS);
  });
  afterAll(async () => {
    await t.handle.close();
  });

  it("stores URL + secret in Vault, schedules the job, and the job posts with the Bearer secret", async () => {
    const r = await startReminderClock(t.handle.db, ENV);
    expect(r).toMatchObject({ ok: true, status: { available: true, jobExists: true, schedule: "*/10 * * * *", active: true, runs: [] } });
    const secrets = await rows<{ name: string; secret: string }>(sql`select name, secret from vault.secrets order by name`);
    expect(secrets.rows).toEqual([
      { name: VAULT_CRON_SECRET, secret: SECRET },
      { name: VAULT_TICK_URL, secret: "https://cockpit.example.com/api/cron/tick" },
    ]);
    const jobs = await rows<{ jobname: string; command: string }>(sql`select jobname, command from cron.job`);
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]!.command).not.toContain(SECRET);
    expect(jobs.rows[0]!.command).not.toContain("cockpit.example.com");

    // What pg_cron would run every 10 minutes.
    await t.handle.db.execute(sql.raw(jobs.rows[0]!.command));
    const req = await rows<{ url: string; headers: Record<string, string>; timeout_milliseconds: number }>(sql`select url, headers, timeout_milliseconds from net.requests`);
    expect(req.rows).toEqual([
      {
        url: "https://cockpit.example.com/api/cron/tick",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
        timeout_milliseconds: 60000,
      },
    ]);
    // The result shown in the browser carries neither the secret.
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("pressing it again (new secret, new URL) updates Vault and keeps ONE job", async () => {
    const r = await startReminderClock(t.handle.db, { APP_URL: "https://new.example.com", CRON_SECRET: "rotated-secret-abcdef" });
    expect(r.ok).toBe(true);
    const secrets = await rows<{ name: string; secret: string }>(sql`select name, secret from vault.secrets order by name`);
    expect(secrets.rows).toEqual([
      { name: VAULT_CRON_SECRET, secret: "rotated-secret-abcdef" },
      { name: VAULT_TICK_URL, secret: "https://new.example.com/api/cron/tick" },
    ]);
    expect((await rows(sql`select 1 from cron.job`)).rows).toHaveLength(1);
  });

  it("status shows the job and the last 5 runs and HTTP answers, newest first", async () => {
    const [job] = (await rows<{ jobid: string }>(sql`select jobid from cron.job`)).rows;
    for (let i = 1; i <= 7; i++) {
      await t.handle.db.execute(
        sql`insert into cron.job_run_details (jobid, status, return_message, start_time) values (${job!.jobid}, ${i === 7 ? "failed" : "succeeded"}, ${i === 7 ? "boom" : "1 row"}, ${new Date(Date.UTC(2026, 10, 2, 6, i * 10)).toISOString()})`,
      );
      await t.handle.db.execute(sql`insert into net._http_response (id, status_code, created) values (${i}, ${i === 7 ? 401 : 200}, ${new Date(Date.UTC(2026, 10, 2, 6, i * 10, 5)).toISOString()})`);
    }
    const r = await reminderClockStatus(t.handle.db, ENV);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status.runs).toHaveLength(5);
    expect(r.status.runs[0]).toEqual({ status: "failed", message: "boom", startedAt: "2026-11-02T07:10:00.000Z" });
    expect(r.status.responses.map((x) => x.statusCode)).toEqual([401, 200, 200, 200, 200]);
  });

  it("founders only", async () => {
    const staff = { ...t.ctx("talant"), user: { ...t.founders.talant, role: "staff" as const } };
    await expect(startAppReminderClock(staff)).rejects.toMatchObject({ code: "forbidden" });
    await expect(getReminderClockStatus(staff)).rejects.toMatchObject({ code: "forbidden" });
  });
});
