CREATE TABLE "routine_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"routine_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"item_key" text,
	"kind" text DEFAULT 'comment' NOT NULL,
	"author_person_id" uuid,
	"author_user_id" uuid,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routine_comments_kind_ck" CHECK ("routine_comments"."kind" in ('comment', 'done', 'partly', 'cant'))
);
--> statement-breakpoint
ALTER TABLE "routines" DROP CONSTRAINT "routines_status_ck";--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "item_states" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "awaiting_comment" jsonb;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "times" text[];--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "starts_on" date;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "ends_on" date;--> statement-breakpoint
ALTER TABLE "routine_comments" ADD CONSTRAINT "routine_comments_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_comments" ADD CONSTRAINT "routine_comments_run_id_routine_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."routine_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_comments" ADD CONSTRAINT "routine_comments_author_person_id_people_id_fk" FOREIGN KEY ("author_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_comments" ADD CONSTRAINT "routine_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routine_comments_run_idx" ON "routine_comments" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "routine_comments_routine_idx" ON "routine_comments" USING btree ("routine_id","created_at");--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_status_ck" CHECK ("routines"."status" in ('active', 'paused', 'ended', 'archived'));--> statement-breakpoint
-- RLS on the new table like every other one (0002): no access for Supabase's client roles.
ALTER TABLE "routine_comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.routine_comments FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.routine_comments FROM authenticated;
  END IF;
END $$;
