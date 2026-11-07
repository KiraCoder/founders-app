ALTER TABLE "ai_role_runs" ADD COLUMN "settings_hash" text;--> statement-breakpoint
ALTER TABLE "ai_role_runs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_role_runs" ADD COLUMN "next_attempt_at" timestamp with time zone;