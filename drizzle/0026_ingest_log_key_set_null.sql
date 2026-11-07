ALTER TABLE "extension_ingest_log" DROP CONSTRAINT "extension_ingest_log_key_id_extension_keys_id_fk";
--> statement-breakpoint
ALTER TABLE "extension_ingest_log" ALTER COLUMN "key_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "extension_ingest_log" ADD CONSTRAINT "extension_ingest_log_key_id_extension_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."extension_keys"("id") ON DELETE set null ON UPDATE no action;