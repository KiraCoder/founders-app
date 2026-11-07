import Link from "next/link";
import { notFound } from "next/navigation";
import { NumbersImportWizard } from "@/components/metrics/NumbersImportWizard";
import { PageHeader } from "@/components/ui";
import { getPageContext } from "@/server/context";
import { getCompanyBySlug } from "@/server/services/companies";
import { ServiceError } from "@/server/services/errors";
import { listMetricDefinitions } from "@/server/services/metrics";

export const metadata = { title: "Upload numbers" };

type Props = { params: Promise<{ slug: string }> };

export default async function ImportNumbersPage({ params }: Props) {
  const { slug } = await params;
  const ctx = await getPageContext();
  let company;
  try {
    company = await getCompanyBySlug(ctx, slug);
  } catch (err) {
    if (err instanceof ServiceError && err.code === "not_found") notFound();
    throw err;
  }
  const defs = await listMetricDefinitions(ctx, company.id);
  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/companies/${slug}`} className="hover:underline">
            {company.name}
          </Link>
        }
        title="Upload numbers"
      >
        <p className="mt-1 max-w-2xl text-[13px] text-muted">
          Columns are matched to {company.name}&apos;s numbers only, so a file can never change another company. A number that
          differs from the saved one is a correction (the old value stays in history).
        </p>
      </PageHeader>
      {defs.length === 0 ? (
        <div className="card px-4 py-6 text-center text-[13px] text-muted">No numbers are tracked for this company yet.</div>
      ) : (
        <>
          <details className="card mb-4 px-4 py-3 text-[13px]">
            <summary className="cursor-pointer font-medium">Accepted column names</summary>
            <ul className="mt-2 space-y-1">
              {defs.map((d) => (
                <li key={d.id}>
                  <b>{d.unitName ? `${d.name} ${d.unitName}` : d.name}</b>{" "}
                  <span className="text-muted">
                    ({d.unit}, {d.granularity === "day" ? "daily" : d.granularity === "week" ? "weekly" : "monthly"})
                    {d.aliases.length > 0 && ` · also: ${d.aliases.map((a) => (d.unitName ? `${a} ${d.unitName}` : a)).join(", ")}`}
                  </span>
                </li>
              ))}
            </ul>
          </details>
          <NumbersImportWizard companyId={company.id} companySlug={company.slug} />
        </>
      )}
    </>
  );
}
