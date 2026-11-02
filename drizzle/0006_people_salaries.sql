CREATE TYPE "public"."employment_type" AS ENUM('staff', 'contractor', 'part_time');--> statement-breakpoint
CREATE TYPE "public"."salary_pay_type" AS ENUM('monthly', 'piecework', 'hourly');--> statement-breakpoint
CREATE TABLE "salaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_company_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text DEFAULT 'KGS' NOT NULL,
	"pay_type" "salary_pay_type" DEFAULT 'monthly' NOT NULL,
	"effective_from" date NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "salaries_amount_nonneg" CHECK ("salaries"."amount" >= 0),
	CONSTRAINT "salaries_currency_code" CHECK ("salaries"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "salary_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"scope" text NOT NULL,
	"person_id" uuid,
	"person_company_id" uuid,
	"target_user_id" uuid,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "salary_viewers" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "short_name" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "left_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "person_companies" ADD COLUMN "employment_type" "employment_type" DEFAULT 'staff' NOT NULL;--> statement-breakpoint
ALTER TABLE "person_companies" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "person_companies" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "salaries" ADD CONSTRAINT "salaries_person_company_id_person_companies_id_fk" FOREIGN KEY ("person_company_id") REFERENCES "public"."person_companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salaries" ADD CONSTRAINT "salaries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_access_log" ADD CONSTRAINT "salary_access_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_access_log" ADD CONSTRAINT "salary_access_log_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_access_log" ADD CONSTRAINT "salary_access_log_person_company_id_person_companies_id_fk" FOREIGN KEY ("person_company_id") REFERENCES "public"."person_companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_access_log" ADD CONSTRAINT "salary_access_log_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_viewers" ADD CONSTRAINT "salary_viewers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_viewers" ADD CONSTRAINT "salary_viewers_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "salaries_link_idx" ON "salaries" USING btree ("person_company_id","effective_from");--> statement-breakpoint
CREATE INDEX "salary_access_log_created_idx" ON "salary_access_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "people_full_name_idx" ON "people" USING btree ("full_name");--> statement-breakpoint
-- New tables: lock them down like every other table (see 0002_rls_lockdown.sql). Server-only:
-- salaries are read and written only through the service layer (salary viewers).
ALTER TABLE "salaries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "salary_viewers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "salary_access_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.salaries, public.salary_viewers, public.salary_access_log FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.salaries, public.salary_viewers, public.salary_access_log FROM authenticated;
  END IF;
END $$;--> statement-breakpoint
-- Default salary viewer: only Nuraaly (pending the founders' decision; changeable in
-- Settings → Access by an existing salary viewer). No-op before the founders are seeded;
-- the seed adds him then.
INSERT INTO "salary_viewers" ("user_id")
SELECT "id" FROM "users" WHERE "email" = 'nuraaly@founders.local'
ON CONFLICT DO NOTHING;
