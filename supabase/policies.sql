-- =============================================================================
-- Row Level Security policies for a FUTURE direct-client mode on Supabase.
-- NOT applied by `npm run db:migrate`. Review, then apply by hand:
--     psql "$DATABASE_URL" -f supabase/policies.sql
--
-- HOW ACCESS WORKS TODAY
--   The app enforces every rule in the server-side service layer
--   (src/server/services/*, the single source of truth is access.ts). The Next.js
--   server connects as the table owner, which bypasses RLS (RLS is enabled, not forced).
--   Migration drizzle/0002_rls_lockdown.sql already enables RLS on every table and
--   revokes all privileges from `anon` and `authenticated`, so with the anon key
--   NOTHING is readable or writable. That is the safe default and needs no action.
--
-- WHAT THIS FILE IS FOR
--   Defense in depth for when a client (e.g. the iOS app) talks to Supabase directly
--   with a signed-in user's JWT. It re-grants the `authenticated` role narrowly and
--   mirrors the service-layer rules exactly:
--     * a PRIVATE task (personal todo) is visible only to its owner;
--     * a SHARED task needs a company and is visible to every founder;
--     * a private task cannot be assigned to anyone but its owner;
--     * the owner of a task can never change, and only the owner may change who
--       sees it (shared <-> private);
--     * task_events (audit log) are append-only, readable under the same rule as the
--       task (snapshot columns visibility/owner_user_id), and can only be written for
--       tasks the user can see;
--     * users.password_hash, sessions, login attempts, Telegram link codes and button
--       tokens are never readable by clients.
--   `anon` gets nothing. Keep this file in sync with access.ts when rules change.
--
-- Assumptions (to finish when AUTH_MODE=supabase is implemented):
--   * users.external_auth_id holds auth.uid()::text for each founder.
--   * Staff accounts and salaries come later and will add their own policies.
-- The file is idempotent (drop ... if exists / create or replace).
-- =============================================================================

-- Helpers --------------------------------------------------------------------------
-- The app user id (users.id) for the current Supabase auth user, or NULL.
create or replace function public.app_user_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.users where external_auth_id = auth.uid()::text
$$;

create or replace function public.is_founder() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.users where id = public.app_user_id() and role = 'founder')
$$;

-- Same rule as validateRelations() in src/server/services/tasks.ts.
create or replace function public.task_shape_ok(
  p_visibility public.task_visibility,
  p_company_id uuid,
  p_owner uuid,
  p_assignee_user uuid,
  p_assignee_person uuid
) returns boolean language sql immutable as $$
  select case p_visibility
    when 'shared' then p_company_id is not null
    when 'private' then p_assignee_person is null
                        and (p_assignee_user is null or p_assignee_user = p_owner)
    else false
  end
$$;

revoke all on function public.app_user_id() from anon;
revoke all on function public.is_founder() from anon;

-- RLS on (already done by migration 0002; repeated so this file is self-contained) ----
do $$
declare r record;
begin
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p') loop
    execute format('alter table public.%I enable row level security', r.relname);
    execute format('revoke all on table public.%I from anon, authenticated', r.relname);
  end loop;
end $$;

-- users ----------------------------------------------------------------------------
-- Column-level grant: password_hash and external_auth_id are NOT in the list, so
-- `select password_hash` / `select *` fail with "permission denied" for clients.
-- (A column-level REVOKE is useless while a table-level SELECT exists; hence no
-- table-level grant here.)
grant select (id, email, name, short_name, role, created_at, updated_at)
  on public.users to authenticated;
drop policy if exists users_select on public.users;
create policy users_select on public.users for select to authenticated
  using (public.is_founder());

-- sessions, login_attempts, telegram_link_codes, notification_action_tokens:
-- server-only. No grant, no policy = no client access at all.

-- companies, company_units, people, person_companies, projects: shared between founders.
grant select, insert, update on public.companies, public.company_units, public.people,
  public.person_companies, public.projects to authenticated;
drop policy if exists companies_founders on public.companies;
create policy companies_founders on public.companies for all to authenticated
  using (public.is_founder()) with check (public.is_founder());
drop policy if exists company_units_founders on public.company_units;
create policy company_units_founders on public.company_units for all to authenticated
  using (public.is_founder()) with check (public.is_founder());
drop policy if exists people_founders on public.people;
create policy people_founders on public.people for all to authenticated
  using (public.is_founder()) with check (public.is_founder());
drop policy if exists person_companies_founders on public.person_companies;
create policy person_companies_founders on public.person_companies for all to authenticated
  using (public.is_founder()) with check (public.is_founder());
drop policy if exists projects_founders on public.projects;
create policy projects_founders on public.projects for all to authenticated
  using (public.is_founder()) with check (public.is_founder());

-- tasks -----------------------------------------------------------------------------
grant select, insert, update, delete on public.tasks to authenticated;

drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks for select to authenticated using (
  public.is_founder()
  and (visibility = 'shared' or owner_user_id = public.app_user_id())
);

drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert to authenticated with check (
  public.is_founder()
  and owner_user_id = public.app_user_id()
  and public.task_shape_ok(visibility, company_id, owner_user_id, assignee_user_id, assignee_person_id)
);

-- USING: which rows you may touch. WITH CHECK: what the row may look like afterwards.
-- WITH CHECK cannot see the old row, so "owner never changes" and "only the owner
-- changes visibility" are enforced by the trigger below.
drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to authenticated using (
  public.is_founder()
  and (visibility = 'shared' or owner_user_id = public.app_user_id())
) with check (
  public.is_founder()
  and (visibility = 'shared' or owner_user_id = public.app_user_id())
  and public.task_shape_ok(visibility, company_id, owner_user_id, assignee_user_id, assignee_person_id)
);

drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks for delete to authenticated using (
  public.is_founder()
  and (visibility = 'shared' or owner_user_id = public.app_user_id())
);

create or replace function public.tasks_guard_client_update() returns trigger
language plpgsql as $$
begin
  -- Only client roles are restricted; the server (table owner) is governed by the service layer.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if new.owner_user_id is distinct from old.owner_user_id then
    raise exception 'The owner of a task cannot be changed' using errcode = '42501';
  end if;
  if new.visibility is distinct from old.visibility
     and old.owner_user_id is distinct from public.app_user_id() then
    raise exception 'Only the task''s creator can change who sees it' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists tasks_guard_client_update on public.tasks;
create trigger tasks_guard_client_update before update on public.tasks
  for each row execute function public.tasks_guard_client_update();

-- task_events (append-only audit log) -------------------------------------------------
-- visibility/owner_user_id are copied from the task (and kept after it is deleted),
-- so private-task history never leaks, even for deleted tasks.
grant select, insert on public.task_events to authenticated;

drop policy if exists task_events_select on public.task_events;
create policy task_events_select on public.task_events for select to authenticated using (
  public.is_founder()
  and (visibility = 'shared' or owner_user_id = public.app_user_id())
);

drop policy if exists task_events_insert on public.task_events;
create policy task_events_insert on public.task_events for insert to authenticated with check (
  actor_user_id = public.app_user_id()
  -- The subquery runs under the caller's RLS on tasks: invisible tasks do not match.
  and exists (
    select 1 from public.tasks t
    where t.id = task_events.task_id
      and t.visibility = task_events.visibility
      and t.owner_user_id = task_events.owner_user_id
  )
);
-- No update/delete policies: the audit log cannot be rewritten by clients.

-- notifications_outbox: each founder reads only their own items. Writes: server only.
grant select on public.notifications_outbox to authenticated;
drop policy if exists notifications_own on public.notifications_outbox;
create policy notifications_own on public.notifications_outbox for select to authenticated using (
  user_id = public.app_user_id()
);

-- notification_preferences: each founder reads and edits only their own row.
grant select, insert, update on public.notification_preferences to authenticated;
drop policy if exists notification_preferences_own on public.notification_preferences;
create policy notification_preferences_own on public.notification_preferences for all to authenticated
  using (user_id = public.app_user_id())
  with check (user_id = public.app_user_id());

-- telegram_links: a founder may see and remove their own link. Linking happens only on
-- the server (webhook consuming a one-time code), so there is no insert/update policy.
grant select, delete on public.telegram_links to authenticated;
drop policy if exists telegram_links_select_own on public.telegram_links;
create policy telegram_links_select_own on public.telegram_links for select to authenticated using (
  user_id = public.app_user_id()
);
drop policy if exists telegram_links_delete_own on public.telegram_links;
create policy telegram_links_delete_own on public.telegram_links for delete to authenticated using (
  user_id = public.app_user_id()
);

-- reminder_snoozes: own rows only, read-only (written by the server on "Snooze 1 day").
grant select on public.reminder_snoozes to authenticated;
drop policy if exists reminder_snoozes_own on public.reminder_snoozes;
create policy reminder_snoozes_own on public.reminder_snoozes for select to authenticated using (
  user_id = public.app_user_id()
);
