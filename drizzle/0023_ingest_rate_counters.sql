CREATE TABLE "ingest_rate_counters" (
	"bucket" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"n" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ingest_rate_counters_bucket_window_start_pk" PRIMARY KEY("bucket","window_start")
);
--> statement-breakpoint
CREATE INDEX "ingest_rate_counters_window_idx" ON "ingest_rate_counters" USING btree ("window_start");--> statement-breakpoint
-- RLS on the new table like every other one (0002): no access for Supabase's client roles.
ALTER TABLE "ingest_rate_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.ingest_rate_counters FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.ingest_rate_counters FROM authenticated;
  END IF;
END $$;
