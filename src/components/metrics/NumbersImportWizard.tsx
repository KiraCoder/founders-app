"use client";

import { startTransition, useActionState, useRef, type FormEvent } from "react";
import Link from "next/link";
import { importNumbersAction, type NumbersImportState } from "@/app/(app)/companies/actions";
import { Tag, type Tone } from "@/components/ui";
import { formatMetricValue, formatPeriod } from "@/lib/metrics";

const ACTION_TONE: Record<string, Tone> = { create: "ok", update: "info", unchanged: "neutral", error: "risk" };
const ACTION_LABEL: Record<string, string> = { create: "New", update: "Update", unchanged: "Unchanged", error: "Error" };

export function NumbersImportWizard({ companyId, companySlug }: { companyId: string; companySlug: string }) {
  const [state, action, pending] = useActionState<NumbersImportState, FormData>(importNumbersAction, { step: "upload" });
  const stepRef = useRef<HTMLInputElement>(null);
  const submitAs = (step: string) => () => {
    if (stepRef.current) stepRef.current.value = step;
  };
  // Not `<form action>`: React would reset the form and drop the chosen file. The browser
  // keeps the file and sends it again for the confirm step.
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(() => action(fd));
  };
  const plan = state.plan;
  const fmt = (v: number | null, unit: string | null) => (v === null ? "" : unit ? formatMetricValue(v, unit) : String(v));

  return (
    <form onSubmit={onSubmit} className="space-y-4" aria-label="Import numbers">
      <input ref={stepRef} type="hidden" name="step" defaultValue="preview" />
      <input type="hidden" name="companyId" value={companyId} />
      {/* The confirm step must send the previewed file's hash back (server refuses another file). */}
      <input type="hidden" name="fileSha256" value={plan?.fileSha256 ?? ""} />

      <section className={`card p-4 md:p-5 ${state.step === "upload" ? "" : "hidden"}`}>
        <p className="eyebrow mb-2">1 · Upload</p>
        <p className="mb-3 text-[13px] text-muted">
          A .xlsx or .csv file (max 2 MB): a <b>Date</b> column (Дата / Месяц) and one column per number, named like the card
          (English or Russian, e.g. “Orders per day” or “Заказы в день”; factory numbers with the factory, e.g. “Выпуск ХБК”).
        </p>
        <input name="file" type="file" accept=".xlsx,.csv" className="input pt-1.5" aria-label="Spreadsheet file" required />
        <div className="mt-3">
          <button type="submit" className="btn btn-primary" disabled={pending} onClick={submitAs("preview")}>
            {pending ? "Reading…" : "Preview"}
          </button>
        </div>
      </section>

      {state.error && (
        <p className="rounded-[8px] border border-risk-line bg-risk-soft px-3 py-2 text-[13px] text-risk" role="alert">
          {state.error}
        </p>
      )}

      {plan && state.step !== "upload" && (
        <section className="card p-4 md:p-5" data-testid="numbers-import-preview">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <p className="eyebrow">{state.step === "done" ? "Imported" : "2 · Preview"}</p>
            <span className="text-[12px] text-muted">{state.fileName}</span>
            <Tag tone="ok">
              <span className="num">{plan.counts.create}</span> new
            </Tag>
            <Tag tone="info">
              <span className="num">{plan.counts.update}</span> update
            </Tag>
            <Tag>
              <span className="num">{plan.counts.unchanged}</span> unchanged
            </Tag>
            <Tag tone={plan.counts.error ? "risk" : "neutral"}>
              <span className="num">{plan.counts.error}</span> errors
            </Tag>
            {state.step === "preview" && (
              <button type="button" className="ml-auto text-[13px] text-accent hover:underline" onClick={() => window.location.reload()}>
                Choose another file
              </button>
            )}
          </div>
          <div className="mb-3 text-[12px]">
            <p className="text-muted">
              Date column: <b className="text-ink">{plan.dateColumn}</b>
            </p>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {plan.columns.map((c) => (
                <li key={c.index}>
                  <Tag tone={c.metricId ? "ok" : "warn"} title={c.note}>
                    {c.header || `Column ${c.index + 1}`} → {c.metricLabel ?? "ignored"}
                  </Tag>
                </li>
              ))}
            </ul>
          </div>
          {state.step === "done" && (
            <p className="mb-3 text-[13px]" role="status">
              Done: <span className="num">{state.applied}</span> numbers saved. Errors were skipped.{" "}
              <Link href={`/companies/${companySlug}`} className="text-accent hover:underline">
                Back to the company
              </Link>
            </p>
          )}
          <div className="max-h-[480px] overflow-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead className="sticky top-0 bg-surface">
                <tr className="border-b border-line">
                  <th className="eyebrow py-2 pr-3">Row</th>
                  <th className="eyebrow py-2 pr-3">Action</th>
                  <th className="eyebrow py-2 pr-3">Number</th>
                  <th className="eyebrow py-2 pr-3">Period</th>
                  <th className="eyebrow py-2 pr-3 text-right">Value</th>
                  <th className="eyebrow py-2 pr-3 text-right">Now</th>
                  <th className="eyebrow py-2">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {plan.cells.map((c, i) => (
                  <tr key={i}>
                    <td className="num py-1.5 pr-3 text-muted">{c.row}</td>
                    <td className="py-1.5 pr-3">
                      <Tag tone={ACTION_TONE[c.action]}>{ACTION_LABEL[c.action]}</Tag>
                    </td>
                    <td className="py-1.5 pr-3">{c.metricLabel}</td>
                    <td className="num py-1.5 pr-3 whitespace-nowrap">{c.period && c.granularity ? formatPeriod(c.period, c.granularity) : ""}</td>
                    <td className="num py-1.5 pr-3 text-right whitespace-nowrap">{fmt(c.value, c.unit)}</td>
                    <td className="num py-1.5 pr-3 text-right whitespace-nowrap text-muted">{fmt(c.current, c.unit)}</td>
                    <td className="py-1.5 text-[12px] text-risk">{c.error ?? ""}</td>
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
                {pending ? "Importing…" : `Import ${plan.counts.create + plan.counts.update} numbers`}
              </button>
              <span className="text-[12px] text-muted">Errors are skipped. Importing the same file again changes nothing.</span>
            </div>
          )}
        </section>
      )}
    </form>
  );
}
