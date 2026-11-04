"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import {
  archiveClientProjectAction,
  saveClientProjectAction,
  type ClientProjectActionState,
} from "@/app/(app)/companies/[slug]/client-project-actions";
import { DateInput } from "@/components/DateInput";
import { Icon } from "@/components/Icon";

export interface ClientProjectFormValues {
  id?: string;
  clientName: string;
  title: string;
  stage: string;
  status: string;
  startDate: string | null;
  dueDate: string | null;
  slaMonthlyFee: string | null;
  slaCurrency: string;
  slaResponseHours: number | null;
  nextInvoiceDate: string | null;
  notes: string | null;
}

type Option = { value: string; label: string };

const EMPTY: ClientProjectFormValues = {
  clientName: "",
  title: "",
  stage: "lead",
  status: "on_track",
  startDate: null,
  dueDate: null,
  slaMonthlyFee: null,
  slaCurrency: "KGS",
  slaResponseHours: null,
  nextInvoiceDate: null,
  notes: null,
};

function FieldError({ state, name }: { state: ClientProjectActionState; name: string }) {
  const msg = state.fieldErrors?.[name]?.[0];
  return msg ? <p className="mt-1 text-[11px] text-risk">{msg}</p> : null;
}

/** Create (no `initial.id`) or edit a client project. Opens from a button; closes on save. */
export function ClientProjectForm({
  companyId,
  initial,
  stages,
  statuses,
}: {
  companyId: string;
  initial?: ClientProjectFormValues;
  stages: Option[];
  statuses: Option[];
}) {
  const v = initial ?? EMPTY;
  const editing = !!v.id;
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<ClientProjectActionState, FormData>(saveClientProjectAction, {});
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) {
      if (!editing) ref.current?.reset();
      setOpen(false);
    }
  }, [state.nonce, state.ok, editing]);

  if (!open) {
    return editing ? (
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(true)} aria-label={`Edit ${v.clientName} · ${v.title}`}>
        Edit
      </button>
    ) : (
      <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
        <Icon name="plus" size={16} /> New client project
      </button>
    );
  }
  return (
    <form
      ref={ref}
      action={action}
      className="card-raised w-full space-y-3 p-4 text-left"
      aria-label={editing ? `Edit ${v.clientName} · ${v.title}` : "New client project"}
    >
      <input type="hidden" name="companyId" value={companyId} />
      {v.id && <input type="hidden" name="id" value={v.id} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor={`cp-client-${v.id ?? "new"}`}>
            Client
          </label>
          <input id={`cp-client-${v.id ?? "new"}`} name="clientName" required maxLength={200} className="input" defaultValue={v.clientName} autoFocus />
          <FieldError state={state} name="clientName" />
        </div>
        <div>
          <label className="label" htmlFor={`cp-title-${v.id ?? "new"}`}>
            Project
          </label>
          <input id={`cp-title-${v.id ?? "new"}`} name="title" required maxLength={200} className="input" defaultValue={v.title} />
          <FieldError state={state} name="title" />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <label className="label">Stage</label>
          <select name="stage" className="input" defaultValue={v.stage} aria-label="Stage">
            {stages.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Status</label>
          <select name="status" className="input" defaultValue={v.status} aria-label="Status">
            {statuses.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Start</label>
          <DateInput name="startDate" defaultValue={v.startDate ?? undefined} aria-label="Start date" />
        </div>
        <div>
          <label className="label">Due</label>
          <DateInput name="dueDate" defaultValue={v.dueDate ?? undefined} aria-label="Due date" />
          <FieldError state={state} name="dueDate" />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <div>
          <label className="label">SLA fee / month</label>
          <input name="slaMonthlyFee" inputMode="decimal" className="input num" defaultValue={v.slaMonthlyFee ?? ""} placeholder="0.00" aria-label="SLA fee per month" />
          <FieldError state={state} name="slaMonthlyFee" />
        </div>
        <div>
          <label className="label">Currency</label>
          <input name="slaCurrency" maxLength={3} className="input uppercase" defaultValue={v.slaCurrency} aria-label="Currency" />
          <FieldError state={state} name="slaCurrency" />
        </div>
        <div>
          <label className="label">SLA response (h)</label>
          <input name="slaResponseHours" inputMode="numeric" className="input num" defaultValue={v.slaResponseHours ?? ""} aria-label="SLA response hours" />
          <FieldError state={state} name="slaResponseHours" />
        </div>
        <div>
          <label className="label">Next invoice</label>
          <DateInput name="nextInvoiceDate" defaultValue={v.nextInvoiceDate ?? undefined} aria-label="Next invoice date" />
        </div>
      </div>
      <div>
        <label className="label">Notes</label>
        <textarea name="notes" rows={2} maxLength={5000} className="input" defaultValue={v.notes ?? ""} />
      </div>
      {state.error && <p className="text-[12px] text-risk">{state.error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {editing ? "Save" : "Create"}
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Archive / restore button (archived projects are kept, never deleted). */
export function ArchiveClientProjectButton({ companyId, id, archived, label }: { companyId: string; id: string; archived: boolean; label: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        disabled={pending}
        aria-label={`${archived ? "Restore" : "Archive"} ${label}`}
        onClick={() =>
          start(async () => {
            const res = await archiveClientProjectAction(companyId, id, !archived);
            setError(res.ok ? null : (res.error ?? "Could not save"));
          })
        }
      >
        {archived ? "Restore" : "Archive"}
      </button>
      {error && <span className="text-[11px] text-risk">{error}</span>}
    </>
  );
}
