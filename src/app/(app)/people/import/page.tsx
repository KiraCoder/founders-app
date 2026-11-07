import Link from "next/link";
import { ImportWizard } from "@/components/people/ImportWizard";
import { PageHeader } from "@/components/ui";
import { getPageContext } from "@/server/context";
import { listCompanyUnitOptions } from "@/server/services/people";

export const metadata = { title: "Import people" };

export default async function ImportPeoplePage() {
  const ctx = await getPageContext();
  const companies = (await listCompanyUnitOptions(ctx)).map((c) => ({ id: c.id, name: c.name }));
  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/people" className="hover:underline">
            People
          </Link>
        }
        title="Import from Excel / CSV"
      >
        <p className="mt-1 max-w-2xl text-[13px] text-muted">
          Replaces the old Excel sheet. People are matched by name + phone, so importing the same file twice does not create
          duplicates. Existing values are never overwritten, only empty ones are filled.
        </p>
      </PageHeader>
      <ImportWizard companies={companies} />
    </>
  );
}
