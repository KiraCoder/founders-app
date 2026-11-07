ALTER TABLE "task_events" ADD COLUMN "visibility" "task_visibility" DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_events" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill (C1 review finding 4). Existing rows got the safe default 'private' above.
-- 1) Events of existing tasks: copy the task's current visibility and owner.
UPDATE "task_events" e SET "visibility" = t."visibility", "owner_user_id" = t."owner_user_id"
FROM "tasks" t WHERE e."task_id" = t."id";--> statement-breakpoint
-- 2) "deleted" events keep the snapshot taken at delete time (old_value.visibility/ownerUserId).
UPDATE "task_events" e SET
  "visibility" = CASE WHEN e."old_value"->>'visibility' = 'shared' THEN 'shared'::"task_visibility" ELSE 'private'::"task_visibility" END,
  "owner_user_id" = (SELECT u."id" FROM "users" u WHERE u."id"::text = e."old_value"->>'ownerUserId')
WHERE e."task_id" IS NULL AND e."kind" = 'deleted';--> statement-breakpoint
-- 3) Other events of already-deleted tasks cannot be linked to a snapshot: keep them
--    private and attribute them to the founder who made the change (who could see the
--    task at that time). Nobody else sees them.
UPDATE "task_events" SET "owner_user_id" = "actor_user_id"
WHERE "task_id" IS NULL AND "kind" <> 'deleted' AND "owner_user_id" IS NULL;
