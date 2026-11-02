import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { connectDb, type DbHandle } from "@/server/db/connect";
import { runMigrations } from "@/server/db/migrate";

const handles: DbHandle[] = [];
afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
});

async function freshDb(beforeMigrate?: (h: DbHandle) => Promise<void>): Promise<DbHandle> {
  const h = await connectDb("memory://");
  handles.push(h);
  await beforeMigrate?.(h);
  await runMigrations(h);
  return h;
}

async function rows<T>(h: DbHandle, query: ReturnType<typeof sql>): Promise<T[]> {
  const res = (await h.db.execute(query)) as unknown as { rows?: T[] } | T[];
  return Array.isArray(res) ? res : (res.rows ?? []);
}

const PUBLIC_TABLES = sql`
  select c.relname as name, c.relrowsecurity as rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
  order by c.relname`;

describe("row level security after migrate", () => {
  it("every table in public has RLS enabled (new tables cannot forget it)", async () => {
    const h = await freshDb();
    const tables = await rows<{ name: string; rls: boolean }>(h, PUBLIC_TABLES);
    expect(tables.length).toBeGreaterThanOrEqual(15);
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "users",
        "sessions",
        "tasks",
        "task_events",
        "notifications_outbox",
        "notification_preferences",
        "telegram_links",
        "telegram_link_codes",
        "notification_action_tokens",
        "reminder_snoozes",
        "salaries",
        "salary_viewers",
        "salary_access_log",
      ]),
    );
    expect(tables.filter((t) => !t.rls).map((t) => t.name)).toEqual([]);
  });

  it("on a Supabase-like database, anon/authenticated lose every grant and are denied", async () => {
    // Simulate Supabase: client roles exist and get default grants on every new table.
    const h = await freshDb(async (db) => {
      for (const stmt of [
        "create role anon nologin",
        "create role authenticated nologin",
        "grant usage on schema public to anon, authenticated",
        "alter default privileges in schema public grant all on tables to anon, authenticated",
        "alter default privileges in schema public grant all on sequences to anon, authenticated",
      ]) {
        await db.db.execute(sql.raw(stmt));
      }
    });

    const granted = await rows<{ name: string; role: string }>(
      h,
      sql`select c.relname as name, r.rolname as role
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          cross join (values ('anon'), ('authenticated')) as r(rolname)
          where n.nspname = 'public' and c.relkind in ('r', 'p')
            and has_table_privilege(r.rolname, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`,
    );
    expect(granted).toEqual([]);

    // Future tables created by the migrating role are no longer auto-granted either.
    await h.db.execute(sql`create table public.later_table (id int)`);
    const [later] = await rows<{ ok: boolean }>(
      h,
      sql`select has_table_privilege('anon', 'public.later_table', 'SELECT') as ok`,
    );
    expect(later?.ok).toBe(false);

    // And a direct query as the anon role fails.
    const err = await h.db
      .transaction(async (tx) => {
        await tx.execute(sql`set local role anon`);
        await tx.execute(sql`select password_hash from public.users`);
      })
      .then(
        () => null,
        (e: unknown) => e as Error & { cause?: Error },
      );
    expect(err?.cause?.message ?? err?.message).toMatch(/permission denied/);
  });
});
