"use client";

import { PRIORITY_OPTIONS, STATUS_OPTIONS } from "./labels";

/** GET filter form that submits itself on change (works without JS via the button). */
export function TaskFilters({
  view,
  companies,
  values,
}: {
  view: string;
  companies: { id: string; name: string }[];
  values: { companyId?: string; status?: string; priority?: string };
}) {
  return (
    <form method="get" className="mb-4 flex flex-wrap items-end gap-2" onChange={(e) => e.currentTarget.requestSubmit()}>
      <input type="hidden" name="view" value={view} />
      <div className="w-[170px]">
        <label className="label">Company</label>
        <select name="company" className="input" defaultValue={values.companyId ?? ""}>
          <option value="">All companies</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="w-[150px]">
        <label className="label">Status</label>
        <select name="status" className="input" defaultValue={values.status ?? "open"}>
          <option value="open">Open</option>
          <option value="any">Any status</option>
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="w-[130px]">
        <label className="label">Priority</label>
        <select name="priority" className="input" defaultValue={values.priority ?? ""}>
          <option value="">Any</option>
          {PRIORITY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <noscript>
        <button type="submit" className="btn">
          Apply
        </button>
      </noscript>
    </form>
  );
}
