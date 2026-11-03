import { AiRolesBoard, type BoardHire, type BoardTemplate } from "@/components/ai-roles/AiRolesBoard";
import type { WizardCompany, WizardTarget } from "@/components/ai-roles/HireWizard";
import { PageHeader } from "@/components/ui";
import Link from "next/link";
import { OrgExpertStrip } from "@/components/org/OrgExpertStrip";
import { COMPANY_TYPE_LABELS, companyTypeFor, requiredKeysFor, templateByKey, templateEngine, templateScheduleLabel } from "@/lib/ai-roles";
import { orgExpertForCompany } from "@/server/services/org";
import { providerStatus } from "@/server/ai/provider";
import { getPageContext } from "@/server/context";
import { canUseAiRoles } from "@/server/services/access";
import { companyMetricOptions, listHires, listTemplates } from "@/server/services/ai-roles";
import { listCompanies } from "@/server/services/companies";
import { listFounders } from "@/server/services/people";

export const metadata = { title: "AI roles" };

type Props = { searchParams: Promise<{ hire?: string; company?: string }> };

export default async function AiRolesPage({ searchParams }: Props) {
  const ctx = await getPageContext();
  if (!canUseAiRoles(ctx)) {
    return (
      <>
        <PageHeader eyebrow="Group" title="AI roles" />
        <div className="card px-4 py-6 text-center text-[13px] text-muted">Only the founders can see AI roles.</div>
      </>
    );
  }
  const { hire: hireParam, company: companyParam } = await searchParams;
  const [templates, hires, companies, founders] = await Promise.all([listTemplates(), listHires(ctx), listCompanies(ctx), listFounders(ctx)]);
  const provider = providerStatus();

  const metricsByCompany = new Map(await Promise.all(companies.map(async (c) => [c.id, await companyMetricOptions(ctx, c.id)] as const)));
  const wizardCompanies: Record<string, WizardCompany[]> = {};
  for (const t of templates.filter((x) => x.status === "available")) {
    wizardCompanies[t.key] = companies.map((c) => {
      const type = companyTypeFor(c.slug);
      const metrics = metricsByCompany.get(c.id) ?? [];
      const defaults = requiredKeysFor(t, type).filter((k) => metrics.some((m) => m.key === k));
      return {
        id: c.id,
        name: c.name,
        slug: c.slug,
        typeLabel: COMPANY_TYPE_LABELS[type],
        metrics,
        defaultKeys: defaults.length ? defaults : metrics.filter((m) => m.granularity === "month").map((m) => m.key),
        hiredId: hires.find((h) => h.templateKey === t.key && h.companyId === c.id)?.id ?? null,
      };
    });
  }

  const boardTemplates: BoardTemplate[] = templates.map((t) => ({
    key: t.key,
    name: t.name,
    description: t.description,
    status: t.status,
    responsibilities: t.responsibilities,
    reportSections: t.reportSections,
    scheduleLabel: templateScheduleLabel(t),
  }));
  // Org Structure Expert: its deterministic findings for every company (shown below and on hire cards).
  const orgResults = (await Promise.all(companies.map((c) => orgExpertForCompany(ctx, c.id)))).flat();
  const orgWarnings = (companyId: string) =>
    orgResults.filter((r) => r.companyId === companyId && r.chartId).reduce((n, r) => n + r.findings.filter((f) => f.severity === "warning").length, 0);
  const boardHires: BoardHire[] = hires.map((h) => {
    const metrics = metricsByCompany.get(h.companyId) ?? [];
    return {
      id: h.id,
      templateKey: h.templateKey,
      roleName: h.roleName,
      companyId: h.companyId,
      companyName: h.companyName,
      companySlug: h.companySlug,
      companyColor: h.companyColor,
      status: h.status,
      scheduleLabel: h.scheduleLabel,
      settings: h.settings,
      notes: h.notes,
      recipientNames: h.recipientNames,
      askNames: h.askNames,
      requiredLabels: h.settings.requiredMetricKeys.map((k) => metrics.find((m) => m.key === k)?.label ?? k),
      latestRun: h.latestRun ? { id: h.latestRun.id, periodLabel: h.latestRun.periodLabel, status: h.latestRun.status, summary: h.latestRun.summary } : null,
      engine: templateEngine(templateByKey(h.templateKey)),
      orgSummary:
        templateEngine(templateByKey(h.templateKey)) === "org_rules"
          ? orgResults.some((r) => r.companyId === h.companyId && r.chartId)
            ? `${orgWarnings(h.companyId) || "Nothing"} to fix on the org chart`
            : "No org chart yet — apply the template"
          : undefined,
    };
  });

  // Deep link from a company page: /ai-roles?hire=financial-analyst&company=<id> opens the wizard
  // (or Tune when that role is already hired there).
  let initial: WizardTarget | null = null;
  const template = templates.find((t) => t.key === hireParam && t.status === "available");
  if (template) {
    const existing = boardHires.find((h) => h.templateKey === template.key && h.companyId === companyParam);
    initial = existing
      ? { templateKey: template.key, roleName: template.name, hireId: existing.id, companyId: existing.companyId, settings: existing.settings, notes: existing.notes }
      : { templateKey: template.key, roleName: template.name, companyId: companies.some((c) => c.id === companyParam) ? companyParam : undefined };
  }

  return (
    <>
      <PageHeader eyebrow="Group" title="AI roles">
        <p className="mt-1 max-w-2xl text-[13px] text-muted">
          Hire an AI agent for a role in a company: what it is responsible for, which numbers it needs, how often it runs, whom it asks
          and who gets its reports. Tune it once, then it runs.
        </p>
      </PageHeader>
      <div className="card mb-5 flex flex-wrap items-center gap-2 px-4 py-3 text-[13px]" data-testid="ai-provider-status">
        <span className={`tag ${provider.configured ? "tag-ok" : "tag-info"}`}>AI provider: {provider.configured ? provider.id : "not chosen yet"}</span>
        <span className="text-muted">
          {provider.configured
            ? "Reports include an AI summary."
            : "Everything here works without it: the analysis is rule-based. The AI summary appears after the AI provider is chosen."}
          {provider.problem ? ` ${provider.problem}` : ""}
        </span>
      </div>
      <section className="mb-6" aria-labelledby="org-expert-heading" data-testid="org-expert-section">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 id="org-expert-heading" className="eyebrow">
            Org Structure Expert · checks
          </h2>
          <span className="text-[12px] text-muted">Rule-based, for every company with an org chart. Hire it to get one grouped line in Monday&apos;s summary.</span>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          {orgResults
            .filter((r) => r.chartId)
            .map((r) => (
              <div key={r.chartId} className="flex flex-col">
                <Link href={`/org?company=${r.companySlug}`} className="mb-1 text-[13px] font-semibold hover:underline">
                  {r.scopeName}
                </Link>
                <OrgExpertStrip findings={r.findings} compact />
              </div>
            ))}
          {!orgResults.some((r) => r.chartId) && <div className="card px-4 py-6 text-center text-[13px] text-muted">No company has an org chart yet.</div>}
        </div>
      </section>
      <AiRolesBoard templates={boardTemplates} hires={boardHires} companies={wizardCompanies} founders={founders.map((f) => ({ id: f.id, shortName: f.shortName }))} initial={initial} />
    </>
  );
}
