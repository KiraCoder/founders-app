CREATE TYPE "public"."connector_run_status" AS ENUM('ok', 'not_configured', 'error');--> statement-breakpoint
CREATE TYPE "public"."metric_direction" AS ENUM('higher_is_better', 'lower_is_better', 'neutral');--> statement-breakpoint
CREATE TYPE "public"."metric_granularity" AS ENUM('day', 'week', 'month');--> statement-breakpoint
CREATE TYPE "public"."metric_source" AS ENUM('manual', 'upload', 'connector');--> statement-breakpoint
CREATE TABLE "connector_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" text NOT NULL,
	"company_id" uuid,
	"status" "connector_run_status" NOT NULL,
	"range_from" date NOT NULL,
	"range_to" date NOT NULL,
	"points_received" integer DEFAULT 0 NOT NULL,
	"values_written" integer DEFAULT 0 NOT NULL,
	"message" text,
	"triggered_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "metric_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"company_unit_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unit" text NOT NULL,
	"granularity" "metric_granularity" NOT NULL,
	"direction" "metric_direction" DEFAULT 'higher_is_better' NOT NULL,
	"due_days" integer,
	"target" numeric(18, 4),
	"source_kind" "metric_source" DEFAULT 'manual' NOT NULL,
	"connector_id" text,
	"sort" integer DEFAULT 100 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_definitions_company_unit_key_uq" UNIQUE NULLS NOT DISTINCT("company_id","company_unit_id","key"),
	CONSTRAINT "metric_definitions_due_days_range" CHECK ("metric_definitions"."due_days" is null or "metric_definitions"."due_days" between 0 and 60)
);
--> statement-breakpoint
CREATE TABLE "metric_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"metric_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"value" numeric(18, 4) NOT NULL,
	"source" "metric_source" NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"entered_by" uuid,
	"connector_run_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connector_runs" ADD CONSTRAINT "connector_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_runs" ADD CONSTRAINT "connector_runs_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_definitions" ADD CONSTRAINT "metric_definitions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_definitions" ADD CONSTRAINT "metric_definitions_company_unit_id_company_units_id_fk" FOREIGN KEY ("company_unit_id") REFERENCES "public"."company_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_values" ADD CONSTRAINT "metric_values_metric_id_metric_definitions_id_fk" FOREIGN KEY ("metric_id") REFERENCES "public"."metric_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_values" ADD CONSTRAINT "metric_values_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_runs_connector_idx" ON "connector_runs" USING btree ("connector_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "metric_values_current_uq" ON "metric_values" USING btree ("metric_id","period_start") WHERE "metric_values"."is_current";--> statement-breakpoint
CREATE INDEX "metric_values_metric_period_idx" ON "metric_values" USING btree ("metric_id","period_start");--> statement-breakpoint
-- New tables: lock them down like every other table (see 0002_rls_lockdown.sql). Server-only:
-- metrics are read and written only through the service layer (services/metrics.ts, connectors/).
ALTER TABLE "metric_definitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "metric_values" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "connector_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.metric_definitions, public.metric_values, public.connector_runs FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.metric_definitions, public.metric_values, public.connector_runs FROM authenticated;
  END IF;
END $$;
