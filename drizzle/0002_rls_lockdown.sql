-- =============================================================================
-- Lock down every table in the public schema (C1 review finding 1).
--
-- Supabase exposes the public schema through its Data API and, by default, grants
-- the `anon` and `authenticated` roles full privileges on new tables. Anyone holding
-- the (public) anon key could then read users.password_hash, sessions, private
-- todos, Telegram link codes, ... This migration:
--
--   1. enables row level security on EVERY table in public (no policies = deny-all
--      for client roles). RLS is enabled but NOT forced, so the app, which connects
--      as the table owner, keeps working and the service layer stays the one place
--      for access rules (src/server/services/access.ts);
--   2. revokes all table and sequence privileges from anon and authenticated
--      and stops future tables created by this role from being granted to them.
--
-- Step 2 is skipped where those roles do not exist (PGlite, plain local Postgres).
-- Safe to re-run; changes no data. Narrow, policy-based client access for a future
-- direct-client mode lives in supabase/policies.sql (applied by hand, reviewed).
--
-- Every later migration that creates a table must enable RLS on THAT table and revoke
-- anon/authenticated on it (tests/integration/rls.test.ts fails otherwise). Do not
-- re-run this loop over all tables later: it would undo grants from policies.sql.
-- =============================================================================
DO $$
DECLARE
  r record;
  -- "anon, authenticated" (only the roles that exist), or NULL when neither exists.
  client_roles text := (SELECT string_agg(quote_ident(rolname), ', ') FROM pg_roles
                        WHERE rolname IN ('anon', 'authenticated'));
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
    IF client_roles IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %s', r.relname, client_roles);
    END IF;
  END LOOP;

  IF client_roles IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %s', client_roles);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %s', client_roles);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %s', client_roles);
  END IF;
END $$;
