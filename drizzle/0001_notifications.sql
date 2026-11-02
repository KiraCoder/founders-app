CREATE TYPE "public"."notification_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TABLE "notification_action_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"action" text NOT NULL,
	"outbox_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_action_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"morning_summary_time" text DEFAULT '08:30' NOT NULL,
	"evening_check_enabled" boolean DEFAULT true NOT NULL,
	"evening_check_time" text DEFAULT '19:00' NOT NULL,
	"quiet_start" text DEFAULT '21:00' NOT NULL,
	"quiet_end" text DEFAULT '08:00' NOT NULL,
	"max_other_per_day" integer DEFAULT 3 NOT NULL,
	"urgent_at_night" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminder_snoozes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"snoozed_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_link_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_link_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "telegram_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"chat_id" text NOT NULL,
	"telegram_user_id" text NOT NULL,
	"username" text,
	"first_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_links_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "telegram_links_chat_id_unique" UNIQUE("chat_id")
);
--> statement-breakpoint
ALTER TABLE "notifications_outbox" DROP CONSTRAINT "notifications_outbox_dedupe_key_unique";--> statement-breakpoint
ALTER TABLE "notifications_outbox" ALTER COLUMN "channel" SET DEFAULT 'auto';--> statement-breakpoint
ALTER TABLE "notifications_outbox" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications_outbox" ADD COLUMN "priority" "notification_priority" DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications_outbox" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications_outbox" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications_outbox" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "notifications_outbox" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications_outbox" ADD COLUMN "parked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications_outbox" ADD COLUMN "bundled_into_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications_outbox" ADD COLUMN "provider_message_id" text;--> statement-breakpoint
ALTER TABLE "notifications_outbox" ADD COLUMN "message" jsonb;--> statement-breakpoint
ALTER TABLE "notification_action_tokens" ADD CONSTRAINT "notification_action_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_action_tokens" ADD CONSTRAINT "notification_action_tokens_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_action_tokens" ADD CONSTRAINT "notification_action_tokens_outbox_id_notifications_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."notifications_outbox"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_snoozes" ADD CONSTRAINT "reminder_snoozes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_snoozes" ADD CONSTRAINT "reminder_snoozes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_link_codes" ADD CONSTRAINT "telegram_link_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_action_tokens_user_idx" ON "notification_action_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_snoozes_user_task_uq" ON "reminder_snoozes" USING btree ("user_id","task_id");--> statement-breakpoint
CREATE INDEX "telegram_link_codes_user_idx" ON "telegram_link_codes" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "notifications_outbox" ADD CONSTRAINT "notifications_outbox_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_outbox_user_idx" ON "notifications_outbox" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_outbox_user_dedupe_uq" ON "notifications_outbox" USING btree ("user_id","dedupe_key");