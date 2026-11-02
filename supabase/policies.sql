-- =============================================================================
-- DRAFT Row Level Security policies for Supabase.  NOT applied locally.
--
-- Today every rule is enforced in the server-side service layer
-- (src/server/services/*, see access.ts). These policies mirror those rules as
-- a second line of defence for when the app moves to Supabase, so that even a
-- query made with the anon key (e.g. from a future iOS app) cannot leak data.
--
-- Assumptions (to finish when AUTH_MODE=supabase is implemented):
--   * users.external_auth_id holds auth.uid()::text for each founder.
--   * The Next.js server keeps using the service-role key / direct Postgres
--     connection (bypasses RLS) and the service layer; RLS protects any
--     client-side or mobile access with the anon key + user JWT.
--   * Staff accounts and salaries come later and will add their own policies.
-- Review before applying:  psql "$DATABASE_URL" -f supabase/policies.sql
-- =============================================================================

-- Helper: the app user id (users.id) for the current Supabase auth user.
create or replace function public.app_user_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.users where external_auth_id = auth.uid()::text
$$;

create or replace function public.is_founder() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.users where id = public.app_user_id() and role = 'founder')
$$;

-- Enable RLS everywhere ---------------------------------------------------------
alter table public.users                enable row level security;
alter table public.sessions             enable row level security;
alter table public.companies            enable row level security;
alter table public.company_units        enable row level security;
alter table public.people               enable row level security;
alter table public.person_companies     enable row level security;
alter table public.projects             enable row level security;
alter table public.tasks                enable row level security;
alter table public.task_events          enable row level security;
alter table public.notifications_outbox enable row level security;

-- users: founders can see founders (names for assignee pickers); nobody reads hashes
-- via the API because password_hash is excluded by a column grant below.
create policy users_select on public.users for select using (public.is_founder());
revoke select (password_hash) on public.users from anon, authenticated;

-- sessions: never exposed to clients (local-auth only). No policy = no access.

-- companies & units & people & links & projects: shared between founders.
create policy companies_founders on public.companies for all
  using (public.is_founder()) with check (public.is_founder());
create policy company_units_founders on public.company_units for all
  using (public.is_founder()) with check (public.is_founder());
create policy people_founders on public.people for all
  using (public.is_founder()) with check (public.is_founder());
create policy person_companies_founders on public.person_companies for all
  using (public.is_founder()) with check (public.is_founder());
create policy projects_founders on public.projects for all
  using (public.is_founder()) with check (public.is_founder());

-- tasks: shared tasks visible to founders; PRIVATE tasks only to their owner.
create policy tasks_select on public.tasks for select using (
  owner_user_id = public.app_user_id()
  or (visibility = 'shared' and public.is_founder())
);
create policy tasks_insert on public.tasks for insert with check (
  owner_user_id = public.app_user_id()
  and public.is_founder()
  and (visibility = 'shared' and company_id is not null
       or visibility = 'private' and assignee_person_id is null
          and (assignee_user_id is null or assignee_user_id = owner_user_id))
);
create policy tasks_update on public.tasks for update using (
  owner_user_id = public.app_user_id()
  or (visibility = 'shared' and public.is_founder())
) with check (
  -- only the owner may turn a task private (otherwise it would vanish for them)
  owner_user_id = public.app_user_id() or visibility = 'shared'
);
create policy tasks_delete on public.tasks for delete using (
  owner_user_id = public.app_user_id()
  or (visibility = 'shared' and public.is_founder())
);

-- task_events: readable when the underlying task is readable; insert only as yourself.
create policy task_events_select on public.task_events for select using (
  exists (select 1 from public.tasks t where t.id = task_events.task_id)  -- RLS on tasks applies
);
create policy task_events_insert on public.task_events for insert with check (
  actor_user_id = public.app_user_id()
);

-- notifications_outbox: each founder sees only their own notifications.
-- Writes are done by the server (service role), never by clients.
create policy notifications_own on public.notifications_outbox for select using (
  user_id = public.app_user_id()
);
