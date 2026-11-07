CREATE TYPE "public"."ai_hire_status" AS ENUM('active', 'paused');--> statement-breakpoint
CREATE TYPE "public"."ai_request_status" AS ENUM('active', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."ai_run_status" AS ENUM('waiting_for_data', 'ready', 'analysed', 'reported', 'failed');--> statement-breakpoint
CREATE TYPE "public"."ai_template_status" AS ENUM('available', 'coming_soon');--> statement-breakpoint
CREATE TABLE "ai_data_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hire_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"round_key" text NOT NULL,
	"status" "ai_request_status" DEFAULT 'active' NOT NULL,
	"created_on" date NOT NULL,
	"last_shown_on" date,
	"shown_count" integer DEFAULT 0 NOT NULL,
	"outbox_id" uuid,
	"reason" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_role_hires" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_key" text NOT NULL,
	"company_id" uuid NOT NULL,
	"status" "ai_hire_status" DEFAULT 'active' NOT NULL,
	"settings" jsonb NOT NULL,
	"notes" text,
	"hired_by" uuid,
	"hired_on" date NOT NULL,
	"paused_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_role_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hire_id" uuid NOT NULL,
	"period" date NOT NULL,
	"status" "ai_run_status" DEFAULT 'waiting_for_data' NOT NULL,
	"missing" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inputs_hash" text,
	"inputs" jsonb,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"narrative" text,
	"narrative_status" text,
	"provider" text,
	"error" text,
	"trigger" text DEFAULT 'schedule' NOT NULL,
	"analysed_at" timestamp with time zone,
	"reported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_role_runs_period_first" CHECK (extract(day from "ai_role_runs"."period") = 1)
);
--> statement-breakpoint
CREATE TABLE "ai_role_templates" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"status" "ai_template_status" DEFAULT 'coming_soon' NOT NULL,
	"responsibilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_data" jsonb NOT NULL,
	"default_schedule" jsonb NOT NULL,
	"report_sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort" integer DEFAULT 100 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_data_requests" ADD CONSTRAINT "ai_data_requests_hire_id_ai_role_hires_id_fk" FOREIGN KEY ("hire_id") REFERENCES "public"."ai_role_hires"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_data_requests" ADD CONSTRAINT "ai_data_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_data_requests" ADD CONSTRAINT "ai_data_requests_outbox_id_notifications_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."notifications_outbox"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_role_hires" ADD CONSTRAINT "ai_role_hires_template_key_ai_role_templates_key_fk" FOREIGN KEY ("template_key") REFERENCES "public"."ai_role_templates"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_role_hires" ADD CONSTRAINT "ai_role_hires_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_role_hires" ADD CONSTRAINT "ai_role_hires_hired_by_users_id_fk" FOREIGN KEY ("hired_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_role_runs" ADD CONSTRAINT "ai_role_runs_hire_id_ai_role_hires_id_fk" FOREIGN KEY ("hire_id") REFERENCES "public"."ai_role_hires"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_data_requests_round_uq" ON "ai_data_requests" USING btree ("hire_id","user_id","round_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_role_hires_template_company_uq" ON "ai_role_hires" USING btree ("template_key","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_role_runs_hire_period_uq" ON "ai_role_runs" USING btree ("hire_id","period");--> statement-breakpoint
ALTER TABLE "ai_role_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_role_hires" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_role_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_data_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.ai_role_templates, public.ai_role_hires, public.ai_role_runs, public.ai_data_requests FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.ai_role_templates, public.ai_role_hires, public.ai_role_runs, public.ai_data_requests FROM authenticated;
  END IF;
END $$;
