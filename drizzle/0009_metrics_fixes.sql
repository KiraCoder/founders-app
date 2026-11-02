CREATE TYPE "public"."metric_aggregation" AS ENUM('sum', 'avg', 'last');--> statement-breakpoint
ALTER TYPE "public"."connector_run_status" ADD VALUE 'running';--> statement-breakpoint
ALTER TABLE "connector_runs" ADD COLUMN "details" jsonb;--> statement-breakpoint
ALTER TABLE "metric_definitions" ADD COLUMN "aggregation" "metric_aggregation" DEFAULT 'sum' NOT NULL;--> statement-breakpoint
-- Existing definitions: percentages are averaged, people counts and balances take the last value.
UPDATE "metric_definitions" SET "aggregation" = 'avg', "updated_at" = now() WHERE "unit" = '%';--> statement-breakpoint
UPDATE "metric_definitions" SET "aggregation" = 'last', "updated_at" = now() WHERE "unit" = 'people' OR "key" = 'intercompany_debt';--> statement-breakpoint
-- A value may only point at a run that exists (no table was deleted before, this is a guard).
UPDATE "metric_values" v SET "connector_run_id" = NULL
WHERE v."connector_run_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "connector_runs" r WHERE r."id" = v."connector_run_id");--> statement-breakpoint
ALTER TABLE "metric_values" ADD CONSTRAINT "metric_values_connector_run_id_connector_runs_id_fk" FOREIGN KEY ("connector_run_id") REFERENCES "public"."connector_runs"("id") ON DELETE set null ON UPDATE no action;
