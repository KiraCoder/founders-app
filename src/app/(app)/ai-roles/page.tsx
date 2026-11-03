import { AiRolesBoard, type BoardHire, type BoardTemplate } from "@/components/ai-roles/AiRolesBoard";
import type { WizardCompany, WizardTarget } from "@/components/ai-roles/HireWizard";
import { PageHeader } from "@/components/ui";
import { COMPANY_TYPE_LABELS, companyTypeFor, requiredKeysFor, scheduleLabel } from "@/lib/ai-roles";
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
    scheduleLabel: scheduleLabel(t.defaultSchedule),
  }));
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
      <AiRolesBoard templates={boardTemplates} hires={boardHires} companies={wizardCompanies} founders={founders.map((f) => ({ id: f.id, shortName: f.shortName }))} initial={initial} />
    </>
  );
}
