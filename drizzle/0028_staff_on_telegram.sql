ALTER TYPE "public"."task_event_kind" ADD VALUE IF NOT EXISTS 'staff_reply';--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"author_user_id" uuid,
	"author_person_id" uuid,
	"text" text NOT NULL,
	"source" text DEFAULT 'app' NOT NULL,
	"kind" text DEFAULT 'comment' NOT NULL,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_comments_one_author" CHECK (("task_comments"."author_user_id" is null) <> ("task_comments"."author_person_id" is null)),
	CONSTRAINT "task_comments_source_ck" CHECK ("task_comments"."source" in ('app', 'telegram')),
	CONSTRAINT "task_comments_kind_ck" CHECK ("task_comments"."kind" in ('comment', 'help')),
	CONSTRAINT "task_comments_text_ck" CHECK (length("task_comments"."text") between 1 and 4000)
);
--> statement-breakpoint
CREATE TABLE "task_deadline_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"current_due_date" date,
	"proposed_due_date" date NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_deadline_requests_status_ck" CHECK ("task_deadline_requests"."status" in ('pending', 'approved', 'declined', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "notification_action_tokens" DROP CONSTRAINT "notification_action_tokens_subject";--> statement-breakpoint
ALTER TABLE "notification_action_tokens" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications_outbox" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_link_codes" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_links" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_action_tokens" ADD COLUMN "person_id" uuid;--> statement-breakpoint
ALTER TABLE "notification_action_tokens" ADD COLUMN "deadline_request_id" uuid;--> statement-breakpoint
ALTER TABLE "notification_action_tokens" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "notifications_outbox" ADD COLUMN "person_id" uuid;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "bot_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "bot_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "bot_paused_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "lang" text DEFAULT 'ru' NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "staff_chase" jsonb;--> statement-breakpoint
ALTER TABLE "task_events" ADD COLUMN "actor_person_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "staff_chase" jsonb;--> statement-breakpoint
ALTER TABLE "telegram_link_codes" ADD COLUMN "person_id" uuid;--> statement-breakpoint
ALTER TABLE "telegram_link_codes" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "telegram_links" ADD COLUMN "person_id" uuid;--> statement-breakpoint
ALTER TABLE "telegram_links" ADD COLUMN "stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_person_id_people_id_fk" FOREIGN KEY ("author_person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_deadline_requests" ADD CONSTRAINT "task_deadline_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_deadline_requests" ADD CONSTRAINT "task_deadline_requests_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_deadline_requests" ADD CONSTRAINT "task_deadline_requests_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_comments_task_idx" ON "task_comments" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_deadline_requests_task_idx" ON "task_deadline_requests" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_deadline_requests_one_pending_uq" ON "task_deadline_requests" USING btree ("task_id") WHERE "task_deadline_requests"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "notification_action_tokens" ADD CONSTRAINT "notification_action_tokens_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_action_tokens" ADD CONSTRAINT "notification_action_tokens_deadline_request_id_task_deadline_requests_id_fk" FOREIGN KEY ("deadline_request_id") REFERENCES "public"."task_deadline_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications_outbox" ADD CONSTRAINT "notifications_outbox_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_actor_person_id_people_id_fk" FOREIGN KEY ("actor_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_link_codes" ADD CONSTRAINT "telegram_link_codes_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_link_codes" ADD CONSTRAINT "telegram_link_codes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_action_tokens_person_idx" ON "notification_action_tokens" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "notifications_outbox_person_idx" ON "notifications_outbox" USING btree ("person_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_outbox_recipient_dedupe_uq" ON "notifications_outbox" USING btree (coalesce("user_id", "person_id"),"dedupe_key");--> statement-breakpoint
CREATE INDEX "telegram_link_codes_person_idx" ON "telegram_link_codes" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_links_person_uq" ON "telegram_links" USING btree ("person_id");--> statement-breakpoint
ALTER TABLE "notification_action_tokens" ADD CONSTRAINT "notification_action_tokens_one_owner" CHECK (("notification_action_tokens"."user_id" is null) <> ("notification_action_tokens"."person_id" is null));--> statement-breakpoint
ALTER TABLE "notification_action_tokens" ADD CONSTRAINT "notification_action_tokens_subject" CHECK ("notification_action_tokens"."task_id" is not null or "notification_action_tokens"."holding_ask_id" is not null or "notification_action_tokens"."deadline_request_id" is not null);--> statement-breakpoint
ALTER TABLE "notifications_outbox" ADD CONSTRAINT "notifications_outbox_one_recipient" CHECK (("notifications_outbox"."user_id" is null) <> ("notifications_outbox"."person_id" is null));--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_lang_ck" CHECK ("people"."lang" in ('ru'));--> statement-breakpoint
ALTER TABLE "telegram_link_codes" ADD CONSTRAINT "telegram_link_codes_one_owner" CHECK (("telegram_link_codes"."user_id" is null) <> ("telegram_link_codes"."person_id" is null));--> statement-breakpoint
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_one_owner" CHECK (("telegram_links"."user_id" is null) <> ("telegram_links"."person_id" is null));--> statement-breakpoint
-- Global staff chase defaults (Settings → Team on Telegram). The app falls back to the same values
-- in code (src/lib/staff-schemas.ts) when the row is missing.
INSERT INTO "app_settings" ("key", "value") VALUES ('staff_notification_defaults', '{"quietStart":"21:00","quietEnd":"08:00","workStart":"09:00","workEnd":"20:00","chaseEveryMinutes":120,"maxPerDay":12,"escalateAfterChases":3,"escalateAt":null,"morningList":false,"morningListTime":"09:00"}'::jsonb) ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
-- RLS on the new tables like every other one (0002): no access for Supabase's client roles.
ALTER TABLE "app_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task_deadline_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.app_settings, public.task_comments, public.task_deadline_requests FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.app_settings, public.task_comments, public.task_deadline_requests FROM authenticated;
  END IF;
END $$;
