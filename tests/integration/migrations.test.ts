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
  it("keeps people and links (active, staff) and makes Nuraaly the only salary viewer (until 0016)", async () => {
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
    await migrate(db, { migrationsFolder: migrationsUpTo("0016") });
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

describe("0007 metrics on existing data", () => {
  it("adds the metric tables with RLS on a populated database; one current value per period is enforced", async () => {
    const { client, db } = await newPglite();
    await migrate(db, { migrationsFolder: migrationsUpTo("0007") });
    await client.exec(`
      insert into users (id, email, name, short_name) values ('${NURAALY}', 'nuraaly@founders.local', 'Nuraaly', 'Nuraaly');
      insert into companies (id, slug, name) values ('33333333-3333-4333-8333-333333333333', 'kiwi-go', 'Kiwi Go');
    `);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const rls = await client.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class where relname in ('metric_definitions','metric_values','connector_runs') order by relname",
    );
    expect(rls.rows).toEqual([
      { relname: "connector_runs", relrowsecurity: true },
      { relname: "metric_definitions", relrowsecurity: true },
      { relname: "metric_values", relrowsecurity: true },
    ]);
    await client.exec(`
      insert into metric_definitions (id, company_id, key, name, unit, granularity)
        values ('66666666-6666-4666-8666-666666666666', '33333333-3333-4333-8333-333333333333', 'orders_day', 'Orders per day', 'orders', 'day');
      insert into metric_values (metric_id, period_start, value, source) values ('66666666-6666-4666-8666-666666666666', '2026-11-01', 5, 'manual');
      insert into metric_values (metric_id, period_start, value, source, is_current) values ('66666666-6666-4666-8666-666666666666', '2026-11-01', 4, 'manual', false);
    `);
    await expect(
      client.exec(`insert into metric_values (metric_id, period_start, value, source) values ('66666666-6666-4666-8666-666666666666', '2026-11-01', 6, 'manual')`),
    ).rejects.toThrow(/metric_values_current_uq/);
    // Same key twice for the whole company (unit null) is refused too (NULLS NOT DISTINCT).
    await expect(
      client.exec(`insert into metric_definitions (company_id, key, name, unit, granularity) values ('33333333-3333-4333-8333-333333333333', 'orders_day', 'Dup', 'orders', 'day')`),
    ).rejects.toThrow(/metric_definitions_company_unit_key_uq/);
    // Values cannot be lost by deleting the metric (restrict).
    await expect(client.exec(`delete from metric_definitions`)).rejects.toThrow(/foreign key/);
  });
});

describe("0008 people fixes on existing data", () => {
  it("ends links that already had an end date, flags links ended by leaving, numbers salary rows", async () => {
    const { client, db } = await newPglite();
    await migrate(db, { migrationsFolder: migrationsUpTo("0008") });
    const C = "33333333-3333-4333-8333-333333333333";
    const P1 = "55555555-5555-4555-8555-555555555555";
    const P2 = "66666666-6666-4666-8666-666666666666";
    await client.exec(`
      insert into users (id, email, name, short_name) values ('${NURAALY}', 'nuraaly@founders.local', 'Nuraaly', 'Nuraaly');
      insert into companies (id, slug, name) values ('${C}', 'kiwi-go', 'Kiwi Go');
      insert into people (id, full_name) values ('${P1}', 'Ended Earlier');
      insert into people (id, full_name, left_at) values ('${P2}', 'Left Person', '2026-10-14T18:00:00Z');
      insert into person_companies (id, person_id, company_id, role, ended_on, is_active) values
        ('a1000000-0000-4000-8000-000000000001', '${P1}', '${C}', 'past', '2020-01-31', true),
        ('a1000000-0000-4000-8000-000000000002', '${P1}', '${C}', 'future', '2999-01-01', true),
        ('a1000000-0000-4000-8000-000000000003', '${P1}', '${C}', 'open', null, true),
        ('a1000000-0000-4000-8000-000000000004', '${P2}', '${C}', 'left-with-person', '2026-10-15', false),
        ('a1000000-0000-4000-8000-000000000005', '${P2}', '${C}', 'ended-by-hand', '2026-09-01', false);
      insert into salaries (person_company_id, amount, effective_from, created_at) values
        ('a1000000-0000-4000-8000-000000000003', 200, '2026-01-01', '2026-01-02T00:00:00Z'),
        ('a1000000-0000-4000-8000-000000000003', 100, '2026-01-01', '2026-01-01T00:00:00Z');
    `);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const links = await client.query<{ role: string; is_active: boolean; ended_by_leave: boolean }>(
      "select role, is_active, ended_by_leave from person_companies order by id",
    );
    expect(links.rows).toEqual([
      { role: "past", is_active: false, ended_by_leave: false },
      { role: "future", is_active: true, ended_by_leave: false },
      { role: "open", is_active: true, ended_by_leave: false },
      { role: "left-with-person", is_active: false, ended_by_leave: true },
      { role: "ended-by-hand", is_active: false, ended_by_leave: false },
    ]);
    const sal = await client.query<{ amount: string; seq: number }>("select amount, seq::int as seq from salaries order by seq");
    expect(sal.rows).toEqual([
      { amount: "100.00", seq: 1 },
      { amount: "200.00", seq: 2 },
    ]);
    // New rows continue after the backfilled numbers.
    await client.exec(`insert into salaries (person_company_id, amount, effective_from) values ('a1000000-0000-4000-8000-000000000003', 300, '2026-02-01')`);
    const last = await client.query<{ seq: number }>("select seq::int as seq from salaries where amount = 300");
    expect(last.rows[0]!.seq).toBe(3);
  });
});

describe("0009 metrics fixes on existing data", () => {
  it("sets the aggregation per unit, drops dangling run ids, adds the run FK and the 'running' status", async () => {
    const { client, db } = await newPglite();
    await migrate(db, { migrationsFolder: migrationsUpTo("0009") });
    const C = "33333333-3333-4333-8333-333333333333";
    await client.exec(`
      insert into companies (id, slug, name) values ('${C}', 'kiwi-go', 'Kiwi Go');
      insert into metric_definitions (id, company_id, key, name, unit, granularity) values
        ('a0000000-0000-4000-8000-000000000001', '${C}', 'orders_day', 'Orders', 'orders', 'day'),
        ('a0000000-0000-4000-8000-000000000002', '${C}', 'on_time_pct', 'On time', '%', 'day'),
        ('a0000000-0000-4000-8000-000000000003', '${C}', 'couriers_active', 'Couriers', 'people', 'day'),
        ('a0000000-0000-4000-8000-000000000004', '${C}', 'intercompany_debt', 'Debt', 'KGS', 'month');
      insert into connector_runs (id, connector_id, company_id, status, range_from, range_to)
        values ('b0000000-0000-4000-8000-000000000001', 'kiwigo-app', '${C}', 'ok', '2026-10-01', '2026-10-31');
      insert into metric_values (metric_id, period_start, value, source, connector_run_id) values
        ('a0000000-0000-4000-8000-000000000001', '2026-10-30', 5, 'connector', 'b0000000-0000-4000-8000-000000000001'),
        ('a0000000-0000-4000-8000-000000000001', '2026-10-31', 6, 'connector', 'c0000000-0000-4000-8000-00000000dead');
    `);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const agg = await client.query<{ key: string; aggregation: string }>("select key, aggregation from metric_definitions order by id");
    expect(agg.rows).toEqual([
      { key: "orders_day", aggregation: "sum" },
      { key: "on_time_pct", aggregation: "avg" },
      { key: "couriers_active", aggregation: "last" },
      { key: "intercompany_debt", aggregation: "last" },
    ]);
    const runs = await client.query<{ period_start: string; connector_run_id: string | null }>(
      "select period_start::text, connector_run_id from metric_values order by period_start",
    );
    expect(runs.rows).toEqual([
      { period_start: "2026-10-30", connector_run_id: "b0000000-0000-4000-8000-000000000001" },
      { period_start: "2026-10-31", connector_run_id: null },
    ]);
    await expect(
      client.exec(
        `insert into metric_values (metric_id, period_start, value, source, connector_run_id) values ('a0000000-0000-4000-8000-000000000001', '2026-10-29', 1, 'connector', 'c0000000-0000-4000-8000-00000000beef')`,
      ),
    ).rejects.toThrow(/foreign key/);
    await client.exec(
      `insert into connector_runs (connector_id, company_id, status, range_from, range_to, details) values ('kiwigo-app', '${C}', 'running', '2026-10-01', '2026-10-31', '{"conflicts":[]}')`,
    );
    // Deleting a run keeps the values (the link is cleared).
    await client.exec(`delete from connector_runs where id = 'b0000000-0000-4000-8000-000000000001'`);
    expect((await client.query("select 1 from metric_values")).rows).toHaveLength(2);
  });
});

describe("0010 holding on existing data", () => {
  it("adds the holding tables with RLS, keeps task buttons, allows holding buttons and derived values", async () => {
    const { client, db } = await newPglite();
    await migrate(db, { migrationsFolder: migrationsUpTo("0010") });
    const C1 = "33333333-3333-4333-8333-333333333331";
    const C2 = "33333333-3333-4333-8333-333333333332";
    const TASK = "44444444-4444-4444-8444-444444444444";
    await client.exec(`
      insert into users (id, email, name, short_name) values ('${NURAALY}', 'n@x', 'Nuraaly', 'Nuraaly');
      insert into companies (id, slug, name) values ('${C1}', 'alura-style', 'Alura Style'), ('${C2}', 'alura-brand', 'Alura Brand');
      insert into tasks (id, title, owner_user_id, company_id) values ('${TASK}', 'T', '${NURAALY}', '${C1}');
      insert into notification_action_tokens (token_hash, user_id, task_id, action, expires_at)
        values ('h1', '${NURAALY}', '${TASK}', 'done', now() + interval '1 day');
      insert into metric_definitions (id, company_id, key, name, unit, granularity) values
        ('a0000000-0000-4000-8000-000000000004', '${C1}', 'intercompany_debt', 'Debt', 'KGS', 'month');
      insert into metric_values (metric_id, period_start, value, source) values ('a0000000-0000-4000-8000-000000000004', '2026-09-01', 5, 'manual');
    `);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    const tokens = await client.query<{ task_id: string; holding_ask_id: string | null }>("select task_id, holding_ask_id from notification_action_tokens");
    expect(tokens.rows).toEqual([{ task_id: TASK, holding_ask_id: null }]);
    expect((await client.query("select 1 from metric_values")).rows).toHaveLength(1);
    const rls = await client.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relname in ('holding_files','intercompany_flows','intercompany_contracts','intercompany_acts','intercompany_ledger_entries','holding_ask_items') order by relname`,
    );
    expect(rls.rows).toHaveLength(6);
    expect(rls.rows.every((r) => r.relrowsecurity)).toBe(true);

    // New rows work; the rules hold.
    await client.exec(`
      insert into metric_values (metric_id, period_start, value, source) values ('a0000000-0000-4000-8000-000000000004', '2026-10-01', 7, 'derived');
      insert into intercompany_flows (id, from_company_id, to_company_id, service, since) values
        ('55555555-5555-4555-8555-555555555555', '${C1}', '${C2}', 'пошив', '2026-01-01');
      insert into intercompany_acts (flow_id, period, status) values ('55555555-5555-4555-8555-555555555555', '2026-10-01', 'requested');
      insert into holding_ask_items (id, user_id, kind, round_key, cells) values
        ('66666666-6666-4666-8666-666666666666', '${NURAALY}', 'ask', '2026-11', '[]');
      insert into notification_action_tokens (token_hash, user_id, holding_ask_id, action, expires_at)
        values ('h2', '${NURAALY}', '66666666-6666-4666-8666-666666666666', 'holding_asked', now() + interval '1 day');
    `);
    await expect(
      client.exec(`insert into notification_action_tokens (token_hash, user_id, action, expires_at) values ('h3', '${NURAALY}', 'done', now())`),
    ).rejects.toThrow(/notification_action_tokens_subject/);
    await expect(
      client.exec(`insert into intercompany_flows (from_company_id, to_company_id, service) values ('${C1}', '${C2}', 'ПОШИВ')`),
    ).rejects.toThrow(/intercompany_flows_live_uq/);
    await expect(
      client.exec(`insert into intercompany_flows (from_company_id, to_company_id, service) values ('${C1}', '${C1}', 'x')`),
    ).rejects.toThrow(/intercompany_flows_two_companies/);
    await expect(
      client.exec(`insert into intercompany_acts (flow_id, period) values ('55555555-5555-4555-8555-555555555555', '2026-10-15')`),
    ).rejects.toThrow(/intercompany_acts_period_first/);
    await expect(
      client.exec(`insert into intercompany_acts (flow_id, period) values ('55555555-5555-4555-8555-555555555555', '2026-10-01')`),
    ).rejects.toThrow(/intercompany_acts_flow_period_uq/);
    await expect(
      client.exec(`insert into holding_files (storage, storage_key, original_name, content_type, size_bytes, sha256) values ('local', 'k', 'a.html', 'text/html', 5, 'x')`),
    ).rejects.toThrow(/holding_files_type/);
    // Flows with акты cannot be deleted (archive instead).
    await expect(client.exec(`delete from intercompany_flows where id = '55555555-5555-4555-8555-555555555555'`)).rejects.toThrow(/foreign key/);
  });
});

describe("0011 holding fixes on existing data", () => {
  it("adds attached_at and marks files already attached to an акт or a contract (they are never cleaned up)", async () => {
    const { client, db } = await newPglite();
    await migrate(db, { migrationsFolder: migrationsUpTo("0011") });
    const C1 = "33333333-3333-4333-8333-333333333331";
    const C2 = "33333333-3333-4333-8333-333333333332";
    const F = "55555555-5555-4555-8555-555555555555";
    const file = (n: number) => `7777777${n}-7777-4777-8777-777777777777`;
    await client.exec(`
      insert into companies (id, slug, name) values ('${C1}', 'a', 'A'), ('${C2}', 'b', 'B');
      insert into intercompany_flows (id, from_company_id, to_company_id, service) values ('${F}', '${C1}', '${C2}', 's');
      insert into holding_files (id, storage, storage_key, original_name, content_type, size_bytes, sha256) values
        ('${file(1)}', 'local', 'holding/1.pdf', 'a.pdf', 'application/pdf', 5, 'x'),
        ('${file(2)}', 'local', 'holding/2.pdf', 'b.pdf', 'application/pdf', 5, 'x'),
        ('${file(3)}', 'local', 'holding/3.pdf', 'c.pdf', 'application/pdf', 5, 'x');
      insert into intercompany_acts (flow_id, period, attachment_file_id) values ('${F}', '2026-10-01', '${file(1)}');
      insert into intercompany_contracts (flow_id, number, attachment_file_id) values ('${F}', '1', '${file(2)}');
    `);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const rows = await client.query<{ id: string; attached: boolean }>("select id, attached_at is not null as attached from holding_files order by id");
    expect(rows.rows).toEqual([
      { id: file(1), attached: true },
      { id: file(2), attached: true },
      { id: file(3), attached: false },
    ]);
  });
});

describe("0012 AI roles on existing data", () => {
  it("adds the four AI role tables with RLS, keeps outbox rows, enforces one run per hire and month", async () => {
    const { client, db } = await newPglite();
    await migrate(db, { migrationsFolder: migrationsUpTo("0012") });
    const C1 = "33333333-3333-4333-8333-333333333331";
    await client.exec(`
      insert into users (id, email, name, short_name, role) values ('${NURAALY}', 'n@x', 'N', 'N', 'founder');
      insert into companies (id, slug, name) values ('${C1}', 'kiwi-go', 'Kiwi Go');
      insert into notifications_outbox (user_id, kind, dedupe_key) values ('${NURAALY}', 'morning_summary', 'morning:2026-11-02');
    `);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const rls = await client.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relname in ('ai_role_templates','ai_role_hires','ai_role_runs','ai_data_requests') order by relname`,
    );
    expect(rls.rows).toEqual([
      { relname: "ai_data_requests", relrowsecurity: true },
      { relname: "ai_role_hires", relrowsecurity: true },
      { relname: "ai_role_runs", relrowsecurity: true },
      { relname: "ai_role_templates", relrowsecurity: true },
    ]);
    expect((await client.query("select 1 from notifications_outbox")).rows).toHaveLength(1);
    await client.exec(`
      insert into ai_role_templates (key, name, description, status, required_data, default_schedule) values
        ('financial-analyst', 'Financial Analyst', 'd', 'available', '{"byCompanyType":{},"optionalUploads":[]}', '{"kind":"monthly","day":10}');
      insert into ai_role_hires (id, template_key, company_id, settings, hired_on) values
        ('66666666-6666-4666-8666-666666666666', 'financial-analyst', '${C1}', '{}', '2026-11-02');
      insert into ai_role_runs (hire_id, period) values ('66666666-6666-4666-8666-666666666666', '2026-10-01');
    `);
    await expect(client.exec(`insert into ai_role_runs (hire_id, period) values ('66666666-6666-4666-8666-666666666666', '2026-10-01')`)).rejects.toThrow();
    await expect(client.exec(`insert into ai_role_hires (template_key, company_id, settings, hired_on) values ('financial-analyst', '${C1}', '{}', '2026-11-03')`)).rejects.toThrow();
    await expect(client.exec(`delete from ai_role_hires`)).rejects.toThrow(/foreign key/);
  });
});

describe("0013 AI roles fixes on existing data", () => {
  it("adds settings_hash (null for old reports), attempts 0 and next_attempt_at to existing runs", async () => {
    const { client, db } = await newPglite();
    await migrate(db, { migrationsFolder: migrationsUpTo("0013") });
    const C1 = "33333333-3333-4333-8333-333333333331";
    const H = "66666666-6666-4666-8666-666666666666";
    await client.exec(`
      insert into companies (id, slug, name) values ('${C1}', 'kiwi-go', 'Kiwi Go');
      insert into ai_role_templates (key, name, description, status, required_data, default_schedule) values
        ('financial-analyst', 'Financial Analyst', 'd', 'available', '{"byCompanyType":{},"optionalUploads":[]}', '{"kind":"monthly","day":10}');
      insert into ai_role_hires (id, template_key, company_id, settings, hired_on) values ('${H}', 'financial-analyst', '${C1}', '{}', '2026-11-02');
      insert into ai_role_runs (hire_id, period, status, inputs_hash) values ('${H}', '2026-10-01', 'reported', 'abc');
    `);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const rows = await client.query("select status, inputs_hash, settings_hash, attempts, next_attempt_at from ai_role_runs");
    expect(rows.rows).toEqual([{ status: "reported", inputs_hash: "abc", settings_hash: null, attempts: 0, next_attempt_at: null }]);
  });
});

describe("0014 overdue chase style on existing data", () => {
  it("gives every saved preference row the default 'separate' (until 0016) and refuses unknown styles", async () => {
    const { client, db } = await newPglite();
    await migrate(db, { migrationsFolder: migrationsUpTo("0014") });
    await client.exec(`
      insert into users (id, email, name, short_name) values ('${NURAALY}', 'n@x', 'Nuraaly', 'Nuraaly');
      insert into notification_preferences (user_id, max_other_per_day) values ('${NURAALY}', 2);
    `);
    await migrate(db, { migrationsFolder: migrationsUpTo("0016") });
    const rows = await client.query("select max_other_per_day, overdue_chase_style from notification_preferences");
    expect(rows.rows).toEqual([{ max_other_per_day: 2, overdue_chase_style: "separate" }]);
    await expect(client.exec("update notification_preferences set overdue_chase_style = 'loud'")).rejects.toBeTruthy();
  });
});

describe("0015 metric month totals on existing data", () => {
  it("marks every existing value as 'period'; a month total sits next to the day without breaking one-current-per-period", async () => {
    const { client, db } = await newPglite();
    await migrate(db, { migrationsFolder: migrationsUpTo("0015") });
    const C = "33333333-3333-4333-8333-333333333333";
    const M = "66666666-6666-4666-8666-666666666666";
    await client.exec(`
      insert into companies (id, slug, name) values ('${C}', 'kiwi-go', 'Kiwi Go');
      insert into metric_definitions (id, company_id, key, name, unit, granularity) values ('${M}', '${C}', 'orders_day', 'Orders per day', 'orders', 'day');
      insert into metric_values (metric_id, period_start, value, source) values ('${M}', '2026-10-01', 5, 'manual');
    `);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    expect((await client.query("select value, period_kind from metric_values")).rows).toEqual([{ value: "5.0000", period_kind: "period" }]);
    await client.exec(`insert into metric_values (metric_id, period_start, value, source, period_kind) values ('${M}', '2026-10-01', 3100, 'manual', 'month_total')`);
    await expect(
      client.exec(`insert into metric_values (metric_id, period_start, value, source, period_kind) values ('${M}', '2026-10-01', 1, 'manual', 'month_total')`),
    ).rejects.toThrow(/metric_values_current_uq/);
    await expect(client.exec(`insert into metric_values (metric_id, period_start, value, source) values ('${M}', '2026-10-01', 6, 'manual')`)).rejects.toThrow(
      /metric_values_current_uq/,
    );
    await expect(
      client.exec(`insert into metric_values (metric_id, period_start, value, source, period_kind) values ('${M}', '2026-10-01', 1, 'manual', 'week_total')`),
    ).rejects.toThrow(/metric_values_period_kind/);
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

describe("0016 the founders' decisions on existing data", () => {
  it("grouped chase for rows on 'separate' (other choices kept), Talant sees salaries, Financial Analyst hires accept month totals", async () => {
    const { client, db } = await newPglite();
    await migrate(db, { migrationsFolder: migrationsUpTo("0016") });
    const STAFF = "77777777-7777-4777-8777-777777777777";
    const C1 = "33333333-3333-4333-8333-333333333331";
    const C2 = "33333333-3333-4333-8333-333333333332";
    await client.exec(`
      insert into users (id, email, name, short_name, role) values
        ('${NURAALY}', 'nuraaly@founders.local', 'Nuraaly', 'Nuraaly', 'founder'),
        ('${TALANT}', 'talant@founders.local', 'Talant', 'Talant', 'founder'),
        ('${STAFF}', 'staff@x', 'Staff', 'Staff', 'staff');
      insert into salary_viewers (user_id) values ('${NURAALY}');
      insert into notification_preferences (user_id, overdue_chase_style, max_other_per_day) values
        ('${NURAALY}', 'separate', 2), ('${TALANT}', 'summary_only', 3);
      insert into companies (id, slug, name) values ('${C1}', 'kiwi-go', 'Kiwi Go'), ('${C2}', 'jobutify', 'Jobutify');
      insert into ai_role_templates (key, name, description, status, required_data, default_schedule) values
        ('financial-analyst', 'Financial Analyst', 'd', 'available', '{"byCompanyType":{},"optionalUploads":[]}', '{"kind":"monthly","day":10}'),
        ('hr', 'HR', 'd', 'coming_soon', '{"byCompanyType":{},"optionalUploads":[]}', '{"kind":"monthly","day":10}');
      insert into ai_role_hires (template_key, company_id, settings, hired_on) values
        ('financial-analyst', '${C1}', '{"schedule":{"kind":"monthly","day":10},"recipients":["${NURAALY}"]}', '2026-11-02'),
        ('financial-analyst', '${C2}', '{"acceptMonthlyTotals":false}', '2026-11-02'),
        ('hr', '${C1}', '{"acceptMonthlyTotals":false}', '2026-11-02');
    `);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    const prefs = await client.query("select user_id, overdue_chase_style, max_other_per_day from notification_preferences order by user_id");
    expect(prefs.rows).toEqual([
      { user_id: NURAALY, overdue_chase_style: "grouped", max_other_per_day: 2 },
      { user_id: TALANT, overdue_chase_style: "summary_only", max_other_per_day: 3 },
    ]);
    await client.exec(`insert into notification_preferences (user_id) values ('${STAFF}')`);
    expect((await client.query(`select overdue_chase_style from notification_preferences where user_id = '${STAFF}'`)).rows).toEqual([
      { overdue_chase_style: "grouped" },
    ]);

    const viewers = await client.query<{ user_id: string }>("select user_id from salary_viewers order by user_id");
    expect(viewers.rows.map((r) => r.user_id)).toEqual([NURAALY, TALANT]);

    const hires = await client.query<{ template_key: string; company_id: string; settings: Record<string, unknown> }>(
      "select template_key, company_id, settings from ai_role_hires order by template_key, company_id",
    );
    expect(hires.rows).toEqual([
      { template_key: "financial-analyst", company_id: C1, settings: { schedule: { kind: "monthly", day: 10 }, recipients: [NURAALY], acceptMonthlyTotals: true } },
      { template_key: "financial-analyst", company_id: C2, settings: { acceptMonthlyTotals: true } },
      { template_key: "hr", company_id: C1, settings: { acceptMonthlyTotals: false } },
    ]);
  });

  it("is a no-op on an empty database (the seed then adds both founders as salary viewers)", async () => {
    const { client, db } = await newPglite();
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    expect((await client.query("select 1 from salary_viewers")).rows).toHaveLength(0);
  });
});

describe("0018 audit rows for system salary grants on existing data", () => {
  it("adds one labelled grant_viewer row per viewer granted without a person and without a log row; idempotent", async () => {
    const { client, db } = await newPglite();
    await migrate(db, { migrationsFolder: migrationsUpTo("0018") });
    const STAFF = "77777777-7777-4777-8777-777777777777";
    await client.exec(`
      insert into users (id, email, name, short_name, role) values
        ('${NURAALY}', 'nuraaly@founders.local', 'Nuraaly', 'Nuraaly', 'founder'),
        ('${TALANT}', 'talant@founders.local', 'Talant', 'Talant', 'founder'),
        ('${STAFF}', 'staff@x', 'Staff', 'Staff', 'staff');
      -- Nuraaly: granted earlier and logged; Talant: granted by 0016 (no log row); Staff: granted by Nuraaly in Settings, logged.
      insert into salary_viewers (user_id, granted_by, created_at) values
        ('${NURAALY}', null, '2026-10-01T00:00:00Z'), ('${TALANT}', null, '2026-11-02T00:00:00Z'), ('${STAFF}', '${NURAALY}', '2026-11-03T00:00:00Z');
      insert into salary_access_log (actor_user_id, action, scope, target_user_id) values
        (null, 'grant_viewer', 'seed', '${NURAALY}'), ('${NURAALY}', 'grant_viewer', 'settings', '${STAFF}'),
        ('${NURAALY}', 'view', 'people_list', null);
    `);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const rows = await client.query<{ actor_user_id: string | null; action: string; scope: string; target_user_id: string; details: { by: string; source: string }; created_at: Date }>(
      "select actor_user_id, action, scope, target_user_id, details, created_at from salary_access_log where scope = 'system:migration'",
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ actor_user_id: null, action: "grant_viewer", target_user_id: TALANT, details: { by: "system" } });
    expect(rows.rows[0]!.details.source).toContain("0016");
    expect(new Date(rows.rows[0]!.created_at).toISOString()).toBe("2026-11-02T00:00:00.000Z");
    // Re-running the SQL adds nothing.
    await client.exec(readFileSync(path.join(MIGRATIONS_FOLDER, "0018_salary_grant_audit.sql"), "utf8"));
    expect((await client.query("select 1 from salary_access_log where scope = 'system:migration'")).rows).toHaveLength(1);
    expect((await client.query("select 1 from salary_access_log")).rows).toHaveLength(4);
  });
});

describe("0019 who to ask (holding) on existing data", () => {
  it("each flow gets its companies' accountant (providing company first), asked акты record him; nobody → empty; RLS on the new table", async () => {
    const { client, db } = await newPglite();
    await migrate(db, { migrationsFolder: migrationsUpTo("0019") });
    const C = (n: number) => `33333333-3333-4333-8333-33333333333${n}`;
    const ELM = "55555555-5555-4555-8555-555555555551";
    const AIG = "55555555-5555-4555-8555-555555555552";
    const GONE = "55555555-5555-4555-8555-555555555553";
    const FOUNDER_P = "55555555-5555-4555-8555-555555555554";
    const F = (n: number) => `66666666-6666-4666-8666-66666666666${n}`;
    await client.exec(`
      insert into users (id, email, name, short_name, role) values ('${NURAALY}', 'nuraaly@founders.local', 'Nuraaly', 'Nuraaly', 'founder');
      insert into companies (id, slug, name) values ('${C(1)}', 'alura-style', 'Alura Style'), ('${C(2)}', 'alura-brand', 'Alura Brand'),
        ('${C(3)}', 'upsell', 'Upsell'), ('${C(4)}', 'marketing', 'Marketing');
      insert into people (id, full_name, short_name, user_id, left_at) values
        ('${ELM}', 'Elmurat', null, null, null), ('${AIG}', 'Aigul', 'Айгуль', null, null),
        ('${GONE}', 'Aaron Gone', null, null, now()), ('${FOUNDER_P}', 'Aa Founder', null, '${NURAALY}', null);
      insert into person_companies (person_id, company_id, role, title, is_active) values
        ('${ELM}', '${C(1)}', 'accountant', 'Accountant', true),
        ('${AIG}', '${C(2)}', 'manager', 'Бухгалтер', true),
        ('${GONE}', '${C(1)}', 'accountant', null, true),
        ('${FOUNDER_P}', '${C(1)}', 'accountant', null, true),
        ('${ELM}', '${C(3)}', 'accountant', null, false);
      insert into intercompany_flows (id, from_company_id, to_company_id, service, since) values
        ('${F(1)}', '${C(1)}', '${C(2)}', 'пошив', '2026-09-01'),
        ('${F(2)}', '${C(2)}', '${C(1)}', 'материалы', '2026-09-01'),
        ('${F(3)}', '${C(3)}', '${C(4)}', 'реклама', null);
      insert into intercompany_acts (flow_id, period, status, requested_on) values
        ('${F(1)}', '2026-09-01', 'requested', '2026-10-11'), ('${F(1)}', '2026-10-01', 'missing', null);
    `);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const flows = await client.query<{ id: string; ask_person_id: string | null }>("select id, ask_person_id from intercompany_flows order by id");
    // Flow 1 (Alura Style provides): Elmurat; flow 2 (Alura Brand provides): Aigul (title Бухгалтер); flow 3: nobody
    // (Elmurat's Upsell link is inactive). Never the founder's person record or someone who left.
    expect(flows.rows).toEqual([
      { id: F(1), ask_person_id: ELM },
      { id: F(2), ask_person_id: AIG },
      { id: F(3), ask_person_id: null },
    ]);
    const acts = await client.query<{ period: string; requested_person_id: string | null }>(
      "select to_char(period, 'YYYY-MM') as period, requested_person_id from intercompany_acts order by period",
    );
    expect(acts.rows).toEqual([
      { period: "2026-09", requested_person_id: ELM },
      { period: "2026-10", requested_person_id: null },
    ]);
    // People records are not changed.
    expect((await client.query(`select short_name from people where id = '${ELM}'`)).rows).toEqual([{ short_name: null }]);
    const rls = await client.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname = 'holding_ask_overrides'");
    expect(rls.rows).toEqual([{ relrowsecurity: true }]);
    await expect(client.query(`insert into holding_ask_overrides (round_key, flow_id, person_id) values ('2026-13', '${F(1)}', '${AIG}')`)).rejects.toThrow();
    await client.query(`insert into holding_ask_overrides (round_key, flow_id, person_id) values ('2026-11', '${F(1)}', '${AIG}')`);
    await expect(client.query(`insert into holding_ask_overrides (round_key, flow_id, person_id) values ('2026-11', '${F(1)}', '${ELM}')`)).rejects.toThrow();
  });
});

describe("0017 org structure on existing data", () => {
  it("adds the org tables with RLS, keeps tasks (no department) and enforces the number ranges and one chart per company", async () => {
    const { client, db } = await newPglite();
    await migrate(db, { migrationsFolder: migrationsUpTo("0017") });
    const C1 = "33333333-3333-4333-8333-333333333331";
    await client.exec(`
      insert into users (id, email, name, short_name, role) values ('${NURAALY}', 'nuraaly@founders.local', 'Nuraaly', 'Nuraaly', 'founder');
      insert into companies (id, slug, name) values ('${C1}', 'kiwi-go', 'Kiwi Go');
      insert into tasks (title, company_id, owner_user_id, visibility) values ('Существующая задача', '${C1}', '${NURAALY}', 'shared');
    `);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    const tasks = await client.query<{ title: string; org_department_id: string | null }>("select title, org_department_id from tasks");
    expect(tasks.rows).toEqual([{ title: "Существующая задача", org_department_id: null }]);
    const rls = await client.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class where relname in ('org_charts','org_divisions','org_departments','org_functions','org_change_log') order by relname",
    );
    expect(rls.rows).toEqual(["org_change_log", "org_charts", "org_departments", "org_divisions", "org_functions"].map((relname) => ({ relname, relrowsecurity: true })));

    const chart = (await client.query<{ id: string }>(`insert into org_charts (company_id, template_key) values ('${C1}', 'vysotsky-7-21') returning id`)).rows[0]!.id;
    await expect(client.query(`insert into org_charts (company_id, template_key) values ('${C1}', 'again')`)).rejects.toThrow();
    await expect(client.query(`insert into org_divisions (chart_id, company_id, number) values ('${chart}', '${C1}', 8)`)).rejects.toThrow(/org_divisions_number_range/);
    const div = (await client.query<{ id: string }>(`insert into org_divisions (chart_id, company_id, number, name) values ('${chart}', '${C1}', 7, 'Административное') returning id`)).rows[0]!.id;
    await expect(client.query(`insert into org_departments (chart_id, company_id, division_id, number) values ('${chart}', '${C1}', '${div}', 100)`)).rejects.toThrow(/org_departments_number_range/);
    const dep = (await client.query<{ id: string }>(`insert into org_departments (chart_id, company_id, division_id, number, name) values ('${chart}', '${C1}', '${div}', 21, 'Отдел владельца') returning id`)).rows[0]!.id;
    await client.exec(`update tasks set org_department_id = '${dep}'`);
    // Departments are never deleted (archived instead): the FK refuses while rows point at it.
    await client.exec(`insert into org_functions (chart_id, company_id, department_id, text) values ('${chart}', '${C1}', '${dep}', 'Связь с учредителями')`);
    await expect(client.query(`delete from org_departments where id = '${dep}'`)).rejects.toThrow();
  });
});

describe("0020 org integrity on existing data", () => {
  it("renumbers duplicate live department numbers (logged), then enforces unique numbers and same-chart / same-company rows", async () => {
    const { client, db } = await newPglite();
    await migrate(db, { migrationsFolder: migrationsUpTo("0020") });
    const C1 = "33333333-3333-4333-8333-333333333331";
    const C2 = "33333333-3333-4333-8333-333333333332";
    const CH = "88888888-8888-4888-8888-888888888881";
    const CH2 = "88888888-8888-4888-8888-888888888882";
    const DV = "99999999-9999-4999-8999-999999999991";
    const DV2 = "99999999-9999-4999-8999-999999999992";
    await client.exec(`
      insert into companies (id, slug, name) values ('${C1}', 'kiwi-go', 'Kiwi Go'), ('${C2}', 'jobutify', 'Jobutify');
      insert into org_charts (id, company_id, template_key) values ('${CH}', '${C1}', 't'), ('${CH2}', '${C2}', 't');
      insert into org_divisions (id, chart_id, company_id, number, name) values ('${DV}', '${CH}', '${C1}', 7, 'Админ'), ('${DV2}', '${CH2}', '${C2}', 7, 'Админ');
      insert into org_departments (id, chart_id, company_id, division_id, number, name, sort) values
        ('a1111111-1111-4111-8111-111111111111', '${CH}', '${C1}', '${DV}', 22, 'Первый', 0),
        ('a2222222-2222-4222-8222-222222222222', '${CH}', '${C1}', '${DV}', 22, 'Второй', 1),
        ('a3333333-3333-4333-8333-333333333333', '${CH}', '${C1}', '${DV}', 23, 'Третий', 2),
        ('a4444444-4444-4444-8444-444444444444', '${CH}', '${C1}', '${DV}', 23, 'Архивный', 3);
      update org_departments set archived_at = now() where name = 'Архивный';
    `);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const rows = await client.query<{ name: string; number: number }>("select name, number from org_departments order by sort");
    expect(rows.rows).toEqual([
      { name: "Первый", number: 22 },
      { name: "Второй", number: 24 },
      { name: "Третий", number: 23 },
      { name: "Архивный", number: 23 },
    ]);
    const log = await client.query<{ action: string; summary: string }>("select action, summary from org_change_log");
    expect(log.rows).toEqual([{ action: "renumber", summary: "Renumbered duplicate department 22 Второй to 24" }]);
    await expect(client.query(`update org_departments set number = 22 where name = 'Третий'`)).rejects.toThrow();
    // A department of chart 1 in chart 2's division, or with another company: refused.
    await expect(
      client.query(`insert into org_departments (chart_id, company_id, division_id, number, name) values ('${CH}', '${C1}', '${DV2}', 30, 'x')`),
    ).rejects.toThrow();
    await expect(
      client.query(`insert into org_departments (chart_id, company_id, division_id, number, name) values ('${CH}', '${C2}', '${DV}', 31, 'x')`),
    ).rejects.toThrow();
  });
});

describe("0021 AI role editor on existing data", () => {
  it("adds the role config and settings log tables (RLS), and makes the org expert's Monday line explicit; other hires untouched", async () => {
    const { client, db } = await newPglite();
    await migrate(db, { migrationsFolder: migrationsUpTo("0020") });
    const C1 = "33333333-3333-4333-8333-333333333331";
    await client.exec(`
      insert into companies (id, slug, name) values ('${C1}', 'kiwi-go', 'Kiwi Go');
      insert into ai_role_templates (key, name, description, status, required_data, default_schedule) values
        ('financial-analyst', 'Financial Analyst', 'd', 'available', '{"byCompanyType": {}, "optionalUploads": []}', '{"kind": "monthly", "day": 10}'),
        ('org-structure-expert', 'Org Structure Expert', 'd', 'available', '{"byCompanyType": {}, "optionalUploads": []}', '{"kind": "monthly", "day": 1}');
      insert into ai_role_hires (template_key, company_id, settings, hired_on) values
        ('financial-analyst', '${C1}', '{"schedule": {"kind": "monthly", "day": 10}, "thresholds": {"changePct": 20, "riskChangePct": 50}}', '2026-11-01'),
        ('org-structure-expert', '${C1}', '{"schedule": {"kind": "monthly", "day": 1}, "maxDepartmentsPerHead": 3}', '2026-11-01');
    `);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const hires = await client.query<{ template_key: string; settings: { schedule: unknown; maxDepartmentsPerHead?: number } }>("select template_key, settings from ai_role_hires order by template_key");
    expect(hires.rows.map((r) => [r.template_key, r.settings.schedule, r.settings.maxDepartmentsPerHead ?? null])).toEqual([
      ["financial-analyst", { kind: "monthly", day: 10 }, null],
      ["org-structure-expert", { kind: "weekly", weekday: 1 }, 3],
    ]);
    const tpl = await client.query<{ default_schedule: unknown }>("select default_schedule from ai_role_templates where key = 'org-structure-expert'");
    expect(tpl.rows[0]!.default_schedule).toEqual({ kind: "weekly", weekday: 1 });
    const rls = await client.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class where relname in ('ai_role_configs', 'ai_role_settings_log') order by relname",
    );
    expect(rls.rows).toEqual([
      { relname: "ai_role_configs", relrowsecurity: true },
      { relname: "ai_role_settings_log", relrowsecurity: true },
    ]);
    await expect(client.query(`insert into ai_role_configs (key, kind) values ('custom-x', 'custom')`)).rejects.toThrow();
  });
});

describe("0022 browser extension ingest", () => {
  it("adds the 'extension' number source and the key / log tables with RLS; keys are unique by hash", async () => {
    const { client, db } = await newPglite();
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const vals = await client.query<{ v: string }>("select unnest(enum_range(null::metric_source))::text as v");
    expect(vals.rows.map((r) => r.v)).toEqual(["manual", "upload", "connector", "derived", "extension"]);
    const rls = await client.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class where relname in ('extension_keys', 'extension_ingest_log') order by relname",
    );
    expect(rls.rows).toEqual([
      { relname: "extension_ingest_log", relrowsecurity: true },
      { relname: "extension_keys", relrowsecurity: true },
    ]);
    const U = "44444444-4444-4444-8444-444444444441";
    await client.exec(`insert into users (id, email, name, short_name, role, password_hash) values ('${U}', 'a@x', 'A', 'A', 'founder', 'x')`);
    await client.exec(`insert into extension_keys (user_id, name, key_hash, key_prefix) values ('${U}', 'k', 'h1', 'fcx_')`);
    await expect(client.query(`insert into extension_keys (user_id, name, key_hash, key_prefix) values ('${U}', 'k2', 'h1', 'fcx_')`)).rejects.toThrow();
  });
});

describe("0023 ingest rate counters", () => {
  it("adds the counter table with RLS; the atomic upsert counts per bucket and window", async () => {
    const { client, db } = await newPglite();
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const rls = await client.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname = 'ingest_rate_counters'");
    expect(rls.rows).toEqual([{ relrowsecurity: true }]);
    const hit = () =>
      client.query<{ n: number }>(
        "insert into ingest_rate_counters (bucket, window_start, n) values ('key:x', '2026-11-02T06:00:00Z', 1) on conflict (bucket, window_start) do update set n = ingest_rate_counters.n + 1 returning n",
      );
    expect((await hit()).rows[0]!.n).toBe(1);
    expect((await hit()).rows[0]!.n).toBe(2);
  });
});

describe("0024 is_pay_data on existing metrics", () => {
  it("flags pay-named metrics (name, aliases, snake / camel key); piecework_total and look-alikes stay unflagged", async () => {
    const { client, db } = await newPglite();
    await migrate(db, { migrationsFolder: migrationsUpTo("0024") });
    const C = "55555555-5555-4555-8555-555555555551";
    await client.exec(`insert into companies (id, slug, name) values ('${C}', 'alura-style', 'Alura Style')`);
    const defs: [string, string, string[]][] = [
      ["staff_pay", "З/П сотрудников", []],
      ["zar", "Зар. плата", []],
      ["comp", "Compensation", []],
      ["fotTotal", "Total", []],
      ["fot_total", "Total", []],
      ["bonus_q", "Quarterly", []],
      ["prem", "Премии", []],
      ["office", "Office", ["Оклады"]],
      ["piecework_total", "Piecework pay total", ["ФОТ сдельный"]],
      ["premium_sales", "Премиум продажи", []],
      ["photos", "Photos", ["Фото"]],
      ["revenue", "Revenue", []],
    ];
    for (const [key, name, aliases] of defs) {
      await client.query("insert into metric_definitions (company_id, key, name, aliases, unit, granularity) values ($1, $2, $3, $4::jsonb, 'KGS', 'month')", [C, key, name, JSON.stringify(aliases)]);
    }
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const rows = await client.query<{ key: string; is_pay_data: boolean }>("select key, is_pay_data from metric_definitions order by key");
    expect(Object.fromEntries(rows.rows.map((r) => [r.key, r.is_pay_data]))).toEqual({
      staff_pay: true,
      zar: true,
      comp: true,
      fotTotal: true,
      fot_total: true,
      bonus_q: true,
      prem: true,
      office: true,
      piecework_total: false,
      premium_sales: false,
      photos: false,
      revenue: false,
    });
  });
});
