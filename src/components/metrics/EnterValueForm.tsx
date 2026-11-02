"use client";

import { useActionState, useEffect, useState } from "react";
import { enterMetricValueAction, type MetricActionState } from "@/app/(app)/companies/actions";

export function EnterValueForm({
  metricId,
  label,
  unit,
  granularity,
  defaultPeriod,
  maxPeriod,
}: {
  metricId: string;
  label: string;
  unit: string;
  granularity: "day" | "week" | "month";
  /** "YYYY-MM-DD" (period start). */
  defaultPeriod: string;
  /** Latest allowed period start (current period). */
  maxPeriod: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<MetricActionState, FormData>(enterMetricValueAction, {});
  useEffect(() => {
    if (state.ok && state.nonce) setOpen(false);
  }, [state.ok, state.nonce]);
  const id = `ev-${metricId}`;

  if (!open) {
    return (
      <div className="flex items-center gap-2">
        <button type="button" className="btn btn-sm" onClick={() => setOpen(true)} aria-label={`Enter value for ${label}`}>
          Enter value
        </button>
        {state.ok && state.message && (
          <span className="text-[11px] text-muted" role="status">
            {state.message}
          </span>
        )}
      </div>
    );
  }
  const month = granularity === "month";
  return (
    <form action={action} className="mt-1 flex flex-col gap-2 rounded-[8px] border border-line bg-sunk p-2.5" aria-label={`Enter value for ${label}`}>
      <input type="hidden" name="metricId" value={metricId} />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label" htmlFor={`${id}-period`}>
            {month ? "Month" : granularity === "week" ? "Any day in the week" : "Day"}
          </label>
          <input
            id={`${id}-period`}
            name="period"
            type={month ? "month" : "date"}
            className="input"
            required
            defaultValue={month ? defaultPeriod.slice(0, 7) : defaultPeriod}
            max={month ? maxPeriod.slice(0, 7) : granularity === "week" ? undefined : maxPeriod}
          />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-value`}>
            Value ({unit})
          </label>
          <input id={`${id}-value`} name="value" inputMode="decimal" className="input num" required autoFocus autoComplete="off" />
        </div>
      </div>
      <div>
        <label className="label" htmlFor={`${id}-note`}>
          Note (optional)
        </label>
        <input id={`${id}-note`} name="note" className="input" maxLength={500} autoComplete="off" />
      </div>
      {state.error && (
        <p className="text-[12px] text-risk" role="alert">
          {state.error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
