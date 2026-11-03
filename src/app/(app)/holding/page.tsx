import { ActsGrid } from "@/components/holding/ActsGrid";
import { AskElmuratCard } from "@/components/holding/AskElmuratCard";
import { ContractsSection } from "@/components/holding/ContractsSection";
import { DebtsSection } from "@/components/holding/DebtsSection";
import { FlowsSection } from "@/components/holding/FlowsSection";
import { UploadsProvider } from "@/components/holding/uploads-context";
import { PageHeader, Section } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import { getPageContext } from "@/server/context";
import { listCompanies } from "@/server/services/companies";
import { today } from "@/server/services/context";
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

export default async function HoldingPage() {
  const ctx = await getPageContext();
  const todayIso = today(ctx);
  const [grid, contracts, debts, entries, flows, companies, archivedActs] = await Promise.all([
    getActsGrid(ctx),
    listContracts(ctx),
    getDebts(ctx),
    listLedgerEntries(ctx),
    listFlows(ctx, { includeArchived: true }),
    listCompanies(ctx),
    listArchivedFlowActs(ctx),
  ]);
  const ask = askCardFromGrid(grid);
  const uploads = fileUploadStatus();
  const expiring = contracts.filter((c) => c.warning).length;
  const liveFlows = flows.filter((f) => !f.archived);
  const companyOptions = companies.map((c) => ({ id: c.id, name: c.name }));

  return (
    <UploadsProvider value={uploads}>
      <PageHeader eyebrow="Group" title="Holding">
        <p className="mt-1 text-[13px] text-muted">Intercompany договоры, monthly акты приёма-передачи and debts between group companies.</p>
      </PageHeader>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat
          testId="stat-missing"
          label="Missing акты"
          value={String(grid.missing)}
          tone={grid.missing > 0 ? "risk" : "ok"}
          hint={grid.requested ? `${grid.requested} asked, waiting for Elmurat` : "All months since each flow started"}
        />
        <Stat
          testId="stat-contracts"
          label="Договоры expiring"
          value={String(expiring)}
          tone={expiring > 0 ? "warn" : "ok"}
          hint="Within 30 days or already ended"
        />
        <Stat
          testId="stat-debt"
          label="Intercompany debt"
          value={formatMoney(debts.total)}
          tone="ok"
          hint={`${debts.pairs.length} pair${debts.pairs.length === 1 ? "" : "s"} · as of today`}
        />
      </div>

      <Section title="Ask Elmurat" count={ask.missing.count + ask.waiting.count} tone="risk">
        <AskElmuratCard card={ask} today={todayIso} />
      </Section>

      <Section title="Акты приёма-передачи" count={grid.missing} tone="risk">
        <ActsGrid grid={grid} />
      </Section>

      <Section title="Debts between companies">
        <DebtsSection debts={debts} entries={entries} companies={companyOptions} today={todayIso} />
      </Section>

      <Section title="Договоры" count={expiring} tone="warn">
        <ContractsSection contracts={contracts} flows={liveFlows} />
      </Section>

      <Section title="Flows">
        <FlowsSection flows={flows} companies={companyOptions} archivedActs={archivedActs} />
      </Section>
    </UploadsProvider>
  );
}
