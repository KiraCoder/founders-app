import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { companyTypeFor, ORG_STRUCTURE_EXPERT, summaryLineDueOn, type Schedule } from "@/lib/ai-roles";
import { orgExpertSummaryLine, type OrgExpertOptions } from "@/lib/org";
import { aiRoleHires, companies, type AiHireSettingsJson } from "@/server/db/schema";
import { listFounders } from "@/server/notifications/founders";
import type { MessageLine } from "@/server/notifications/types";
import { canUseAiRoles } from "./access";
import { disabledOrgRules, hireChecks, resolveRole, roleDefaultSettings } from "./ai-role-defs";
import { appUrl } from "./ai-roles";
import { today, type ServiceContext } from "./context";
import { orgExpertForCompany, type OrgExpertResult } from "./org";

export interface OrgExpertHire {
  companyId: string;
  slug: string;
  recipients: string[];
  schedule: Schedule;
  /** The tuned checks (limit, overdue threshold, checks turned off). */
  options: OrgExpertOptions;
}

/** Active Org Structure Expert hires (company, tuned checks, schedule, recipients). */
export async function orgExpertHires(ctx: ServiceContext): Promise<OrgExpertHire[]> {
  const rows = await ctx.db
    .select({ companyId: aiRoleHires.companyId, settings: aiRoleHires.settings, slug: companies.slug })
    .from(aiRoleHires)
    .innerJoin(companies, eq(companies.id, aiRoleHires.companyId))
    .where(and(eq(aiRoleHires.templateKey, ORG_STRUCTURE_EXPERT), eq(aiRoleHires.status, "active"), isNull(companies.archivedAt)))
    .orderBy(asc(companies.sort));
  if (!rows.length) return [];
  const founders = (await listFounders(ctx.db)).map((f) => f.id);
  const role = (await resolveRole(ctx.db, ORG_STRUCTURE_EXPERT))!;
  return rows.map((r) => {
    const s = (r.settings ?? {}) as Partial<AiHireSettingsJson>;
    const d = roleDefaultSettings(role, companyTypeFor(r.slug), founders);
    let schedule: Schedule = s.schedule ?? d.schedule;
    // Before 0021 the stored "monthly 1" meant Mondays.
    if (schedule.kind === "monthly" && schedule.day === 1) schedule = { kind: "weekly", weekday: 1 };
    const checks = hireChecks(role, { checks: s.checks, thresholds: s.thresholds ?? d.thresholds, maxDepartmentsPerHead: s.maxDepartmentsPerHead ?? d.maxDepartmentsPerHead });
    return {
      companyId: r.companyId,
      slug: r.slug,
      recipients: s.recipients?.length ? s.recipients : d.recipients,
      schedule,
      options: optionsFrom(checks),
    };
  });
}

function optionsFrom(checks: ReturnType<typeof hireChecks>): OrgExpertOptions {
  const max = checks.head_overloaded?.maxDepartments;
  const overdue = checks.overdue_tasks?.minTasks;
  return {
    ...(typeof max === "number" ? { maxDepartmentsPerHead: max } : {}),
    ...(typeof overdue === "number" ? { overdueTasksMin: overdue } : {}),
    disabled: disabledOrgRules(checks),
  };
}

/**
 * The checks the org board and the AI roles page show for a company: the hired expert's
 * tuned checks when it is hired there, otherwise the role's (template-level) checks.
 */
export async function orgExpertOptionsFor(ctx: ServiceContext, companyId: string): Promise<OrgExpertOptions> {
  const hire = (await orgExpertHires(ctx)).find((h) => h.companyId === companyId);
  if (hire) return hire.options;
  const role = await resolveRole(ctx.db, ORG_STRUCTURE_EXPERT);
  if (!role) return {};
  return optionsFrom(hireChecks(role, { thresholds: { changePct: 20, riskChangePct: 50 }, maxDepartmentsPerHead: undefined }));
}

/**
 * The Org Structure Expert's report: on its schedule (default Mondays, app timezone) ONE
 * line in the morning summary of each founder who receives its reports, covering every
 * company it is hired for — and only when something needs attention (warnings; stale
 * numbers are left to "Numbers waiting", info findings to the board). Computed when the
 * summary is built, so nothing is queued: an undelivered summary never stacks up org lines,
 * and no separate push is sent.
 */
export async function orgExpertSummaryLines(ctx: ServiceContext): Promise<MessageLine[]> {
  if (!canUseAiRoles(ctx)) return [];
  const day = today(ctx);
  const hires = (await orgExpertHires(ctx)).filter((h) => h.recipients.includes(ctx.user.id) && summaryLineDueOn(day, h.schedule));
  if (!hires.length) return [];
  const results: OrgExpertResult[] = [];
  for (const h of hires) results.push(...(await orgExpertForCompany(ctx, h.companyId, h.options)));
  const href = appUrl(hires.length === 1 ? `/org?company=${hires[0]!.slug}` : "/org");
  const line = orgExpertSummaryLine(
    results.map((r) => ({ companyName: r.scopeName, findings: r.findings })),
    href,
  );
  return line ? [{ text: line, style: "item" }] : [];
}
