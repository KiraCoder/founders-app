CREATE TYPE "public"."intercompany_act_status" AS ENUM('missing', 'requested', 'received', 'signed', 'not_needed');--> statement-breakpoint
CREATE TYPE "public"."intercompany_contract_status" AS ENUM('draft', 'signed', 'expired', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."intercompany_flow_status" AS ENUM('active', 'planned');--> statement-breakpoint
CREATE TYPE "public"."holding_ask_kind" AS ENUM('ask', 'reminder');--> statement-breakpoint
CREATE TYPE "public"."holding_ask_status" AS ENUM('pending', 'shown', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."intercompany_ledger_kind" AS ENUM('opening', 'payment');--> statement-breakpoint
ALTER TYPE "public"."metric_source" ADD VALUE 'derived';--> statement-breakpoint
CREATE TABLE "holding_ask_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "holding_ask_kind" NOT NULL,
	"round_key" text NOT NULL,
	"cells" jsonb NOT NULL,
	"status" "holding_ask_status" DEFAULT 'pending' NOT NULL,
	"outbox_id" uuid,
	"shown_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holding_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage" text NOT NULL,
	"storage_key" text NOT NULL,
	"original_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_by" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holding_files_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "holding_files_type" CHECK ("holding_files"."content_type" in ('application/pdf', 'image/jpeg', 'image/png')),
	CONSTRAINT "holding_files_size" CHECK ("holding_files"."size_bytes" between 1 and 10485760)
);
--> statement-breakpoint
CREATE TABLE "intercompany_acts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flow_id" uuid NOT NULL,
	"period" date NOT NULL,
	"status" "intercompany_act_status" DEFAULT 'missing' NOT NULL,
	"requested_on" date,
	"requested_by" uuid,
	"amount" numeric(14, 2),
	"act_number" text,
	"act_date" date,
	"note" text,
	"attachment_file_id" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intercompany_acts_period_first" CHECK (extract(day from "intercompany_acts"."period") = 1),
	CONSTRAINT "intercompany_acts_amount_nonneg" CHECK ("intercompany_acts"."amount" is null or "intercompany_acts"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "intercompany_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flow_id" uuid NOT NULL,
	"number" text NOT NULL,
	"signed_on" date,
	"valid_until" date,
	"status" "intercompany_contract_status" DEFAULT 'draft' NOT NULL,
	"amount_terms" text,
	"attachment_file_id" uuid,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intercompany_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_company_id" uuid NOT NULL,
	"to_company_id" uuid NOT NULL,
	"service" text NOT NULL,
	"description" text,
	"since" date,
	"until" date,
	"status" "intercompany_flow_status" DEFAULT 'active' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intercompany_flows_two_companies" CHECK ("intercompany_flows"."from_company_id" <> "intercompany_flows"."to_company_id"),
	CONSTRAINT "intercompany_flows_dates" CHECK ("intercompany_flows"."until" is null or "intercompany_flows"."since" is null or "intercompany_flows"."until" >= "intercompany_flows"."since")
);
--> statement-breakpoint
CREATE TABLE "intercompany_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "intercompany_ledger_kind" NOT NULL,
	"debtor_company_id" uuid NOT NULL,
	"creditor_company_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"note" text,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intercompany_ledger_two_companies" CHECK ("intercompany_ledger_entries"."debtor_company_id" <> "intercompany_ledger_entries"."creditor_company_id"),
	CONSTRAINT "intercompany_ledger_amount_pos" CHECK ("intercompany_ledger_entries"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "notification_action_tokens" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_action_tokens" ADD COLUMN "holding_ask_id" uuid;--> statement-breakpoint
ALTER TABLE "holding_ask_items" ADD CONSTRAINT "holding_ask_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_ask_items" ADD CONSTRAINT "holding_ask_items_outbox_id_notifications_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."notifications_outbox"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_ask_items" ADD CONSTRAINT "holding_ask_items_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding_files" ADD CONSTRAINT "holding_files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_acts" ADD CONSTRAINT "intercompany_acts_flow_id_intercompany_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."intercompany_flows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_acts" ADD CONSTRAINT "intercompany_acts_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_acts" ADD CONSTRAINT "intercompany_acts_attachment_file_id_holding_files_id_fk" FOREIGN KEY ("attachment_file_id") REFERENCES "public"."holding_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_acts" ADD CONSTRAINT "intercompany_acts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_contracts" ADD CONSTRAINT "intercompany_contracts_flow_id_intercompany_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."intercompany_flows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_contracts" ADD CONSTRAINT "intercompany_contracts_attachment_file_id_holding_files_id_fk" FOREIGN KEY ("attachment_file_id") REFERENCES "public"."holding_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_contracts" ADD CONSTRAINT "intercompany_contracts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_flows" ADD CONSTRAINT "intercompany_flows_from_company_id_companies_id_fk" FOREIGN KEY ("from_company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_flows" ADD CONSTRAINT "intercompany_flows_to_company_id_companies_id_fk" FOREIGN KEY ("to_company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_flows" ADD CONSTRAINT "intercompany_flows_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_ledger_entries" ADD CONSTRAINT "intercompany_ledger_entries_debtor_company_id_companies_id_fk" FOREIGN KEY ("debtor_company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_ledger_entries" ADD CONSTRAINT "intercompany_ledger_entries_creditor_company_id_companies_id_fk" FOREIGN KEY ("creditor_company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_ledger_entries" ADD CONSTRAINT "intercompany_ledger_entries_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_ledger_entries" ADD CONSTRAINT "intercompany_ledger_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "holding_ask_items_round_uq" ON "holding_ask_items" USING btree ("user_id","kind","round_key");--> statement-breakpoint
CREATE UNIQUE INDEX "intercompany_acts_flow_period_uq" ON "intercompany_acts" USING btree ("flow_id","period");--> statement-breakpoint
CREATE INDEX "intercompany_contracts_flow_idx" ON "intercompany_contracts" USING btree ("flow_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intercompany_flows_live_uq" ON "intercompany_flows" USING btree ("from_company_id","to_company_id",lower("service")) WHERE "intercompany_flows"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "intercompany_ledger_pair_idx" ON "intercompany_ledger_entries" USING btree ("debtor_company_id","creditor_company_id");--> statement-breakpoint
ALTER TABLE "notification_action_tokens" ADD CONSTRAINT "notification_action_tokens_holding_ask_id_holding_ask_items_id_fk" FOREIGN KEY ("holding_ask_id") REFERENCES "public"."holding_ask_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_action_tokens" ADD CONSTRAINT "notification_action_tokens_subject" CHECK ("notification_action_tokens"."task_id" is not null or "notification_action_tokens"."holding_ask_id" is not null);--> statement-breakpoint
-- New tables: lock them down like every other table (see 0002_rls_lockdown.sql). Server-only:
-- holding data is read and written only through the service layer (services/holding.ts).
ALTER TABLE "holding_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intercompany_flows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intercompany_contracts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intercompany_acts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "intercompany_ledger_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "holding_ask_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.holding_files, public.intercompany_flows, public.intercompany_contracts,
      public.intercompany_acts, public.intercompany_ledger_entries, public.holding_ask_items FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.holding_files, public.intercompany_flows, public.intercompany_contracts,
      public.intercompany_acts, public.intercompany_ledger_entries, public.holding_ask_items FROM authenticated;
  END IF;
END $$;
