ALTER TABLE "holding_files" ADD COLUMN "attached_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "holding_files_unattached_idx" ON "holding_files" USING btree ("created_at") WHERE "holding_files"."attached_at" is null;--> statement-breakpoint
-- Files already attached to an акт or a contract count as attached (never cleaned up).
UPDATE "holding_files" f SET "attached_at" = f."created_at"
WHERE EXISTS (SELECT 1 FROM "intercompany_acts" a WHERE a."attachment_file_id" = f."id")
   OR EXISTS (SELECT 1 FROM "intercompany_contracts" c WHERE c."attachment_file_id" = f."id");
