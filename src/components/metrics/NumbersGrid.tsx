"use client";

import { useActionState, useEffect, useMemo, useState, type FormEvent, startTransition } from "react";
import { saveMetricGridAction, type GridState } from "@/app/(app)/companies/actions";

export interface GridMetric {
  id: string;
  label: string;
  unit: string;
}

export interface GridRow {
  period: string;
  label: string;
}

/**
 * Period × metric grid for fast entry (e.g. all monthly numbers at once). Only changed
 * cells are sent; empty cells never delete a value.
 */
export function NumbersGrid({
  companyId,
  metrics,
  rows,
  values,
}: {
  companyId: string;
  metrics: GridMetric[];
  rows: GridRow[];
  /** "metricId|period" → current value as text. */
  values: Record<string, string>;
}) {
  const [state, action, pending] = useActionState<GridState, FormData>(saveMetricGridAction, {});
  const [edits, setEdits] = useState<Record<string, string>>({});
  useEffect(() => {
    if (state.nonce && state.result && state.result.errors.length === 0) setEdits({});
  }, [state.nonce, state.result]);
  const changed = useMemo(
    () =>
      Object.entries(edits)
        .filter(([k, v]) => v.trim() !== (values[k] ?? "") && v.trim() !== "")
        .map(([k, v]) => {
          const [metricId, period] = k.split("|");
          return { metricId: metricId!, period: period!, value: v.trim() };
        }),
    [edits, values],
  );
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData();
    fd.set("companyId", companyId);
    fd.set("cells", JSON.stringify(changed));
    startTransition(() => action(fd));
  };
  const r = state.result;

  return (
    <form onSubmit={onSubmit} aria-label="Numbers grid">
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-[13px]" data-testid="numbers-grid">
          <thead>
            <tr className="border-b border-line bg-sunk">
              <th className="eyebrow sticky left-0 bg-sunk px-3 py-2">Period</th>
              {metrics.map((m) => (
                <th key={m.id} className="eyebrow px-2 py-2 text-right font-semibold">
                  {m.label}
                  <span className="block font-normal normal-case text-muted">{m.unit}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => (
              <tr key={row.period}>
                <th scope="row" className="num sticky left-0 whitespace-nowrap bg-surface px-3 py-1.5 font-medium">
                  {row.label}
                </th>
                {metrics.map((m) => {
                  const k = `${m.id}|${row.period}`;
                  const v = edits[k] ?? values[k] ?? "";
                  const dirty = edits[k] !== undefined && edits[k]!.trim() !== (values[k] ?? "");
                  return (
                    <td key={k} className="px-1 py-1">
                      <input
                        aria-label={`${m.label}, ${row.label}`}
                        inputMode="decimal"
                        autoComplete="off"
                        className={`input num h-8 text-right ${dirty ? "border-accent bg-accent-soft" : ""}`}
                        value={v}
                        onChange={(e) => setEdits((s) => ({ ...s, [k]: e.target.value }))}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="submit" className="btn btn-primary" disabled={pending || changed.length === 0}>
          {pending ? "Saving…" : `Save ${changed.length || ""} change${changed.length === 1 ? "" : "s"}`.replace("  ", " ")}
        </button>
        <span className="text-[12px] text-muted">A changed number is a correction: the old value stays in history.</span>
      </div>
      {state.error && (
        <p className="mt-2 text-[13px] text-risk" role="alert">
          {state.error}
        </p>
      )}
      {r && (
        <div className="mt-2 text-[13px]" role="status">
          Saved: <span className="num">{r.created}</span> new, <span className="num">{r.updated}</span> corrected
          {r.unchanged ? (
            <>
              , <span className="num">{r.unchanged}</span> unchanged
            </>
          ) : null}
          .
          {r.errors.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-risk">
              {r.errors.map((e, i) => (
                <li key={i}>{e.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}
