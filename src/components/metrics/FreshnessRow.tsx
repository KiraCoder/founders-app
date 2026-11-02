import Link from "next/link";
import type { CompanyFreshness } from "@/server/services/metrics";

/** One small row: how many of a company's numbers are fresh / stale / missing. */
export function FreshnessCounts({ f }: { f: CompanyFreshness }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-[12px]" data-testid={`freshness-${f.companySlug}`}>
      <span className="tag tag-ok" title="Fresh">
        <span className="num">{f.fresh}</span> fresh
      </span>
      <span className={`tag ${f.stale ? "tag-warn" : ""}`} title="Overdue">
        <span className="num">{f.stale}</span> stale
      </span>
      <span className={`tag ${f.missing ? "tag-risk" : ""}`} title="No data yet">
        <span className="num">{f.missing}</span> missing
      </span>
    </span>
  );
}

/** Group overview: one row per company with numbers. */
export function GroupFreshness({ rows }: { rows: CompanyFreshness[] }) {
  if (rows.length === 0) return null;
  return (
    <ul className="card divide-y divide-line" data-testid="group-freshness">
      {rows.map((f) => (
        <li key={f.companyId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
          <Link href={`/companies/${f.companySlug}`} className="text-[13px] font-medium hover:underline">
            {f.companyName}
          </Link>
          <FreshnessCounts f={f} />
        </li>
      ))}
    </ul>
  );
}
