-- Tasks like Linear (0034): Linear's statuses and priorities (existing tasks mapped, data kept),
-- estimate points, "needs review", task keys (UPS-1583 / ME-12), labels, promoted sub-tasks.
-- Additive: every new column has a default or is nullable; nothing is dropped except the two
-- enum types whose columns become text + check constraints (like routines.status).

-- Status: todo / in_progress / done / cancelled stay; "waiting" (on someone else) → In Review.
ALTER TABLE "tasks" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "status" SET DATA TYPE text USING "status"::text;--> statement-breakpoint
UPDATE "tasks" SET "status" = 'in_review' WHERE "status" = 'waiting';--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "status" SET DEFAULT 'todo';--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_ck" CHECK ("tasks"."status" in ('backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'));--> statement-breakpoint
-- Priority: urgent / high / low stay; "normal" → Medium. New tasks default to No priority.
ALTER TABLE "tasks" ALTER COLUMN "priority" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "priority" SET DATA TYPE text USING "priority"::text;--> statement-breakpoint
UPDATE "tasks" SET "priority" = 'medium' WHERE "priority" = 'normal';--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "priority" SET DEFAULT 'none';--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_priority_ck" CHECK ("tasks"."priority" in ('none', 'urgent', 'high', 'medium', 'low'));--> statement-breakpoint
DROP TYPE IF EXISTS "public"."task_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."task_priority";--> statement-breakpoint

ALTER TABLE "tasks" ADD COLUMN "number" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "estimate" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "needs_review" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "over_estimate_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "parent_task_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_estimate_ck" CHECK ("tasks"."estimate" is null or "tasks"."estimate" in (1, 2, 3, 5, 8, 13));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Tasks already in progress started (at the latest) when they were last changed.
UPDATE "tasks" SET "started_at" = "updated_at" WHERE "status" = 'in_progress';--> statement-breakpoint

-- Task key prefixes: 3 letters of the slug (upsell-group → UPS); a clash takes 2 + 1 of the next
-- word (alura-style → ALS), then a digit. "ME" is the personal todos' prefix.
ALTER TABLE "companies" ADD COLUMN "task_prefix" text;--> statement-breakpoint
DO $$
DECLARE
  r record;
  words text[];
  base text;
  cand text;
  i integer;
BEGIN
  FOR r IN SELECT "id", "slug" FROM "companies" ORDER BY "sort", "created_at", "id" LOOP
    words := array_remove(regexp_split_to_array(upper(regexp_replace(r."slug", '[^A-Za-z-]', '', 'g')), '-+'), '');
    base := left(array_to_string(words, ''), 3);
    IF length(base) < 2 THEN base := 'CO' || coalesce(base, ''); END IF;
    cand := base;
    IF (cand = 'ME' OR EXISTS (SELECT 1 FROM "companies" WHERE "task_prefix" = cand)) AND coalesce(array_length(words, 1), 0) > 1 THEN
      cand := left(words[1], 2) || left(words[2], 1);
    END IF;
    i := 2;
    WHILE cand = 'ME' OR EXISTS (SELECT 1 FROM "companies" WHERE "task_prefix" = cand) LOOP
      cand := left(base, 3) || i::text;
      i := i + 1;
    END LOOP;
    UPDATE "companies" SET "task_prefix" = cand WHERE "id" = r."id";
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_task_prefix_ck" CHECK ("companies"."task_prefix" is null or "companies"."task_prefix" ~ '^[A-Z][A-Z0-9]{1,5}$');--> statement-breakpoint
CREATE UNIQUE INDEX "companies_task_prefix_uq" ON "companies" USING btree ("task_prefix");--> statement-breakpoint

-- Task numbers per scope (company, or the owner's personal todos), oldest first.
CREATE TABLE "task_key_counters" (
	"scope" text PRIMARY KEY NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
WITH n AS (
  SELECT "id", row_number() OVER (PARTITION BY coalesce("company_id"::text, 'user:' || "owner_user_id"::text) ORDER BY "created_at", "id") AS rn
  FROM "tasks"
)
UPDATE "tasks" SET "number" = n.rn FROM n WHERE n."id" = "tasks"."id";--> statement-breakpoint
INSERT INTO "task_key_counters" ("scope", "last_number")
SELECT CASE WHEN "company_id" IS NULL THEN 'user:' || "owner_user_id"::text ELSE 'company:' || "company_id"::text END, max("number")
FROM "tasks"
GROUP BY 1;--> statement-breakpoint
-- New tasks (and tasks moved to another company) take the next number of their scope. The
-- counter row is upserted, so concurrent inserts in one company are serialized on that row.
-- SECURITY DEFINER: a Supabase client allowed to insert a task (supabase/policies.sql) has no
-- access to the counters table itself.
CREATE OR REPLACE FUNCTION "public"."tasks_assign_number"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s text;
BEGIN
  IF NEW."number" IS NULL OR NEW."number" <= 0
     OR (TG_OP = 'UPDATE' AND NEW."company_id" IS DISTINCT FROM OLD."company_id" AND NEW."number" = OLD."number") THEN
    s := CASE WHEN NEW."company_id" IS NULL THEN 'user:' || NEW."owner_user_id"::text ELSE 'company:' || NEW."company_id"::text END;
    INSERT INTO "task_key_counters" ("scope", "last_number") VALUES (s, 1)
    ON CONFLICT ("scope") DO UPDATE SET "last_number" = "task_key_counters"."last_number" + 1
    RETURNING "last_number" INTO NEW."number";
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "tasks_assign_number" BEFORE INSERT OR UPDATE OF "company_id" ON "tasks" FOR EACH ROW EXECUTE FUNCTION "public"."tasks_assign_number"();--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_key_uq" ON "tasks" USING btree ((coalesce("company_id"::text, 'user:' || "owner_user_id"::text)),"number");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tasks_parent_idx" ON "tasks" USING btree ("parent_task_id");--> statement-breakpoint

-- Labels.
CREATE TABLE "task_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#6B7280' NOT NULL,
	"sort" integer DEFAULT 100 NOT NULL,
	"seed_key" text,
	"created_by_user_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_labels_seed_key_unique" UNIQUE("seed_key"),
	CONSTRAINT "task_labels_name_ck" CHECK (length("task_labels"."name") between 1 and 40),
	CONSTRAINT "task_labels_color_ck" CHECK ("task_labels"."color" ~ '^#[0-9A-Fa-f]{6}$')
);
--> statement-breakpoint
CREATE TABLE "task_label_links" (
	"task_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_label_links_task_id_label_id_pk" PRIMARY KEY("task_id","label_id")
);
--> statement-breakpoint
ALTER TABLE "task_labels" ADD CONSTRAINT "task_labels_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_label_links" ADD CONSTRAINT "task_label_links_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_label_links" ADD CONSTRAINT "task_label_links_label_id_task_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."task_labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_labels_name_uq" ON "task_labels" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "task_label_links_label_idx" ON "task_label_links" USING btree ("label_id");--> statement-breakpoint
-- The founders' starting labels (renamed / recoloured / archived in Settings → Labels).
INSERT INTO "task_labels" ("name", "color", "sort", "seed_key") VALUES
  ('Operations', '#2563EB', 10, 'operations'),
  ('Improvement', '#16A34A', 20, 'improvement'),
  ('Automation', '#9333EA', 30, 'automation'),
  ('Production', '#EA580C', 40, 'production'),
  ('Photos', '#DB2777', 50, 'photos')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- RLS on the new tables like every other one (0002): no access for Supabase's client roles.
ALTER TABLE "task_key_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_labels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_label_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.task_key_counters, public.task_labels, public.task_label_links FROM anon;
    REVOKE ALL ON FUNCTION public.tasks_assign_number() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.task_key_counters, public.task_labels, public.task_label_links FROM authenticated;
    REVOKE ALL ON FUNCTION public.tasks_assign_number() FROM authenticated;
  END IF;
END $$;
