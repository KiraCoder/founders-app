"use client";

import { useActionState, useState } from "react";
import type { RoutineFormState } from "@/app/(app)/routines/actions";
import { WEEKDAYS_EN } from "@/lib/routines";
import type { RoutineFormOptions, RoutineFormValues } from "./form-values";

function FieldError({ errors, name }: { errors?: Record<string, string[]>; name: string }) {
  const e = errors?.[name];
  return e?.length ? <span className="text-[12px] text-risk">{e[0]}</span> : null;
}

/** Create / edit a routine (founders). Blank chase fields use the defaults shown as placeholders. */
export function RoutineForm({
  action,
  initial,
  options,
  submitLabel,
}: {
  action: (prev: RoutineFormState, fd: FormData) => Promise<RoutineFormState>;
  initial: RoutineFormValues;
  options: RoutineFormOptions;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState<RoutineFormState, FormData>(action, {});
  const [kind, setKind] = useState(initial.scheduleKind);
  const [confirmation, setConfirmation] = useState(initial.confirmation);
  const [assignee, setAssignee] = useState(initial.assignee);
  // A founder's routine has its own defaults (the ask + one reminder), not the staff chase.
  const forFounder = assignee.startsWith("user:");
  const d = forFounder ? options.founderDefaults : options.defaults;
  const fe = state.fieldErrors;
  return (
    <form action={formAction} className={`card flex flex-col gap-4 p-4 ${pending ? "opacity-60" : ""}`} aria-label="Routine">
      {initial.id && <input type="hidden" name="id" value={initial.id} />}
      <label className="flex flex-col gap-1">
        <span className="label">Title</span>
        <input className="input" name="title" defaultValue={initial.title} required maxLength={200} />
        <FieldError errors={fe} name="title" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label">Description (sent with the message; Russian for staff)</span>
        <textarea className="input min-h-[60px]" name="description" defaultValue={initial.description} maxLength={2000} />
      </label>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="label">Who does it</span>
          <select className="input" name="assignee" defaultValue={initial.assignee} required onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Pick a person or a founder…</option>
            <optgroup label="People (via Telegram)">
              {options.people.map((p) => (
                <option key={p.id} value={`person:${p.id}`}>
                  {p.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Founders">
              {options.founders.map((f) => (
                <option key={f.id} value={`user:${f.id}`}>
                  {f.name}
                </option>
              ))}
            </optgroup>
          </select>
          <FieldError errors={fe} name="assignee" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">Company</span>
          <select className="input" name="companyId" defaultValue={initial.companyId}>
            <option value="">Group-wide (no single company)</option>
            {options.companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="label mb-1">When (Asia/Bishkek)</legend>
        <div className="flex flex-wrap gap-3 text-[13px]">
          <label className="flex items-center gap-1.5">
            <input type="radio" name="scheduleKind" value="weekly" checked={kind === "weekly"} onChange={() => setKind("weekly")} /> Days of the week
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" name="scheduleKind" value="monthly" checked={kind === "monthly"} onChange={() => setKind("monthly")} /> Once a month
          </label>
        </div>
        {kind === "weekly" ? (
          <div className="flex flex-wrap gap-2 text-[13px]" role="group" aria-label="Days">
            {WEEKDAYS_EN.map((w, i) => (
              <label key={w} className="flex items-center gap-1">
                <input type="checkbox" name="days" value={i + 1} defaultChecked={initial.days.includes(i + 1)} /> {w}
              </label>
            ))}
            <FieldError errors={fe} name="days" />
          </div>
        ) : (
          <label className="flex max-w-[200px] flex-col gap-1">
            <span className="label">Day of the month (31 = last day)</span>
            <input className="input" name="monthDay" type="number" min={1} max={31} defaultValue={initial.monthDay} />
            <FieldError errors={fe} name="monthDay" />
          </label>
        )}
        <label className="flex max-w-[200px] flex-col gap-1">
          <span className="label">Ask at</span>
          <input className="input" name="time" defaultValue={initial.time} placeholder="HH:MM" required />
          <FieldError errors={fe} name="time" />
        </label>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="label mb-1">Confirmation</legend>
        <select
          className="input max-w-[320px]"
          name="confirmation"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value as "button" | "checklist")}
          aria-label="Confirmation"
        >
          <option value="button">One button (Готово)</option>
          <option value="checklist">Checklist (one button per item)</option>
        </select>
        {confirmation === "checklist" && (
          <label className="flex flex-col gap-1">
            <span className="label">Checklist items (one per line; reminders ask only about unticked ones)</span>
            <textarea className="input min-h-[110px]" name="items" defaultValue={initial.items} />
            <FieldError errors={fe} name="items" />
          </label>
        )}
      </fieldset>

      <fieldset className="grid gap-3 md:grid-cols-3">
        <legend className="label mb-1">Chasing and escalation (blank = default)</legend>
        <label className="flex flex-col gap-1">
          <span className="label">Remind every (minutes)</span>
          <input className="input" name="chaseEveryMinutes" inputMode="numeric" defaultValue={initial.chase.chaseEveryMinutes ?? ""} placeholder={`default ${d.chaseEveryMinutes}`} />
          <FieldError errors={fe} name="chase.chaseEveryMinutes" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">Remind until</span>
          <input className="input" name="chaseUntil" defaultValue={initial.chase.chaseUntil ?? ""} placeholder={`default ${d.chaseUntil}`} />
          <FieldError errors={fe} name="chase.chaseUntil" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">Tell the founders at (or “off”)</span>
          <input
            className="input"
            name="escalateAt"
            defaultValue={initial.chase.escalateAt === null ? "off" : (initial.chase.escalateAt ?? "")}
            placeholder={`default ${d.escalateAt ?? "off"}`}
          />
          <FieldError errors={fe} name="chase.escalateAt" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">…or after N reminders (0 = never)</span>
          <input className="input" name="escalateAfterChases" inputMode="numeric" defaultValue={initial.chase.escalateAfterChases ?? ""} placeholder={`default ${d.escalateAfterChases}`} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label">Max messages per day</span>
          <input className="input" name="maxPerDay" inputMode="numeric" defaultValue={initial.chase.maxPerDay ?? ""} placeholder={`default ${d.maxPerDay}`} />
        </label>
      </fieldset>
      <p className="text-[12px] text-muted">
        {forFounder
          ? "A founder's routine: by default the ask and at most one reminder, no escalation; set the fields to change that. It arrives through the founder's own channel and rules (quiet hours, folded into the summary when the day's pushes are used up)."
          : "Defaults come from the person's chase settings, else the global ones (Settings → Team on Telegram). Quiet hours always apply."}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {submitLabel}
        </button>
        {state.error && (
          <p role="alert" className="text-[12px] text-risk">
            {state.error}
          </p>
        )}
        {state.ok && state.message && (
          <p role="status" className="text-[12px] text-ok">
            {state.message}
          </p>
        )}
      </div>
    </form>
  );
}
