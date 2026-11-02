ALTER TYPE "public"."outbox_status" ADD VALUE IF NOT EXISTS 'sending';--> statement-breakpoint
ALTER TYPE "public"."outbox_status" ADD VALUE IF NOT EXISTS 'not_linked';--> statement-breakpoint
ALTER TABLE "notifications_outbox" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
-- Repair any malformed row (only the service writes here, through Zod) before adding the checks.
UPDATE "notification_preferences" SET "morning_summary_time" = '08:30' WHERE "morning_summary_time" !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$';--> statement-breakpoint
UPDATE "notification_preferences" SET "evening_check_time" = '19:00' WHERE "evening_check_time" !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$';--> statement-breakpoint
UPDATE "notification_preferences" SET "quiet_start" = '21:00' WHERE "quiet_start" !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$';--> statement-breakpoint
UPDATE "notification_preferences" SET "quiet_end" = '08:00' WHERE "quiet_end" !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$';--> statement-breakpoint
UPDATE "notification_preferences" SET "max_other_per_day" = least(greatest("max_other_per_day", 0), 10) WHERE "max_other_per_day" NOT BETWEEN 0 AND 10;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_morning_hm" CHECK ("notification_preferences"."morning_summary_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_evening_hm" CHECK ("notification_preferences"."evening_check_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_quiet_start_hm" CHECK ("notification_preferences"."quiet_start" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_quiet_end_hm" CHECK ("notification_preferences"."quiet_end" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_max_other_range" CHECK ("notification_preferences"."max_other_per_day" between 0 and 10);