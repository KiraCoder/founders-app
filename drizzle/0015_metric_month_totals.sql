DROP INDEX "metric_values_current_uq";--> statement-breakpoint
ALTER TABLE "metric_values" ADD COLUMN "period_kind" text DEFAULT 'period' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "metric_values_current_uq" ON "metric_values" USING btree ("metric_id","period_start","period_kind") WHERE "metric_values"."is_current";--> statement-breakpoint
ALTER TABLE "metric_values" ADD CONSTRAINT "metric_values_period_kind" CHECK ("metric_values"."period_kind" in ('period', 'month_total'));--> statement-breakpoint
ALTER TABLE "metric_values" ADD CONSTRAINT "metric_values_month_total_first_day" CHECK ("metric_values"."period_kind" <> 'month_total' or extract(day from "metric_values"."period_start") = 1);