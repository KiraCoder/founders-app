CREATE TABLE "client_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"client_name" text NOT NULL,
	"title" text NOT NULL,
	"stage" text DEFAULT 'lead' NOT NULL,
	"status" text DEFAULT 'on_track' NOT NULL,
	"start_date" date,
	"due_date" date,
	"sla_monthly_fee" numeric(14, 2),
	"sla_currency" text DEFAULT 'KGS' NOT NULL,
	"sla_response_hours" integer,
	"next_invoice_date" date,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_projects_stage_ck" CHECK ("client_projects"."stage" in ('lead','discovery','build','implementation','live_sla','paused','closed')),
	CONSTRAINT "client_projects_status_ck" CHECK ("client_projects"."status" in ('on_track','at_risk','late')),
	CONSTRAINT "client_projects_currency_ck" CHECK ("client_projects"."sla_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "org_journey_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"label" text NOT NULL,
	"department_id" uuid,
	"sort" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chart_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"person_id" uuid,
	"hiring" boolean DEFAULT false NOT NULL,
	"hiring_role_title" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_posts_holder_ck" CHECK (not ("org_posts"."hiring" and "org_posts"."person_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "companies" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "companies" ALTER COLUMN "kind" SET DATA TYPE text USING "kind"::text;--> statement-breakpoint
ALTER TABLE "companies" ALTER COLUMN "kind" SET DEFAULT 'generic';--> statement-breakpoint
ALTER TABLE "client_projects" ADD CONSTRAINT "client_projects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_journey_steps" ADD CONSTRAINT "org_journey_steps_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_journey_steps" ADD CONSTRAINT "org_journey_steps_department_id_org_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."org_departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_posts" ADD CONSTRAINT "org_posts_chart_id_org_charts_id_fk" FOREIGN KEY ("chart_id") REFERENCES "public"."org_charts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_posts" ADD CONSTRAINT "org_posts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_posts" ADD CONSTRAINT "org_posts_department_id_org_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."org_departments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_posts" ADD CONSTRAINT "org_posts_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_posts" ADD CONSTRAINT "org_posts_chart_company_fk" FOREIGN KEY ("chart_id","company_id") REFERENCES "public"."org_charts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_posts" ADD CONSTRAINT "org_posts_department_chart_fk" FOREIGN KEY ("department_id","chart_id") REFERENCES "public"."org_departments"("id","chart_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_projects_company_idx" ON "client_projects" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "org_journey_steps_company_idx" ON "org_journey_steps" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "org_posts_department_idx" ON "org_posts" USING btree ("department_id");--> statement-breakpoint
DROP TYPE "public"."company_kind";--> statement-breakpoint
-- Dashboard template per company (0027). Known group companies get their kind; everything else is generic.
UPDATE "companies" SET "kind" = CASE "slug"
  WHEN 'jobutify' THEN 'it_services'
  WHEN 'alura-style' THEN 'factory'
  WHEN 'alura-brand' THEN 'brand_sales'
  WHEN 'upsell-group' THEN 'sales_partners'
  WHEN 'kiwi-go' THEN 'courier'
  ELSE 'generic' END;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_kind_ck" CHECK ("kind" in ('it_services','factory','brand_sales','sales_partners','courier','generic'));--> statement-breakpoint
-- RLS on the new tables like every other one (0002): no access for Supabase's client roles.
ALTER TABLE "client_projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_posts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_journey_steps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.client_projects, public.org_posts, public.org_journey_steps FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.client_projects, public.org_posts, public.org_journey_steps FROM authenticated;
  END IF;
END $$;
