-- The founders' decisions (additive; no table or column added).
-- 1. Overdue chase style: "grouped" for both founders. New rows default to it, and saved rows
--    still on the old default "separate" move to it (a founder can switch back in Settings).
ALTER TABLE "notification_preferences" ALTER COLUMN "overdue_chase_style" SET DEFAULT 'grouped';--> statement-breakpoint
UPDATE "notification_preferences" SET "overdue_chase_style" = 'grouped', "updated_at" = now()
WHERE "overdue_chase_style" = 'separate';--> statement-breakpoint
-- 2. Both founders see salaries: add Talant (no-op before the founders are seeded; the seed
--    then adds both). Settings → Access still switches it off.
INSERT INTO "salary_viewers" ("user_id")
SELECT "id" FROM "users" WHERE "email" = 'talant@founders.local' AND "role" = 'founder'
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- 3. Financial Analyst hires accept monthly totals for daily numbers (new hires get it from
--    the code default).
UPDATE "ai_role_hires"
SET "settings" = jsonb_set("settings", '{acceptMonthlyTotals}', 'true'::jsonb, true), "updated_at" = now()
WHERE "template_key" = 'financial-analyst'
  AND ("settings" -> 'acceptMonthlyTotals') IS DISTINCT FROM 'true'::jsonb;
