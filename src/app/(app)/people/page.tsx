import Link from "next/link";
import { Icon } from "@/components/Icon";
import { PeopleTable } from "@/components/people/PeopleTable";
import { PageHeader, Tag } from "@/components/ui";
import { peopleFiltersSchema } from "@/lib/people-schemas";
import { getPageContext } from "@/server/context";
import { orgPositionsForPeople } from "@/server/services/org";
import { listCompanyUnitOptions, listPeople } from "@/server/services/people";
import { canViewSalaries } from "@/server/services/salaries";

export const metadata = { title: "People" };

type SP = Promise<Record<string, string | undefined>>;

export default async function PeoplePage({ searchParams }: { searchParams: SP }) {
  const ctx = await getPageContext();
  const sp = await searchParams;
  const parsed = peopleFiltersSchema.safeParse({ q: sp.q, companyId: sp.companyId, unitId: sp.unitId, status: sp.status });
  const filters = parsed.success ? parsed.data : {};
  const [options, showSalary] = await Promise.all([listCompanyUnitOptions(ctx), canViewSalaries(ctx)]);
  const people = await listPeople(ctx, filters, { salaryScope: "people_list" });
  const positions = await orgPositionsForPeople(ctx, people.map((p) => p.id));
  const status = filters.status ?? "active";

  return (
    <>
      <PageHeader
        eyebrow="Group"
        title="People"
        actions={
          <>
            <Link href="/people/import" className="btn">
              Import Excel / CSV
            </Link>
            <Link href="/people/new" className="btn btn-primary">
              <Icon name="plus" size={16} /> New person
            </Link>
          </>
        }
      >
        <p className="mt-1 text-[13px] text-muted">
          One shared list across companies.{" "}
          {showSalary ? (
            <span>
              <Tag tone="warn">
                <Icon name="lock" size={12} /> Salaries visible to you
              </Tag>{" "}
              Views and changes are logged.
            </span>
          ) : (
            "Salaries are restricted."
          )}
        </p>
      </PageHeader>

      <form action="/people" className="card mb-4 grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-[1fr_200px_200px_140px_auto]" role="search" aria-label="Filter people">
        <input name="q" defaultValue={filters.q ?? ""} type="search" className="input" placeholder="Name, phone, role…" aria-label="Search people" />
        <select name="companyId" defaultValue={filters.companyId ?? ""} className="input" aria-label="Company">
          <option value="">All companies</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select name="unitId" defaultValue={filters.unitId ?? ""} className="input" aria-label="Unit">
          <option value="">All units</option>
          {options
            .filter((c) => c.units.length > 0)
            .map((c) => (
              <optgroup key={c.id} label={c.name}>
                {c.units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </optgroup>
            ))}
        </select>
        <select name="status" defaultValue={status} className="input" aria-label="Status">
          <option value="active">Active</option>
          <option value="left">Left</option>
          <option value="all">All</option>
        </select>
        <button className="btn" type="submit">
          Filter
        </button>
      </form>

      <p className="mb-2 text-[12px] text-muted">
        <span className="num">{people.length}</span> {people.length === 1 ? "person" : "people"}
      </p>
      <PeopleTable people={people} showSalary={showSalary} positions={positions} />
    </>
  );
}
