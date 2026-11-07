"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { OrgActionState } from "@/app/(app)/org/actions";

export interface PersonOption {
  id: string;
  name: string;
  role: string;
}

export interface NewPersonData {
  fullName: string;
  shortName: string;
  phone: string;
  telegramHandle: string;
  role: string;
}

/** Creates the person, links them to the company and assigns them (one server call). */
export type CreatePerson = (data: NewPersonData) => Promise<OrgActionState>;

/**
 * The org board's person picker: a select of the company's people, and — for founders —
 * "+ New person", a small in-page form (full name, short name, phone, Telegram, role / title)
 * that creates the person, links them to this company and assigns them in one step.
 * Not a <form> (it sits inside the department panel's form): Enter submits it by hand.
 */
export function PersonPicker({
  id,
  label,
  value,
  people,
  onChange,
  onCreate,
  defaultRole,
  disabled,
  autoFocus,
}: {
  id: string;
  label: string;
  value: string;
  people: PersonOption[];
  onChange: (personId: string) => void;
  /** Present for founders: shows "+ New person". */
  onCreate?: CreatePerson;
  /** Role / title the new person gets in this company (editable): the department / function name. */
  defaultRole: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [creating, setCreating] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <select id={id} aria-label={label} className="input" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} autoFocus={autoFocus}>
        <option value="">Nobody yet</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.role ? ` · ${p.role}` : ""}
          </option>
        ))}
      </select>
      {onCreate && !disabled && !creating && (
        <button type="button" className="self-start text-[12.5px] font-semibold text-accent hover:underline" onClick={() => setCreating(true)} aria-label={`New person for: ${label}`}>
          + New person
        </button>
      )}
      {onCreate && creating && <NewPersonForm label={label} defaultRole={defaultRole} onCreate={onCreate} onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewPersonForm({ label, defaultRole, onCreate, onClose }: { label: string; defaultRole: string; onCreate: CreatePerson; onClose: () => void }) {
  const [data, setData] = useState<NewPersonData>({ fullName: "", shortName: "", phone: "", telegramHandle: "", role: defaultRole });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const first = useRef<HTMLInputElement>(null);
  const uid = useId();
  useEffect(() => first.current?.focus(), []);

  const submit = async () => {
    if (busy) return;
    if (!data.fullName.trim()) {
      setFieldErrors({ fullName: ["Full name is required"] });
      return;
    }
    setBusy(true);
    const res = await onCreate(data);
    setBusy(false);
    if (res.ok) {
      onClose();
      return;
    }
    setError(res.error ?? "Not saved");
    setFieldErrors(res.fieldErrors ?? {});
  };
  const field = (k: keyof NewPersonData, text: string, opts: { placeholder?: string; required?: boolean; inputMode?: "tel" } = {}) => (
    <div>
      <label className="label" htmlFor={`${uid}-${k}`}>
        {text}
      </label>
      <input
        id={`${uid}-${k}`}
        ref={k === "fullName" ? first : undefined}
        className="input h-8 text-[13px]"
        value={data[k]}
        placeholder={opts.placeholder}
        required={opts.required}
        inputMode={opts.inputMode}
        maxLength={k === "fullName" ? 200 : k === "role" ? 120 : 80}
        onChange={(e) => setData((d) => ({ ...d, [k]: e.target.value }))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      />
      {(fieldErrors[k]?.[0] ?? (k === "role" ? fieldErrors["links.0.role"]?.[0] : undefined)) && (
        <p className="mt-0.5 text-[11.5px] text-risk">{fieldErrors[k]?.[0] ?? fieldErrors["links.0.role"]?.[0]}</p>
      )}
    </div>
  );
  return (
    <div role="group" aria-label={`New person — ${label}`} className="flex flex-col gap-2 rounded-[10px] border border-line bg-sunk/60 p-2.5" data-testid="org-new-person">
      <p className="text-[12px] text-muted">Added to People, linked to this company and assigned here.</p>
      {field("fullName", "Full name", { placeholder: "Фамилия Имя", required: true })}
      <div className="grid grid-cols-2 gap-2">
        {field("shortName", "Short name", { placeholder: "Имя" })}
        {field("phone", "Phone", { placeholder: "+996 …", inputMode: "tel" })}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {field("telegramHandle", "Telegram", { placeholder: "@username" })}
        {field("role", "Role / title")}
      </div>
      {error && (
        <p role="alert" className="text-[12px] text-risk">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void submit()}>
          {busy ? "Saving…" : "Create and assign"}
        </button>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
