import { cache } from "react";
import { ActsGrid } from "@/components/holding/ActsGrid";
import { AskCard } from "@/components/holding/AskCard";
import { ContractsSection } from "@/components/holding/ContractsSection";
import { DebtsSection } from "@/components/holding/DebtsSection";
import { FlowsSection } from "@/components/holding/FlowsSection";
import { UploadsProvider } from "@/components/holding/uploads-context";
import { PageHeader, Section } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import { getPageContext } from "@/server/context";
import { listCompanies } from "@/server/services/companies";
import { today, type ServiceContext } from "@/server/services/context";
import { getActsGrid, getDebts, listArchivedFlowActs, listContracts, listFlows, listLedgerEntries } from "@/server/services/holding";
import { askCardFromGrid } from "@/server/services/holding-asks";
import { fileUploadStatus } from "@/server/storage/file-storage";

export const metadata = { title: "Holding" };
export const dynamic = "force-dynamic";

function Stat({ label, value, tone, hint, testId }: { label: string; value: string; tone: "ok" | "warn" | "risk"; hint: string; testId: string }) {
  const cls = tone === "risk" ? "border-risk-line bg-risk-soft" : tone === "warn" ? "border-warn-line bg-warn-soft" : "";
  return (
    <div className={`card flex flex-col gap-0.5 px-4 py-3 ${cls}`} data-testid={testId}>
      <p className="eyebrow">{label}</p>
      <p className="num text-[22px] font-semibold leading-7">{value}</p>
      <p className="text-[12px] text-muted">{hint}</p>
    </div>
  );
}

// Per request (React `cache`): several sections need the same reads; the services below them
// also share one read of companies, flows and people per request.
const grid = cache((ctx: ServiceContext) => getActsGrid(ctx));
const contracts = cache((ctx: ServiceContext) => listContracts(ctx));
const debts = cache((ctx: ServiceContext) => getDebts(ctx));
const companyOptions = cache(async (ctx: ServiceContext) => (await listCompanies(ctx)).map((c) => ({ id: c.id, name: c.name })));

/**
 * One async component per section; they share every read through the per-request caches above.
 * Deliberately NOT wrapped in <Suspense>: every section is driven by server actions followed by
 * router.refresh(), and with streamed boundaries the refreshed grid sometimes kept showing the old
 * cells (e2e holding / org specs, 2 of 3 runs). The page renders in one pass.
 */
export default async function HoldingPage() {
  const ctx = await getPageContext();
  const uploads = fileUploadStatus();

  return (
    <UploadsProvider value={uploads}>
      <PageHeader eyebrow="Group" title="Holding">
        <p className="mt-1 text-[13px] text-muted">Intercompany договоры, monthly акты приёма-передачи and debts between group companies.</p>
      </PageHeader>
      <HoldingStats ctx={ctx} />
      <ActsSections ctx={ctx} />
      <DebtsBlock ctx={ctx} />
      <ContractsBlock ctx={ctx} />
      <FlowsBlock ctx={ctx} />
    </UploadsProvider>
  );
}

async function HoldingStats({ ctx }: { ctx: ServiceContext }) {
  const [g, c, d] = await Promise.all([grid(ctx), contracts(ctx), debts(ctx)]);
  const expiring = c.filter((x) => x.warning).length;
  return (
    <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Stat
        testId="stat-missing"
        label="Missing акты"
        value={String(g.missing)}
        tone={g.missing > 0 ? "risk" : "ok"}
        hint={g.requested ? `${g.requested} asked, waiting for the акты` : "All months since each flow started"}
      />
      <Stat testId="stat-contracts" label="Договоры expiring" value={String(expiring)} tone={expiring > 0 ? "warn" : "ok"} hint="Within 30 days or already ended" />
      <Stat
        testId="stat-debt"
        label="Intercompany debt"
        value={formatMoney(d.total)}
        tone="ok"
        hint={`${d.pairs.length} pair${d.pairs.length === 1 ? "" : "s"} · as of today`}
      />
    </div>
  );
}

async function ActsSections({ ctx }: { ctx: ServiceContext }) {
  const g = await grid(ctx);
  const ask = askCardFromGrid(g);
  return (
    <>
      <Section title="Ask for акты" count={ask.missing.count + ask.waiting.count} tone="risk">
        <AskCard card={ask} today={today(ctx)} />
      </Section>
      <Section title="Акты приёма-передачи" count={g.missing} tone="risk">
        <ActsGrid grid={g} />
      </Section>
    </>
  );
}

async function DebtsBlock({ ctx }: { ctx: ServiceContext }) {
  const [d, entries, companies] = await Promise.all([debts(ctx), listLedgerEntries(ctx), companyOptions(ctx)]);
  return (
    <Section title="Debts between companies">
      <DebtsSection debts={d} entries={entries} companies={companies} today={today(ctx)} />
    </Section>
  );
}

async function ContractsBlock({ ctx }: { ctx: ServiceContext }) {
  const [c, flows] = await Promise.all([contracts(ctx), listFlows(ctx, { includeArchived: true })]);
  const expiring = c.filter((x) => x.warning).length;
  return (
    <Section title="Договоры" count={expiring} tone="warn">
      <ContractsSection contracts={c} flows={flows.filter((f) => !f.archived)} />
    </Section>
  );
}

async function FlowsBlock({ ctx }: { ctx: ServiceContext }) {
  const [flows, companies, archivedActs] = await Promise.all([listFlows(ctx, { includeArchived: true }), companyOptions(ctx), listArchivedFlowActs(ctx)]);
  return (
    <Section title="Flows">
      <FlowsSection flows={flows} companies={companies} archivedActs={archivedActs} />
    </Section>
  );
}
