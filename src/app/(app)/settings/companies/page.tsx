import Link from "next/link";
import { Suspense } from "react";
import { CompaniesManager, type CompanyRow } from "@/components/companies/CompaniesManager";
import { PageHeader } from "@/components/ui";
import { COMPANY_KINDS } from "@/server/db/schema";
import { getPageContext } from "@/server/context";
import {
  canManageCompanies,
  COMPANY_KIND_LABELS,
  describeUsage,
  listCompaniesForSettings,
} from "@/server/services/companies";

export const metadata = { title: "Companies · Settings" };

export default async function CompaniesSettingsPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const ctx = await getPageContext();
  const { new: openNew } = await searchParams;
  const header = (
    <PageHeader
      eyebrow={
        <Link href="/settings" className="hover:underline">
          Settings
        </Link>
      }
      title="Companies"
    />
  );
  if (!canManageCompanies(ctx)) {
    return (
      <>
        {header}
        <p className="text-[13px] text-muted">Only the founders can add, rename or archive companies.</p>
      </>
    );
  }

  const list = await listCompaniesForSettings(ctx);
  const rows: CompanyRow[] = list.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    kind: c.kind,
    kindLabel: COMPANY_KIND_LABELS[c.kind] ?? c.kind,
    color: c.color,
    legalName: c.legalName ?? "",
    description: c.description ?? "",
    archived: !!c.archivedAt,
    usage: describeUsage(c.usage),
    canDelete: c.canDelete,
  }));
  const kinds = COMPANY_KINDS.map((k) => ({ value: k, label: COMPANY_KIND_LABELS[k] }));

  return (
    <>
      {header}
      <p className="mb-4 text-[13px] text-muted">
        Add, rename, recolor and reorder companies. Archiving hides a company everywhere and keeps all its data; a company can
        be deleted for good only while nothing (tasks, people, numbers, projects, org chart, holding flows, client projects)
        refers to it.
      </p>
      <Suspense>
        <CompaniesManager companies={rows} kinds={kinds} openNew={openNew === "1"} />
      </Suspense>
    </>
  );
}
