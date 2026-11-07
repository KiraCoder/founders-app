CREATE TABLE "holding_ask_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_key" text NOT NULL,
	"flow_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"set_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holding_ask_overrides_round" CHECK ("holding_ask_overrides"."round_key" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
ALTER TABLE "intercompany_acts" ADD COLUMN "requested_person_id" uuid;--> statement-breakpoint
ALTER TABLE "intercompany_flows" ADD COLUMN "ask_person_id" uuid;--> statement-breakpoint
ALTER TABLE "holding_ask_overrides" ADD CONSTRAINT "holding_ask_overrides_flow_id_intercompany_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."intercompany_flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_ask_overrides" ADD CONSTRAINT "holding_ask_overrides_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_ask_overrides" ADD CONSTRAINT "holding_ask_overrides_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "holding_ask_overrides_round_flow_uq" ON "holding_ask_overrides" USING btree ("round_key","flow_id");--> statement-breakpoint
ALTER TABLE "intercompany_acts" ADD CONSTRAINT "intercompany_acts_requested_person_id_people_id_fk" FOREIGN KEY ("requested_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_flows" ADD CONSTRAINT "intercompany_flows_ask_person_id_people_id_fk" FOREIGN KEY ("ask_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- RLS on the new table like every other one (0002): no access for Supabase's client roles.
ALTER TABLE "holding_ask_overrides" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.holding_ask_overrides FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.holding_ask_overrides FROM authenticated;
  END IF;
END $$;--> statement-breakpoint
-- Existing flows: "who to ask" = the accountant of the flow's companies (an active link with
-- an accountant role or title, someone not marked as left and not an app user), the
-- providing company's first; none → stays empty (generic wording). Same rule as
-- defaultAskPersonId() in src/server/db/ask-person.ts.
UPDATE "intercompany_flows" f
SET "ask_person_id" = (
  SELECT p."id"
  FROM "person_companies" pc
  JOIN "people" p ON p."id" = pc."person_id"
  WHERE pc."company_id" IN (f."from_company_id", f."to_company_id")
    AND pc."is_active" AND p."left_at" IS NULL AND p."user_id" IS NULL
    AND (pc."role" ~* '(accountant|бухгалтер)' OR coalesce(pc."title", '') ~* '(accountant|бухгалтер)')
  ORDER BY (pc."company_id" = f."from_company_id") DESC, p."full_name", p."id"
  LIMIT 1
)
WHERE f."ask_person_id" IS NULL;--> statement-breakpoint
-- Акты already asked for were asked of that same person (until now the app only knew Elmurat).
UPDATE "intercompany_acts" a
SET "requested_person_id" = f."ask_person_id"
FROM "intercompany_flows" f
WHERE a."flow_id" = f."id" AND a."status" = 'requested' AND a."requested_person_id" IS NULL;
