import Link from "next/link";
import { NewPersonForm } from "@/components/people/PersonForm";
import { PageHeader } from "@/components/ui";
import { getPageContext } from "@/server/context";
import { listCompanyUnitOptions } from "@/server/services/people";
import { canViewSalaries } from "@/server/services/salaries";

export const metadata = { title: "New person" };

export default async function NewPersonPage({ searchParams }: { searchParams: Promise<{ companyId?: string }> }) {
  const ctx = await getPageContext();
  const { companyId } = await searchParams;
  const [options, showSalary] = await Promise.all([listCompanyUnitOptions(ctx), canViewSalaries(ctx)]);
  const companies = options.map((c) => ({ id: c.id, name: c.name, units: c.units.map((u) => ({ id: u.id, name: u.name })) }));
  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/people" className="hover:underline">
            People
          </Link>
        }
        title="New person"
      />
      <div className="max-w-3xl">
        <NewPersonForm companies={companies} showSalary={showSalary} defaultCompanyId={companies.some((c) => c.id === companyId) ? companyId : undefined} />
      </div>
    </>
  );
}
