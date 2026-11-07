"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import {
  addLinkAction,
  addSalaryAction,
  setLinkActiveAction,
  setPersonStatusAction,
  type PeopleActionState,
} from "@/app/(app)/people/actions";
import { Icon } from "@/components/Icon";
import { PAY_TYPE_LABELS, SALARY_PAY_TYPE_VALUES } from "@/lib/people-schemas";
import { LinkFields, type CompanyOption } from "./PersonForm";
import { DateInput } from "@/components/DateInput";

export function PersonStatusButton({ personId, left }: { personId: string; left: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (status: "active" | "left") =>
    start(async () => {
      const r = await setPersonStatusAction(personId, status);
      setError(r.error ?? null);
      setConfirm(false);
    });
  if (left) {
    return (
      <button type="button" className="btn" disabled={pending} onClick={() => run("active")}>
        Mark as active again
      </button>
    );
  }
  if (!confirm) {
    return (
      <button type="button" className="btn" onClick={() => setConfirm(true)}>
        Mark as left…
      </button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-[13px] text-muted">Ends all their company roles today. History is kept.</span>
      <button type="button" className="btn btn-danger btn-sm" disabled={pending} onClick={() => run("left")}>
        Yes, mark as left
      </button>
      <button type="button" className="btn btn-sm" onClick={() => setConfirm(false)}>
        Cancel
      </button>
      {error && <span className="text-[12px] text-risk">{error}</span>}
    </span>
  );
}

export function LinkActiveButton({ linkId, active }: { linkId: string; active: boolean }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      disabled={pending}
      onClick={() => start(async () => void (await setLinkActiveAction(linkId, !active)))}
    >
      {active ? "End role" : "Reactivate"}
    </button>
  );
}

export function AddLinkForm({ personId, companies, showSalary }: { personId: string; companies: CompanyOption[]; showSalary: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<PeopleActionState, FormData>(addLinkAction, {});
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) {
      ref.current?.reset();
      setOpen(false);
    }
  }, [state.nonce, state.ok]);
  if (!open) {
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        <Icon name="plus" size={16} /> Add company role
      </button>
    );
  }
  return (
    <form ref={ref} action={action} className="card-raised space-y-3 p-4" aria-label="Add company role">
      <input type="hidden" name="personId" value={personId} />
      <LinkFields companies={companies} showSalary={showSalary} state={state} />
      {state.error && <p className="text-[12px] text-risk">{state.error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          Add
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function SalaryForm({ linkId }: { linkId: string }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<PeopleActionState, FormData>(addSalaryAction, {});
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) {
      ref.current?.reset();
      setOpen(false);
    }
  }, [state.nonce, state.ok]);
  if (!open) {
    return (
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
        Change salary
      </button>
    );
  }
  return (
    <form ref={ref} action={action} className="mt-2 grid gap-2 sm:grid-cols-[120px_80px_130px_150px_1fr_auto]" aria-label="Change salary">
      <input type="hidden" name="linkId" value={linkId} />
      <input name="amount" className="input num" placeholder="Amount" inputMode="decimal" aria-label="Amount" required />
      <input name="currency" className="input" defaultValue="KGS" maxLength={3} aria-label="Currency" />
      <select name="payType" className="input" defaultValue="monthly" aria-label="Pay type">
        {SALARY_PAY_TYPE_VALUES.map((v) => (
          <option key={v} value={v}>
            {PAY_TYPE_LABELS[v]}
          </option>
        ))}
      </select>
      <DateInput name="effectiveFrom" aria-label="Effective from" />
      <input name="note" className="input" placeholder="Note (optional)" maxLength={500} aria-label="Note" />
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          Save
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {state.error && <p className="text-[12px] text-risk sm:col-span-6">{state.error}</p>}
    </form>
  );
}
