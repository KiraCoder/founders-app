import Link from "next/link";
import { FreshnessCounts } from "@/components/metrics/FreshnessRow";
import { CompanyDot, PageHeader, Tag } from "@/components/ui";
import { getPageContext } from "@/server/context";
import { listCompanyCards } from "@/server/services/companies";
import { companyFreshness } from "@/server/services/metrics";

export const metadata = { title: "Companies" };

const KIND_LABEL = { it_services: "IT services", factory: "Factory", brand_sales: "Brand & sales", sales_partners: "Sales partners", courier: "Courier", generic: "Company" } as const;

export default async function CompaniesPage() {
  const ctx = await getPageContext();
  const [cards, freshness] = await Promise.all([listCompanyCards(ctx), companyFreshness(ctx)]);
  const freshBy = new Map(freshness.map((f) => [f.companyId, f]));
  return (
    <>
      <PageHeader eyebrow="Asqa Zou group" title="Companies" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((c) => (
          <Link key={c.id} href={`/companies/${c.slug}`} className="card flex flex-col gap-3 p-4 hover:border-accent">
            <div className="flex items-start gap-2.5">
              <span className="mt-1.5">
                <CompanyDot color={c.color} size={10} />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-[15px] font-semibold">{c.name}</h2>
                <p className="text-[12px] text-muted">{c.legalName ?? KIND_LABEL[c.kind]}</p>
              </div>
              {c.status === "planned" ? <Tag tone="info">Planned</Tag> : <Tag>{KIND_LABEL[c.kind]}</Tag>}
            </div>
            {c.description && <p className="line-clamp-2 text-[13px] text-muted">{c.description}</p>}
            <dl className="mt-auto grid grid-cols-3 gap-2 border-t border-line pt-3">
              <Stat label="Open tasks" value={c.openTasks} />
              <Stat label="Overdue" value={c.overdueTasks} tone={c.overdueTasks > 0 ? "text-risk" : undefined} />
              <Stat label="Projects" value={c.activeProjects} />
            </dl>
            {freshBy.get(c.id) ? (
              <div className="flex items-center justify-between gap-2 border-t border-line pt-2.5">
                <span className="eyebrow">Numbers</span>
                <FreshnessCounts f={freshBy.get(c.id)!} />
              </div>
            ) : (
              <p className="border-t border-line pt-2.5 text-[12px] text-muted">No numbers tracked</p>
            )}
          </Link>
        ))}
      </div>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className={`num text-[18px] font-semibold ${tone ?? ""}`}>{value}</dd>
    </div>
  );
}
