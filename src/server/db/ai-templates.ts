/**
 * The AI role catalogue in the database (kept apart from seed.ts so the AI roles service, which
 * every page loads for the agent panel, does not pull in the seed and its dependencies).
 * No "server-only": the seed (CLI) uses it too.
 */
import { ROLE_TEMPLATES } from "@/lib/ai-roles";
import type { Db } from "./connect";
import { aiRoleTemplates } from "./schema";

/**
 * Copies the AI role catalogue (src/lib/ai-roles.ts) into `ai_role_templates`: new roles
 * are added and existing ones updated to match the code. Idempotent; also called by the
 * hire service so a hire never fails on a database that was not re-seeded.
 */
export async function syncAiTemplates(db: Db): Promise<void> {
  for (const t of ROLE_TEMPLATES) {
    const values = {
      key: t.key,
      name: t.name,
      description: t.description,
      status: t.status,
      responsibilities: t.responsibilities,
      requiredData: { byCompanyType: t.requiredData as Record<string, string[]>, optionalUploads: t.optionalUploads },
      defaultSchedule: t.defaultSchedule,
      reportSections: t.reportSections,
      sort: t.sort,
    };
    const { key: _key, ...rest } = values;
    void _key;
    await db.insert(aiRoleTemplates).values(values).onConflictDoUpdate({ target: aiRoleTemplates.key, set: { ...rest, updatedAt: new Date() } });
  }
}
