CREATE TABLE "ai_role_configs" (
	"key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"company_id" uuid,
	"based_on" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_role_configs_kind" CHECK ("ai_role_configs"."kind" in ('builtin', 'custom')),
	CONSTRAINT "ai_role_configs_custom_company" CHECK ("ai_role_configs"."kind" <> 'custom' or "ai_role_configs"."company_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "ai_role_settings_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_key" text NOT NULL,
	"role_key" text NOT NULL,
	"hire_id" uuid,
	"version" integer NOT NULL,
	"action" text NOT NULL,
	"reverted_to" integer,
	"before" jsonb,
	"after" jsonb NOT NULL,
	"changed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_role_settings_log_action" CHECK ("ai_role_settings_log"."action" in ('create', 'edit', 'revert'))
);
--> statement-breakpoint
ALTER TABLE "ai_role_configs" ADD CONSTRAINT "ai_role_configs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_role_configs" ADD CONSTRAINT "ai_role_configs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_role_configs" ADD CONSTRAINT "ai_role_configs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_role_settings_log" ADD CONSTRAINT "ai_role_settings_log_hire_id_ai_role_hires_id_fk" FOREIGN KEY ("hire_id") REFERENCES "public"."ai_role_hires"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_role_settings_log" ADD CONSTRAINT "ai_role_settings_log_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_role_settings_log_scope_version_uq" ON "ai_role_settings_log" USING btree ("scope_key","version");--> statement-breakpoint
-- RLS on the new tables like every other one (0002): no access for Supabase's client roles.
ALTER TABLE "ai_role_configs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_role_settings_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.ai_role_configs, public.ai_role_settings_log FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.ai_role_configs, public.ai_role_settings_log FROM authenticated;
  END IF;
END $$;--> statement-breakpoint
-- The Org Structure Expert's line has always gone out on Mondays; its schedule is now
-- editable, so existing hires (stored as monthly day 1, never used) say so explicitly.
UPDATE "ai_role_hires"
SET "settings" = jsonb_set("settings", '{schedule}', '{"kind": "weekly", "weekday": 1}'::jsonb)
WHERE "template_key" = 'org-structure-expert' AND "settings"->'schedule'->>'kind' = 'monthly';--> statement-breakpoint
UPDATE "ai_role_templates"
SET "default_schedule" = '{"kind": "weekly", "weekday": 1}'::jsonb
WHERE "key" = 'org-structure-expert';
