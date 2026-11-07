import { AiRolesBoard, type BoardHire, type BoardTemplate } from "@/components/ai-roles/AiRolesBoard";
import type { WizardCompany, WizardTarget } from "@/components/ai-roles/HireWizard";
import type { CopySource, EditorTarget, EditorVersion } from "@/components/ai-roles/RoleEditor";
import { defaultChecks } from "@/lib/ai-role-config";
import { formatDisplayDateTime } from "@/lib/dates";
import { settingsVersionsFor, type SettingsVersion } from "@/server/services/ai-role-editor";
import { orgExpertOptionsFor } from "@/server/services/org-expert";
import { PageHeader } from "@/components/ui";
import Link from "next/link";
import { OrgExpertStrip } from "@/components/org/OrgExpertStrip";
import { COMPANY_TYPE_LABELS, companyTypeFor, requiredKeysFor, templateScheduleLabel } from "@/lib/ai-roles";
import { orgExpertForCompany } from "@/server/services/org";
import { providerStatus } from "@/server/ai/provider";
import { getPageContext } from "@/server/context";
import { canUseAiRoles } from "@/server/services/access";
import { companyMetricOptionsByCompany, listHires, listRoles } from "@/server/services/ai-roles";
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
  const [templates, hires, companies, founders] = await Promise.all([listRoles(ctx), listHires(ctx), listCompanies(ctx), listFounders(ctx)]);
  const provider = providerStatus();
  const founderIds = founders.map((f) => f.id);
  const asVersions = (list: SettingsVersion[]): EditorVersion[] =>
    list.map((v) => ({ version: v.version, action: v.action, revertedTo: v.revertedTo, at: formatDisplayDateTime(v.at, ctx.timeZone), byName: v.byName, changed: v.changed }));
  // One read each for every role's and hire's settings history and every company's numbers
  // (the access checks use the per-request company list).
  const [versions, metricsByCompany] = await Promise.all([
    settingsVersionsFor(ctx, { roles: templates, hireIds: hires.map((h) => h.id) }),
    companyMetricOptionsByCompany(
      ctx,
      companies.map((c) => c.id),
    ),
  ]);
  const roleVersions = new Map([...versions.roles].map(([k, v]) => [k, asVersions(v)]));
  const hireVersions = new Map([...versions.hires].map(([k, v]) => [k, asVersions(v)]));
  const wizardCompanies: Record<string, WizardCompany[]> = {};
  for (const t of templates.filter((x) => x.status === "available" && !x.custom)) {
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

  const boardTemplates: BoardTemplate[] = templates.map((t) => {
    const p = t.config.profile ?? {};
    const editor: EditorTarget = {
      mode: "role",
      title: t.name,
      roleKey: t.key,
      engine: t.engine,
      custom: t.custom,
      identity: t.custom
        ? { name: t.name, description: t.description, responsibilities: t.responsibilities, instructions: t.instructions ?? "" }
        : { name: p.name ?? "", description: p.description ?? "", responsibilities: p.responsibilities ?? [], instructions: p.instructions ?? "" },
      inherited: t.base
        ? { name: t.base.name, description: t.base.description, responsibilities: t.base.responsibilities, instructions: "" }
        : { name: "", description: "", responsibilities: [], instructions: "" },
      schedule: t.defaultSchedule,
      recipients: t.config.recipients?.length ? t.config.recipients : founderIds,
      checks: t.checks,
      companyId: t.companyId ?? undefined,
      watched: t.custom ? t.watchedMetricKeys : undefined,
      required: t.custom ? (t.config.requiredMetricKeys ?? t.watchedMetricKeys) : undefined,
      ratioChecks: t.custom ? t.ratioChecks.map((r) => ({ ...r, min: r.min ?? null, max: r.max ?? null })) : undefined,
      versions: roleVersions.get(t.key) ?? [],
    };
    return {
      key: t.key,
      name: t.name,
      description: t.description,
      status: t.status,
      responsibilities: t.responsibilities,
      reportSections: t.reportSections,
      scheduleLabel: templateScheduleLabel(t),
      editor,
      custom: t.custom,
      companyId: t.companyId ?? undefined,
      companyName: companies.find((c) => c.id === t.companyId)?.name,
      hiredId: t.custom ? (hires.find((h) => h.templateKey === t.key)?.id ?? null) : undefined,
      edited: !t.custom && t.version > 0 && Object.keys(t.config).length > 0,
    };
  });
  const copySources: CopySource[] = templates
    .filter((t) => !t.custom && t.engine === "finance")
    .map((t) => ({
      key: t.key,
      name: t.name,
      description: t.description,
      responsibilities: t.responsibilities,
      instructions: t.instructions ?? "",
      schedule: t.defaultSchedule,
      checks: t.checks,
      keysByCompany: Object.fromEntries(
        companies.map((c) => {
          const metrics = metricsByCompany.get(c.id) ?? [];
          return [c.id, requiredKeysFor(t, companyTypeFor(c.slug)).filter((k) => metrics.some((m) => m.key === k && !m.payData))];
        }),
      ),
    }));
  // Org Structure Expert: its deterministic findings for every company (shown below and on hire cards).
  const orgResults = (
    await Promise.all(companies.map(async (c) => orgExpertForCompany(ctx, c.id, await orgExpertOptionsFor(ctx, c.id), { company: { slug: c.slug, name: c.name } })))
  ).flat();
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
      engine: h.engine,
      custom: h.custom,
      editor: hireEditor(h),
      orgSummary:
        h.engine === "org_rules"
          ? orgResults.some((r) => r.companyId === h.companyId && r.chartId)
            ? `${orgWarnings(h.companyId) || "Nothing"} to fix on the org chart`
            : "No org chart yet — apply the template"
          : undefined,
    };
  });

  function hireEditor(h: (typeof hires)[number]): EditorTarget {
    const own = h.settings.profile ?? {};
    const role = templates.find((t) => t.key === h.templateKey);
    return {
      mode: "hire",
      title: `${h.roleName} · ${h.companyName}`,
      hireId: h.id,
      roleKey: h.templateKey,
      engine: h.engine,
      custom: h.custom,
      identity: { name: own.name ?? "", description: own.description ?? "", responsibilities: own.responsibilities ?? [], instructions: own.instructions ?? "" },
      inherited: {
        name: h.roleBaseName,
        description: role?.description ?? "",
        responsibilities: role?.responsibilities ?? [],
        instructions: role?.instructions ?? "",
      },
      schedule: h.settings.schedule,
      recipients: h.settings.recipients,
      askUserIds: h.settings.askUserIds,
      checks: h.checks,
      ownChecks: !!h.settings.checks,
      companyId: h.companyId,
      notes: h.notes,
      versions: hireVersions.get(h.id) ?? [],
    };
  }

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
      <AiRolesBoard
        templates={boardTemplates}
        hires={boardHires}
        companies={wizardCompanies}
        founders={founders.map((f) => ({ id: f.id, shortName: f.shortName }))}
        initial={initial}
        editorCompanies={companies.map((c) => ({ id: c.id, name: c.name }))}
        metricsByCompany={Object.fromEntries(metricsByCompany)}
        copySources={copySources}
        defaultChecksCustom={defaultChecks("custom")}
      />
    </>
  );
}
