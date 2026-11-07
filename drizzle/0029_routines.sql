CREATE TABLE "routine_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"routine_id" uuid NOT NULL,
	"run_date" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"items_done" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"done_at" timestamp with time zone,
	"last_chased_at" timestamp with time zone,
	"chase_count" integer DEFAULT 0 NOT NULL,
	"escalated_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routine_runs_status_ck" CHECK ("routine_runs"."status" in ('open', 'escalated', 'done', 'partly', 'missed'))
);
--> statement-breakpoint
CREATE TABLE "routines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"assignee_person_id" uuid,
	"assignee_user_id" uuid,
	"schedule_kind" text DEFAULT 'weekly' NOT NULL,
	"days" integer[],
	"month_day" integer,
	"time" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Bishkek' NOT NULL,
	"confirmation" text DEFAULT 'button' NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"chase" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"seed_key" text,
	"created_by_user_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routines_seed_key_unique" UNIQUE("seed_key"),
	CONSTRAINT "routines_one_assignee" CHECK (("routines"."assignee_person_id" is null) <> ("routines"."assignee_user_id" is null)),
	CONSTRAINT "routines_schedule_kind_ck" CHECK ("routines"."schedule_kind" in ('weekly', 'monthly')),
	CONSTRAINT "routines_confirmation_ck" CHECK ("routines"."confirmation" in ('button', 'checklist', 'number')),
	CONSTRAINT "routines_status_ck" CHECK ("routines"."status" in ('active', 'paused', 'archived')),
	CONSTRAINT "routines_month_day_ck" CHECK ("routines"."month_day" is null or "routines"."month_day" between 1 and 31)
);
--> statement-breakpoint
ALTER TABLE "notification_action_tokens" DROP CONSTRAINT "notification_action_tokens_subject";--> statement-breakpoint
ALTER TABLE "notification_action_tokens" ADD COLUMN "routine_run_id" uuid;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_assignee_person_id_people_id_fk" FOREIGN KEY ("assignee_person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "routine_runs_routine_day_uq" ON "routine_runs" USING btree ("routine_id","run_date");--> statement-breakpoint
CREATE INDEX "routine_runs_status_idx" ON "routine_runs" USING btree ("status","run_date");--> statement-breakpoint
CREATE INDEX "routines_company_idx" ON "routines" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "routines_person_idx" ON "routines" USING btree ("assignee_person_id");--> statement-breakpoint
ALTER TABLE "notification_action_tokens" ADD CONSTRAINT "notification_action_tokens_routine_run_id_routine_runs_id_fk" FOREIGN KEY ("routine_run_id") REFERENCES "public"."routine_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_action_tokens" ADD CONSTRAINT "notification_action_tokens_subject" CHECK ("notification_action_tokens"."task_id" is not null or "notification_action_tokens"."holding_ask_id" is not null or "notification_action_tokens"."deadline_request_id" is not null or "notification_action_tokens"."routine_run_id" is not null);--> statement-breakpoint
-- RLS on the new tables like every other one (0002): no access for Supabase's client roles.
ALTER TABLE "routines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "routine_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.routines, public.routine_runs FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.routines, public.routine_runs FROM authenticated;
  END IF;
END $$;
