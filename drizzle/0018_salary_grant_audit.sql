-- Audit rows for salary access granted by the system (additive; deploy review #5).
-- Migration 0016 gave Talant salary access (and the seed grants both founders) without a
-- row in "salary_access_log". For every salary viewer whose grant has no founder behind it
-- ("granted_by" is empty) and who has no "grant_viewer" log row yet, one row is added:
-- actor = none (the system), scope 'system:migration', details say where it came from.
-- Re-running adds nothing (the NOT EXISTS check). No table or column is added.
INSERT INTO "salary_access_log" ("actor_user_id", "action", "scope", "target_user_id", "details", "created_at")
SELECT NULL, 'grant_viewer', 'system:migration', v."user_id",
       jsonb_build_object(
         'by', 'system',
         'source', 'migration 0016_founder_decisions / seed',
         'note', 'Salary access was granted by the system (the founders'' decision: both founders see salaries), not by a person in Settings. Audit row added by migration 0018.'
       ),
       v."created_at"
FROM "salary_viewers" v
WHERE v."granted_by" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "salary_access_log" l
    WHERE l."target_user_id" = v."user_id" AND l."action" = 'grant_viewer'
  );
