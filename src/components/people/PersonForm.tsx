"use client";

import { useActionState, useEffect, useState } from "react";
import { createPersonAction, updatePersonAction, type PeopleActionState } from "@/app/(app)/people/actions";
import { EMPLOYMENT_TYPE_LABELS, EMPLOYMENT_TYPE_VALUES, PAY_TYPE_LABELS, SALARY_PAY_TYPE_VALUES } from "@/lib/people-schemas";
import { DateInput } from "@/components/DateInput";

export interface CompanyOption {
  id: string;
  name: string;
  units: { id: string; name: string }[];
}

export interface PersonFormValues {
  id?: string;
  fullName?: string;
  shortName?: string | null;
  phone?: string | null;
  telegramHandle?: string | null;
  email?: string | null;
  notes?: string | null;
}

function FieldError({ state, name }: { state: PeopleActionState; name: string }) {
  const msg = state.fieldErrors?.[name]?.[0];
  return msg ? <p className="mt-1 text-[12px] text-risk">{msg}</p> : null;
}

/** Company + unit + role (+ salary for viewers). Field names can be prefixed. */
export function LinkFields({
  companies,
  showSalary,
  state,
  defaultCompanyId,
}: {
  companies: CompanyOption[];
  showSalary: boolean;
  state: PeopleActionState;
  defaultCompanyId?: string;
}) {
  const [companyId, setCompanyId] = useState(defaultCompanyId ?? "");
  const units = companies.find((c) => c.id === companyId)?.units ?? [];
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="lf-company">Company</label>
          <select id="lf-company" name="companyId" className="input" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
            <option value="">—</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <FieldError state={state} name="companyId" />
        </div>
        <div>
          <label className="label" htmlFor="lf-unit">Unit</label>
          <select id="lf-unit" name="unitId" className="input" disabled={units.length === 0} defaultValue="">
            <option value="">{units.length ? "No unit" : "—"}</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="lf-role">Role / title</label>
          <input id="lf-role" name="role" className="input" maxLength={120} placeholder="e.g. Швея, Бухгалтер, Courier" />
          <FieldError state={state} name="role" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="lf-type">Employment</label>
            <select id="lf-type" name="employmentType" className="input" defaultValue="staff">
              {EMPLOYMENT_TYPE_VALUES.map((v) => (
                <option key={v} value={v}>
                  {EMPLOYMENT_TYPE_LABELS[v]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="lf-start">Start date</label>
            <DateInput id="lf-start" name="startedOn" />
          </div>
        </div>
      </div>
      {showSalary && (
        <fieldset className="rounded-[8px] border border-warn-line bg-warn-soft/40 p-3">
          <legend className="eyebrow px-1">Salary (restricted)</legend>
          <div className="grid gap-3 sm:grid-cols-4">
            <div>
              <label className="label" htmlFor="lf-amount">Amount</label>
              <input id="lf-amount" name="salaryAmount" className="input num" inputMode="decimal" placeholder="45 000" />
              <FieldError state={state} name="amount" />
            </div>
            <div>
              <label className="label" htmlFor="lf-cur">Currency</label>
              <input id="lf-cur" name="salaryCurrency" className="input" defaultValue="KGS" maxLength={3} />
            </div>
            <div>
              <label className="label" htmlFor="lf-pay">Pay type</label>
              <select id="lf-pay" name="salaryPayType" className="input" defaultValue="monthly">
                {SALARY_PAY_TYPE_VALUES.map((v) => (
                  <option key={v} value={v}>
                    {PAY_TYPE_LABELS[v]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="lf-from">Effective from</label>
              <DateInput id="lf-from" name="salaryFrom" />
            </div>
          </div>
        </fieldset>
      )}
    </>
  );
}

function PersonFields({ values, state }: { values: PersonFormValues; state: PeopleActionState }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <label className="label" htmlFor="pf-name">Full name</label>
        <input id="pf-name" name="fullName" required maxLength={200} className="input" defaultValue={values.fullName ?? ""} placeholder="Фамилия Имя Отчество" />
        <FieldError state={state} name="fullName" />
      </div>
      <div>
        <label className="label" htmlFor="pf-short">Short name</label>
        <input id="pf-short" name="shortName" maxLength={80} className="input" defaultValue={values.shortName ?? ""} />
      </div>
      <div>
        <label className="label" htmlFor="pf-phone">Phone</label>
        <input id="pf-phone" name="phone" maxLength={40} className="input num" defaultValue={values.phone ?? ""} placeholder="+996 555 123 456" />
        <FieldError state={state} name="phone" />
      </div>
      <div>
        <label className="label" htmlFor="pf-tg">Telegram</label>
        <input id="pf-tg" name="telegramHandle" maxLength={70} className="input" defaultValue={values.telegramHandle ?? ""} placeholder="@username" />
        <FieldError state={state} name="telegramHandle" />
      </div>
      <div>
        <label className="label" htmlFor="pf-email">Email</label>
        <input id="pf-email" name="email" type="email" maxLength={200} className="input" defaultValue={values.email ?? ""} />
        <FieldError state={state} name="email" />
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="pf-notes">Notes</label>
        <textarea id="pf-notes" name="notes" rows={2} className="input" defaultValue={values.notes ?? ""} />
      </div>
    </div>
  );
}

export function NewPersonForm({ companies, showSalary, defaultCompanyId }: { companies: CompanyOption[]; showSalary: boolean; defaultCompanyId?: string }) {
  const [state, action, pending] = useActionState<PeopleActionState, FormData>(createPersonAction, {});
  return (
    <form action={action} className="card space-y-4 p-4 md:p-5" aria-label="New person">
      <PersonFields values={{}} state={state} />
      <div className="border-t border-line pt-4">
        <p className="eyebrow mb-3">Works for</p>
        <div className="space-y-3">
          <LinkFields companies={companies} showSalary={showSalary} state={state} defaultCompanyId={defaultCompanyId} />
        </div>
        <p className="mt-2 text-[12px] text-muted">More companies can be added on the person page.</p>
      </div>
      {state.error && <p className="text-[13px] text-risk">{state.error}</p>}
      <button type="submit" className="btn btn-primary" disabled={pending}>
        Create person
      </button>
    </form>
  );
}

export function EditPersonForm({ values }: { values: PersonFormValues }) {
  const [state, action, pending] = useActionState<PeopleActionState, FormData>(updatePersonAction, {});
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (state.ok) {
      setSaved(true);
      const t = setTimeout(() => setSaved(false), 2500);
      return () => clearTimeout(t);
    }
  }, [state.nonce, state.ok]);
  return (
    <form action={action} className="space-y-3" aria-label="Edit person">
      <input type="hidden" name="id" value={values.id} />
      <PersonFields values={values} state={state} />
      {state.error && <p className="text-[13px] text-risk">{state.error}</p>}
      <div className="flex items-center gap-3">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          Save
        </button>
        {saved && <span className="text-[13px] text-accent">Saved</span>}
      </div>
    </form>
  );
}
