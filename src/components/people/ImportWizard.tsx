"use client";

import { startTransition, useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { importAction, type ImportState } from "@/app/(app)/people/actions";
import { Tag, type Tone } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import { PAY_TYPE_LABELS } from "@/lib/people-schemas";

const FIELDS = [
  ["fullName", "Full name *"],
  ["company", "Company"],
  ["role", "Role / title"],
  ["unit", "Unit (factory)"],
  ["phone", "Phone"],
  ["telegram", "Telegram"],
  ["email", "Email"],
  ["employmentType", "Employment type"],
  ["notes", "Notes"],
] as const;
const SALARY_FIELDS = [
  ["salary", "Salary"],
  ["payType", "Pay type"],
] as const;

const ACTION_TONE: Record<string, Tone> = { create: "ok", update: "info", skip: "neutral", error: "risk" };
const ACTION_LABEL: Record<string, string> = { create: "Create", update: "Update", skip: "Skip", error: "Error" };

export function ImportWizard({ companies }: { companies: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState<ImportState, FormData>(importAction, { step: "upload" });
  const [mapping, setMapping] = useState<Record<string, number | null>>({});
  const stepRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state.step === "map" && state.mapping) setMapping({ ...state.mapping } as Record<string, number | null>);
  }, [state.step, state.mapping]);

  const submitAs = (step: string) => () => {
    if (stepRef.current) stepRef.current.value = step;
  };
  // Not `<form action>`: React resets a form after an action, which would drop the chosen
  // file. The browser keeps the file and sends it again with every step instead.
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(() => action(fd));
  };
  const headers = state.headers ?? [];
  const fields = state.allowSalary ? [...FIELDS, ...SALARY_FIELDS] : FIELDS;
  const plan = state.plan;

  return (
    <form onSubmit={onSubmit} className="space-y-4" aria-label="Import people">
      <input ref={stepRef} type="hidden" name="step" defaultValue="analyze" />
      <input type="hidden" name="mapping" value={JSON.stringify(mapping)} />
      {/* The confirm step must send the previewed file's hash back (server refuses another file). */}
      <input type="hidden" name="fileSha256" value={plan?.fileSha256 ?? ""} />

      <section className={`card p-4 md:p-5 ${state.step === "upload" ? "" : "hidden"}`}>
        <p className="eyebrow mb-2">1 · Upload</p>
        <p className="mb-3 text-[13px] text-muted">
          A .xlsx or .csv file, up to 2 MB, with a header row. The file is read on the server and not kept after import.
        </p>
        <input name="file" type="file" accept=".xlsx,.csv" className="input pt-1.5" aria-label="Spreadsheet file" required />
        <div className="mt-3 flex gap-2">
          <button type="submit" className="btn btn-primary" disabled={pending} onClick={submitAs("analyze")}>
            {pending ? "Reading…" : "Read file"}
          </button>
        </div>
      </section>

      {state.error && (
        <p className="rounded-[8px] border border-risk-line bg-risk-soft px-3 py-2 text-[13px] text-risk" role="alert">
          {state.error}
        </p>
      )}

      {state.step !== "upload" && (
        <section className="card p-4 md:p-5">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <p className="eyebrow">2 · Map columns</p>
            <span className="text-[12px] text-muted">
              {state.fileName} · <span className="num">{state.rowCount ?? plan?.rows.length ?? 0}</span> rows
            </span>
            <button
              type="button"
              className="ml-auto text-[13px] text-accent hover:underline"
              onClick={() => window.location.assign("/people/import")}
            >
              Choose another file
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {fields.map(([key, label]) => (
              <div key={key}>
                <label className="label" htmlFor={`map-${key}`}>
                  {label}
                </label>
                <select
                  id={`map-${key}`}
                  className="input"
                  value={mapping[key] ?? ""}
                  disabled={state.step === "done"}
                  onChange={(e) => setMapping((m) => ({ ...m, [key]: e.target.value === "" ? null : Number(e.target.value) }))}
                >
                  <option value="">— not in file —</option>
                  {headers.map((h, i) =>
                    !state.allowSalary && state.salaryHeaders?.includes(i) ? null : (
                      <option key={i} value={i}>
                        {h || `Column ${i + 1}`}
                      </option>
                    ),
                  )}
                </select>
              </div>
            ))}
            <div>
              <label className="label" htmlFor="map-default-company">
                Default company (empty cells)
              </label>
              <select id="map-default-company" name="defaultCompanyId" className="input" defaultValue={state.defaultCompanyId ?? ""}>
                <option value="">—</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {!state.allowSalary && (state.salaryHeaders?.length ?? 0) > 0 && (
            <p className="mt-3 text-[12px] text-muted">
              The file has a salary column. Only salary viewers can import salaries, so it is ignored and not shown.
            </p>
          )}
          {state.step !== "done" && (
            <button type="submit" className="btn btn-primary mt-4" disabled={pending} onClick={submitAs("preview")}>
              {pending ? "Checking…" : "Preview"}
            </button>
          )}
        </section>
      )}

      {plan && (state.step === "preview" || state.step === "done") && (
        <section className="card p-4 md:p-5" data-testid="import-preview">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <p className="eyebrow">{state.step === "done" ? "Imported" : "3 · Preview"}</p>
            <Tag tone="ok">
              <span className="num">{plan.counts.create}</span> create
            </Tag>
            <Tag tone="info">
              <span className="num">{plan.counts.update}</span> update
            </Tag>
            <Tag>
              <span className="num">{plan.counts.skip}</span> skip
            </Tag>
            <Tag tone={plan.counts.error ? "risk" : "neutral"}>
              <span className="num">{plan.counts.error}</span> errors
            </Tag>
          </div>
          {plan.salaryIncluded && plan.salaryDecreases > 0 && (
            <p
              className="mb-3 rounded-[8px] border border-risk-line bg-risk-soft px-3 py-2 text-[13px] text-risk"
              role="alert"
              data-testid="salary-decrease-warning"
            >
              <b>
                <span className="num">{plan.salaryDecreases}</span> salary decrease{plan.salaryDecreases === 1 ? "" : "s"}
              </b>{" "}
              — the file has a LOWER amount than the current salary. If this is an old file, it would undo raises.
              Check the rows marked “decrease” before importing.
            </p>
          )}
          {state.step === "done" && (
            <p className="mb-3 text-[13px]" role="status">
              Done: <span className="num">{state.applied}</span> rows applied. Rows with errors were not imported.{" "}
              <Link href="/people" className="text-accent hover:underline">
                Open People
              </Link>
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-line">
                  <th className="eyebrow py-2 pr-3">Row</th>
                  <th className="eyebrow py-2 pr-3">Action</th>
                  <th className="eyebrow py-2 pr-3">Name</th>
                  <th className="eyebrow py-2 pr-3">Company · role · unit</th>
                  <th className="eyebrow py-2 pr-3">Phone</th>
                  {plan.salaryIncluded && <th className="eyebrow py-2 pr-3 text-right">Salary</th>}
                  <th className="eyebrow py-2">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {plan.rows.map((r) => (
                  <tr key={r.row} className="align-top">
                    <td className="num py-2 pr-3 text-muted">{r.row}</td>
                    <td className="py-2 pr-3">
                      <Tag tone={ACTION_TONE[r.action]}>{ACTION_LABEL[r.action]}</Tag>
                    </td>
                    <td className="py-2 pr-3 font-medium">{r.fullName || <span className="text-muted">—</span>}</td>
                    <td className="py-2 pr-3">
                      {[r.companyName, r.role, r.unitName].filter(Boolean).join(" · ")}
                    </td>
                    <td className="num py-2 pr-3 whitespace-nowrap">{r.phone ?? ""}</td>
                    {plan.salaryIncluded && (
                      <td
                        className={`num py-2 pr-3 text-right whitespace-nowrap ${r.salaryDecrease ? "font-semibold text-risk" : ""}`}
                        data-testid={r.salaryDecrease ? "salary-decrease" : undefined}
                      >
                        {r.salary && r.salaryBefore && r.salaryBefore.amount !== r.salary.amount && (
                          <span className={r.salaryDecrease ? "" : "text-muted"}>
                            {formatMoney(r.salaryBefore.amount, r.salaryBefore.currency)} →{" "}
                          </span>
                        )}
                        {r.salary ? `${formatMoney(r.salary.amount, r.salary.currency)}${r.salary.payType !== "monthly" ? ` · ${PAY_TYPE_LABELS[r.salary.payType].toLowerCase()}` : ""}` : ""}
                        {r.salaryDecrease && <span className="ml-1">▼ decrease</span>}
                      </td>
                    )}
                    <td className="py-2 text-[12px]">
                      {r.errors.length > 0 ? (
                        <span className="text-risk">{r.errors.join("; ")}</span>
                      ) : (
                        <span className="text-muted">{r.changes.join("; ")}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {state.step === "preview" && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={pending || plan.counts.create + plan.counts.update === 0}
                onClick={submitAs("confirm")}
              >
                {pending ? "Importing…" : `Import ${plan.counts.create + plan.counts.update} rows`}
              </button>
              <span className="text-[12px] text-muted">Rows with errors are skipped. Running the same file again changes nothing.</span>
            </div>
          )}
        </section>
      )}
    </form>
  );
}
