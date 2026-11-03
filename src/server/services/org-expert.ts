import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { ORG_STRUCTURE_EXPERT } from "@/lib/ai-roles";
import { isoWeekday } from "@/lib/dates";
import { orgExpertSummaryLine } from "@/lib/org";
import { aiRoleHires, companies, type AiHireSettingsJson } from "@/server/db/schema";
import { listFounders } from "@/server/notifications/founders";
import type { MessageLine } from "@/server/notifications/types";
import { canUseAiRoles } from "./access";
import { appUrl } from "./ai-roles";
import { today, type ServiceContext } from "./context";
import { orgExpertForCompany, type OrgExpertResult } from "./org";

/** Active Org Structure Expert hires (company, tuned limit, recipients). */
export async function orgExpertHires(ctx: ServiceContext) {
  const rows = await ctx.db
    .select({ companyId: aiRoleHires.companyId, settings: aiRoleHires.settings, slug: companies.slug })
    .from(aiRoleHires)
    .innerJoin(companies, eq(companies.id, aiRoleHires.companyId))
    .where(and(eq(aiRoleHires.templateKey, ORG_STRUCTURE_EXPERT), eq(aiRoleHires.status, "active"), isNull(companies.archivedAt)))
    .orderBy(asc(companies.sort));
  const founders = (await listFounders(ctx.db)).map((f) => f.id);
  return rows.map((r) => {
    const s = (r.settings ?? {}) as Partial<AiHireSettingsJson>;
    return { companyId: r.companyId, slug: r.slug, recipients: s.recipients?.length ? s.recipients : founders, maxDepartmentsPerHead: s.maxDepartmentsPerHead };
  });
}

/**
 * The Org Structure Expert's weekly report: on Mondays (app timezone) ONE line in the morning
 * summary of each founder who receives its reports, covering every company it is hired for —
 * and only when something needs attention (warnings; stale numbers are left to "Numbers
 * waiting", info findings to the board). Computed when the summary is built, so nothing is
 * queued: an undelivered summary never stacks up org lines, and no separate push is sent.
 */
export async function orgExpertSummaryLines(ctx: ServiceContext): Promise<MessageLine[]> {
  if (!canUseAiRoles(ctx) || isoWeekday(today(ctx)) !== 1) return [];
  const hires = (await orgExpertHires(ctx)).filter((h) => h.recipients.includes(ctx.user.id));
  if (!hires.length) return [];
  const results: OrgExpertResult[] = [];
  for (const h of hires) results.push(...(await orgExpertForCompany(ctx, h.companyId, { maxDepartmentsPerHead: h.maxDepartmentsPerHead })));
  const href = appUrl(hires.length === 1 ? `/org?company=${hires[0]!.slug}` : "/org");
  const line = orgExpertSummaryLine(
    results.map((r) => ({ companyName: r.scopeName, findings: r.findings })),
    href,
  );
  return line ? [{ text: line, style: "item" }] : [];
}
