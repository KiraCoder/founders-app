"use client";

import Link from "next/link";
import { STATUS_OPTIONS } from "./labels";

/** GET filter form of the Team view; submits itself on change (works without JS via the button). */
export function TeamFilters({
  companies,
  persons,
  values,
}: {
  companies: { id: string; name: string }[];
  /** Assignee filter options: value "user:<id>" / "person:<id>". */
  persons: { value: string; label: string }[];
  values: { companyId?: string; assignee?: string; status?: string; overdueOnly?: boolean };
}) {
  const hasFilters = Boolean(
    values.companyId || values.assignee || (values.status && values.status !== "open") || values.overdueOnly,
  );
  return (
    <form
      method="get"
      className="mb-4 flex flex-wrap items-end gap-2"
      aria-label="Team filters"
      onChange={(e) => e.currentTarget.requestSubmit()}
    >
      <input type="hidden" name="view" value="team" />
      <div className="w-[170px]">
        <label className="label" htmlFor="team-company">Company</label>
        <select id="team-company" name="company" className="input" defaultValue={values.companyId ?? ""}>
          <option value="">All companies</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="w-[170px]">
        <label className="label" htmlFor="team-person">Person</label>
        <select id="team-person" name="person" className="input" defaultValue={values.assignee ?? ""}>
          <option value="">Everyone</option>
          {persons.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
          <option value="unassigned">Unassigned</option>
        </select>
      </div>
      <div className="w-[150px]">
        <label className="label" htmlFor="team-status">Status</label>
        <select id="team-status" name="status" className="input" defaultValue={values.status ?? "open"}>
          <option value="open">Open</option>
          <option value="active">Active</option>
          <option value="any">Any status</option>
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <label className="mb-1.5 inline-flex items-center gap-2 text-[13px]">
        <input type="checkbox" name="overdue" value="1" defaultChecked={values.overdueOnly} />
        Overdue only
      </label>
      {hasFilters && (
        <Link href="/tasks?view=team" className="btn btn-ghost btn-sm mb-0.5 text-[12px] text-muted hover:text-ink">
          Reset filters
        </Link>
      )}
      <noscript>
        <button type="submit" className="btn">
          Apply
        </button>
      </noscript>
    </form>
  );
}
