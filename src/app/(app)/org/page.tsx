import Link from "next/link";
import { Suspense } from "react";
import { OrgWorkspace } from "@/components/org/OrgWorkspace";
import { CompanyDot, PageHeader } from "@/components/ui";
import { getPageContext } from "@/server/context";
import { getCompanyWithUnits, listCompanies } from "@/server/services/companies";

export const metadata = { title: "Org structure" };

type Props = { searchParams: Promise<{ company?: string; unit?: string; archived?: string }> };

/** Kiwi Go first (the founders' first example), then the sidebar order. */
const DEFAULT_COMPANY = "kiwi-go";

export default async function OrgStructurePage({ searchParams }: Props) {
  const ctx = await getPageContext();
  const q = await searchParams;
  const companies = await listCompanies(ctx);
  if (companies.length === 0) {
    return (
      <>
        <PageHeader eyebrow="Group" title="Org structure" />
        <div className="card px-4 py-6 text-center text-[13px] text-muted">No companies you can see.</div>
      </>
    );
  }
  const slug = companies.some((c) => c.slug === q.company) ? q.company! : companies.some((c) => c.slug === DEFAULT_COMPANY) ? DEFAULT_COMPANY : companies[0]!.slug;
  const company = await getCompanyWithUnits(ctx, slug);
  const unit = company.units.find((u) => u.slug === q.unit) ?? null;
  const showArchived = q.archived === "1";
  const hrefFor = ({ unit: u, archived }: { unit?: string | null; archived?: boolean }) => {
    const params = new URLSearchParams({ company: slug });
    const unitSlug = u === undefined ? unit?.slug : u;
    if (unitSlug) params.set("unit", unitSlug);
    if (archived ?? false) params.set("archived", "1");
    return `/org?${params.toString()}`;
  };

  return (
    <>
      <PageHeader eyebrow="Group" title="Org structure">
        <p className="mt-1 max-w-2xl text-[13px] text-muted">
          Vysotsky model: 7 divisions, 21 departments, functions and the people on them. Org content is in Russian.
        </p>
      </PageHeader>
      <nav className="-mx-4 mb-4 flex gap-1.5 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0" aria-label="Company">
        {companies.map((c) => (
          <Link
            key={c.id}
            href={`/org?company=${c.slug}`}
            aria-current={c.slug === slug ? "page" : undefined}
            className={`btn btn-sm shrink-0 ${c.slug === slug ? "border-accent bg-accent-soft" : ""}`}
          >
            <CompanyDot color={c.color} /> {c.name}
          </Link>
        ))}
      </nav>
      {/* Header and company switcher first; the board (chart, people, numbers, expert findings) streams in. */}
      <Suspense key={`${slug}:${unit?.id ?? ""}:${showArchived ? 1 : 0}`} fallback={<div className="card h-64 bg-sunk" aria-busy="true" data-testid="org-loading" />}>
        <OrgWorkspace ctx={ctx} company={company} unit={unit} showArchived={showArchived} hrefFor={hrefFor} />
      </Suspense>
    </>
  );
}
