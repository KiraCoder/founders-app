CREATE TABLE "task_checklist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"title" text NOT NULL,
	"details" text,
	"done_at" timestamp with time zone,
	"done_by_user_id" uuid,
	"done_by_person_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_checklist_items_title_ck" CHECK (length("task_checklist_items"."title") between 1 and 300),
	CONSTRAINT "task_checklist_items_details_ck" CHECK ("task_checklist_items"."details" is null or length("task_checklist_items"."details") <= 2000),
	CONSTRAINT "task_checklist_items_one_ticker" CHECK ("task_checklist_items"."done_by_user_id" is null or "task_checklist_items"."done_by_person_id" is null)
);
--> statement-breakpoint
ALTER TABLE "telegram_links" ADD COLUMN "pending_comment_task_id" uuid;--> statement-breakpoint
ALTER TABLE "telegram_links" ADD COLUMN "pending_comment_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_done_by_user_id_users_id_fk" FOREIGN KEY ("done_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_done_by_person_id_people_id_fk" FOREIGN KEY ("done_by_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_checklist_items_task_idx" ON "task_checklist_items" USING btree ("task_id","position");--> statement-breakpoint
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_pending_comment_task_id_tasks_id_fk" FOREIGN KEY ("pending_comment_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- RLS on the new table like every other one (0002): no access for Supabase's client roles.
ALTER TABLE "task_checklist_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.task_checklist_items FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.task_checklist_items FROM authenticated;
  END IF;
END $$;
