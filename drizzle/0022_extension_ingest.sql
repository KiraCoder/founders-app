ALTER TYPE "public"."metric_source" ADD VALUE 'extension';--> statement-breakpoint
CREATE TABLE "extension_ingest_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_id" uuid NOT NULL,
	"user_id" uuid,
	"adapter_id" text,
	"status" text NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"accepted" integer DEFAULT 0 NOT NULL,
	"rejected" integer DEFAULT 0 NOT NULL,
	"conflicts" integer DEFAULT 0 NOT NULL,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_ingest_log_status" CHECK ("extension_ingest_log"."status" in ('ok', 'invalid'))
);
--> statement-breakpoint
CREATE TABLE "extension_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "extension_ingest_log" ADD CONSTRAINT "extension_ingest_log_key_id_extension_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."extension_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_ingest_log" ADD CONSTRAINT "extension_ingest_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_keys" ADD CONSTRAINT "extension_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extension_ingest_log_key_idx" ON "extension_ingest_log" USING btree ("key_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "extension_keys_hash_uq" ON "extension_keys" USING btree ("key_hash");--> statement-breakpoint
-- RLS on the new tables like every other one (0002): no access for Supabase's client roles.
ALTER TABLE "extension_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "extension_ingest_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.extension_keys, public.extension_ingest_log FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.extension_keys, public.extension_ingest_log FROM authenticated;
  END IF;
END $$;
