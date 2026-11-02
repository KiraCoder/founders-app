import { afterAll, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { MIGRATIONS_FOLDER } from "@/server/db/migrate";
import * as schema from "@/server/db/schema";

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of cleanups) await c();
});

/** A copy of ./drizzle whose journal stops before the migration with tag `stopBefore`. */
function migrationsUpTo(stopBefore: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "founders-migrations-"));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  const idx = journal.entries.findIndex((e) => e.tag.startsWith(stopBefore));
  expect(idx).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, idx);
  writeFileSync(journalPath, JSON.stringify(journal));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function newPglite() {
  const client = new PGlite();
  await client.waitReady;
  cleanups.push(() => client.close());
  return { client, db: drizzle(client, { schema }) };
}

const NURAALY = "11111111-1111-4111-8111-111111111111";
const TALANT = "22222222-2222-4222-8222-222222222222";

describe("0003 task_events visibility backfill on existing data", () => {
  it("copies visibility/owner from live tasks and keeps deleted-task snapshots private", async () => {
    const { client, db } = await newPglite();
    await migrate(db, { migrationsFolder: migrationsUpTo("0003") });

    // Data as it looked before 0003 (no visibility/owner on task_events).
    await client.exec(`
      insert into users (id, email, name, short_name) values
        ('${NURAALY}', 'n@x', 'Nuraaly', 'Nuraaly'), ('${TALANT}', 't@x', 'Talant', 'Talant');
      insert into companies (id, slug, name) values ('33333333-3333-4333-8333-333333333333', 'kiwi', 'Kiwi');
      insert into tasks (id, title, owner_user_id, visibility, company_id) values
        ('44444444-4444-4444-8444-444444444444', 'Private live', '${NURAALY}', 'private', null),
        ('55555555-5555-4555-8555-555555555555', 'Shared live', '${TALANT}', 'shared', '33333333-3333-4333-8333-333333333333');
      insert into task_events (id, task_id, actor_user_id, kind, old_value, new_value) values
        ('a0000000-0000-4000-8000-000000000001', '44444444-4444-4444-8444-444444444444', '${NURAALY}', 'created', null, '{"title":"Private live"}'),
        ('a0000000-0000-4000-8000-000000000002', '55555555-5555-4555-8555-555555555555', '${NURAALY}', 'updated', '"a"', '"b"'),
        ('a0000000-0000-4000-8000-000000000003', null, '${NURAALY}', 'deleted',
           '{"title":"Gone private","visibility":"private","ownerUserId":"${NURAALY}"}', null),
        ('a0000000-0000-4000-8000-000000000004', null, '${TALANT}', 'deleted',
           '{"title":"Gone shared","visibility":"shared","ownerUserId":"${TALANT}"}', null),
        ('a0000000-0000-4000-8000-000000000005', null, '${NURAALY}', 'created', null, '{"title":"Gone private"}');
    `);

    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    const res = await client.query<{ id: string; visibility: string; owner_user_id: string | null }>(
      "select id, visibility, owner_user_id from task_events order by id",
    );
    expect(res.rows.map((r) => [r.id.slice(-1), r.visibility, r.owner_user_id])).toEqual([
      ["1", "private", NURAALY],
      ["2", "shared", TALANT],
      ["3", "private", NURAALY],
      ["4", "shared", TALANT],
      ["5", "private", NURAALY],
    ]);
    const count = await client.query<{ n: number }>("select count(*)::int as n from task_events");
    expect(count.rows[0]!.n).toBe(5); // no data lost
  });
});

describe("0005 notifications hardening on existing data", () => {
  it("repairs malformed preferences before adding the checks and keeps outbox rows", async () => {
    const { client, db } = await newPglite();
    await migrate(db, { migrationsFolder: migrationsUpTo("0005") });
    await client.exec(`
      insert into users (id, email, name, short_name) values
        ('${NURAALY}', 'n@x', 'Nuraaly', 'Nuraaly'), ('${TALANT}', 't@x', 'Talant', 'Talant');
      insert into notification_preferences (user_id, quiet_start, max_other_per_day) values
        ('${NURAALY}', '9pm', 99), ('${TALANT}', '22:00', 2);
      insert into notifications_outbox (user_id, kind, dedupe_key, status) values
        ('${NURAALY}', 'morning_summary', 'morning:2026-11-01', 'sent'),
        ('${TALANT}', 'overdue_chase', 'chase:x:2026-11-01', 'parked');
    `);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const prefs = await client.query<{ quiet_start: string; max_other_per_day: number }>(
      "select quiet_start, max_other_per_day from notification_preferences order by user_id",
    );
    expect(prefs.rows).toEqual([
      { quiet_start: "21:00", max_other_per_day: 10 },
      { quiet_start: "22:00", max_other_per_day: 2 },
    ]);
    const outbox = await client.query<{ status: string; claimed_at: Date | null }>(
      "select status, claimed_at from notifications_outbox order by dedupe_key",
    );
    expect(outbox.rows).toEqual([
      { status: "parked", claimed_at: null },
      { status: "sent", claimed_at: null },
    ]);
  });
});

describe("0006 people + salaries on existing data", () => {
  it("keeps people and links (active, staff) and makes Nuraaly the only salary viewer", async () => {
    const { client, db } = await newPglite();
    await migrate(db, { migrationsFolder: migrationsUpTo("0006") });
    await client.exec(`
      insert into users (id, email, name, short_name) values
        ('${NURAALY}', 'nuraaly@founders.local', 'Nuraaly', 'Nuraaly'), ('${TALANT}', 'talant@founders.local', 'Talant', 'Talant');
      insert into companies (id, slug, name) values ('33333333-3333-4333-8333-333333333333', 'kiwi-go', 'Kiwi Go');
      insert into people (id, full_name) values ('55555555-5555-4555-8555-555555555555', 'Elmurat');
      insert into person_companies (person_id, company_id, role) values
        ('55555555-5555-4555-8555-555555555555', '33333333-3333-4333-8333-333333333333', 'accountant');
    `);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const links = await client.query<{ role: string; is_active: boolean; employment_type: string }>(
      "select role, is_active, employment_type from person_companies",
    );
    expect(links.rows).toEqual([{ role: "accountant", is_active: true, employment_type: "staff" }]);
    const ppl = await client.query<{ full_name: string; left_at: Date | null }>("select full_name, left_at from people");
    expect(ppl.rows).toEqual([{ full_name: "Elmurat", left_at: null }]);
    const viewers = await client.query<{ user_id: string }>("select user_id from salary_viewers");
    expect(viewers.rows).toEqual([{ user_id: NURAALY }]);
  });
});

describe("supabase/policies.sql (applied to a Supabase-like database)", () => {
  it("enforces the app rules for a signed-in client", async () => {
    const { client, db } = await newPglite();
    // Supabase-like roles and an auth.uid() stub reading the JWT subject.
    await client.exec(`
      create role anon nologin;
      create role authenticated nologin;
      grant usage on schema public to anon, authenticated;
      alter default privileges in schema public grant all on tables to anon, authenticated;
      create schema auth;
      grant usage on schema auth to anon, authenticated;
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    `);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await client.exec(readFileSync(path.join(process.cwd(), "supabase", "policies.sql"), "utf8"));

    const COMPANY = "33333333-3333-4333-8333-333333333333";
    const N_PRIVATE = "44444444-4444-4444-8444-444444444444";
    const N_SHARED = "66666666-6666-4666-8666-666666666666";
    const AUTH_T = "99999999-9999-4999-8999-999999999999";
    await client.exec(`
      insert into users (id, email, name, short_name, password_hash, external_auth_id) values
        ('${NURAALY}', 'n@x', 'Nuraaly', 'Nuraaly', 'hash-n', '88888888-8888-4888-8888-888888888888'),
        ('${TALANT}', 't@x', 'Talant', 'Talant', 'hash-t', '${AUTH_T}');
      insert into companies (id, slug, name) values ('${COMPANY}', 'kiwi', 'Kiwi');
      insert into tasks (id, title, owner_user_id, visibility, company_id) values
        ('${N_PRIVATE}', 'N private', '${NURAALY}', 'private', null),
        ('${N_SHARED}', 'N shared', '${NURAALY}', 'shared', '${COMPANY}');
      insert into task_events (task_id, actor_user_id, kind, visibility, owner_user_id, new_value) values
        ('${N_PRIVATE}', '${NURAALY}', 'created', 'private', '${NURAALY}', '{"title":"N private"}'),
        ('${N_SHARED}', '${NURAALY}', 'created', 'shared', '${NURAALY}', '{"title":"N shared"}');
    `);

    /** Runs `stmt` as Talant through the client role; returns the rows or the error message. */
    async function asTalant(stmt: string): Promise<{ rows?: unknown[]; error?: string }> {
      try {
        return await client.transaction(async (tx) => {
          await tx.query(`select set_config('request.jwt.claim.sub', '${AUTH_T}', true)`);
          await tx.query("set local role authenticated");
          const r = await tx.query(stmt);
          return { rows: r.rows };
        });
      } catch (e) {
        return { error: (e as Error).message };
      }
    }

    // password_hash is not selectable; other user columns are.
    expect((await asTalant("select password_hash from users")).error).toMatch(/permission denied/);
    expect((await asTalant("select * from users")).error).toMatch(/permission denied/);
    expect((await asTalant("select id, short_name from users")).rows).toHaveLength(2);
    // Server-only tables are closed.
    expect((await asTalant("select * from sessions")).error).toMatch(/permission denied/);
    expect((await asTalant("select * from telegram_link_codes")).error).toMatch(/permission denied/);

    // Private tasks of the other founder are invisible; shared ones are visible.
    expect((await asTalant("select title from tasks")).rows).toEqual([{ title: "N shared" }]);
    expect((await asTalant("select new_value from task_events")).rows).toEqual([
      { new_value: { title: "N shared" } },
    ]);

    // No owner hijack, no making someone else's task private.
    expect((await asTalant(`update tasks set owner_user_id = '${TALANT}' where id = '${N_SHARED}'`)).error).toMatch(
      /owner of a task cannot be changed/,
    );
    expect((await asTalant(`update tasks set visibility = 'private' where id = '${N_SHARED}'`)).error).toMatch(
      /Only the task's creator/,
    );
    // Updating a field that is allowed works.
    expect((await asTalant(`update tasks set title = 'renamed' where id = '${N_SHARED}' returning id`)).rows).toHaveLength(1);
    // The private task cannot even be touched.
    expect((await asTalant(`update tasks set title = 'x' where id = '${N_PRIVATE}' returning id`)).rows).toEqual([]);

    // Shape rules on insert: shared needs a company; private cannot be assigned to others.
    expect(
      (await asTalant(`insert into tasks (title, owner_user_id, visibility) values ('x', '${TALANT}', 'shared')`)).error,
    ).toMatch(/row-level security/);
    expect(
      (
        await asTalant(
          `insert into tasks (title, owner_user_id, visibility, assignee_user_id) values ('x', '${TALANT}', 'private', '${NURAALY}')`,
        )
      ).error,
    ).toMatch(/row-level security/);
    expect(
      (await asTalant(`insert into tasks (title, owner_user_id, visibility) values ('mine', '${TALANT}', 'private') returning id`))
        .rows,
    ).toHaveLength(1);
    // Cannot create a task as someone else.
    expect(
      (await asTalant(`insert into tasks (title, owner_user_id, visibility) values ('x', '${NURAALY}', 'private')`)).error,
    ).toMatch(/row-level security/);

    // task_events: only for visible tasks, only as yourself, append-only.
    expect(
      (
        await asTalant(
          `insert into task_events (task_id, actor_user_id, kind, visibility, owner_user_id) values ('${N_PRIVATE}', '${TALANT}', 'updated', 'private', '${NURAALY}')`,
        )
      ).error,
    ).toMatch(/row-level security/);
    expect(
      (
        await asTalant(
          `insert into task_events (task_id, actor_user_id, kind, visibility, owner_user_id) values ('${N_SHARED}', '${TALANT}', 'updated', 'shared', '${NURAALY}') returning id`,
        )
      ).rows,
    ).toHaveLength(1);
    expect((await asTalant("delete from task_events")).error).toMatch(/permission denied/);

    // notification_preferences: own row readable, but writes only through the app (Zod).
    await client.exec(`
      insert into notification_preferences (user_id) values ('${NURAALY}'), ('${TALANT}');
    `);
    expect((await asTalant("select user_id from notification_preferences")).rows).toEqual([{ user_id: TALANT }]);
    expect((await asTalant(`update notification_preferences set evening_check_time = '22:00'`)).error).toMatch(/permission denied/);
    expect((await asTalant(`insert into notification_preferences (user_id) values ('${TALANT}')`)).error).toMatch(/permission denied/);
    // And the database itself refuses malformed values (migration 0005), even for the server.
    await expect(client.exec(`update notification_preferences set quiet_start = '25:00'`)).rejects.toThrow(/check constraint/);

    // anon gets nothing at all.
    const anon = await client
      .transaction(async (tx) => {
        await tx.query("set local role anon");
        await tx.query("select id from tasks");
      })
      .then(
        () => "ok",
        (e: Error) => e.message,
      );
    expect(anon).toMatch(/permission denied/);
  });
});
