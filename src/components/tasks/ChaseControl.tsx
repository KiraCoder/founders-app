"use client";

import { useId } from "react";
import {
  CHASE_CHOICES,
  chaseSummary,
  ESCALATION_CHOICES,
  FOUNDER_NUDGE_CHOICES,
  type ChaseFormValue,
  type PersonChaseSettings,
} from "@/lib/task-chase";

/** A row of radio buttons that looks like a segmented control (native radios: keyboard + screen readers). */
export function Segmented<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: string;
  name: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="label">{legend}</legend>
      <div className="flex flex-wrap gap-1 rounded-[10px] border border-line bg-sunk p-1" role="radiogroup" aria-label={legend}>
        {options.map((o) => (
          <label
            key={o.value}
            className={`min-h-9 cursor-pointer rounded-[7px] px-2.5 py-1.5 text-[13px] leading-tight transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent ${
              value === o.value ? "bg-surface font-semibold text-ink shadow-card" : "text-muted hover:text-ink"
            }`}
          >
            <input
              type="radio"
              className="sr-only"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * The explicit per-task chase choice: Don't chase / once on the due date / every N hours or days,
 * escalation, the founder's own nudges, and a live summary sentence. Posts its fields with the form
 * it sits in (chase, everyN, everyUnit, escalation, escalateDays, founderNudge, shareNotes).
 */
export function ChaseControl({
  value,
  onChange,
  assignee,
  nudgedFounder,
  person,
  dueDate,
  unreachable,
  errors,
  showShareNotes,
}: {
  value: ChaseFormValue;
  onChange: (v: ChaseFormValue) => void;
  assignee: { kind: "person" | "user"; name: string } | null;
  nudgedFounder: string;
  person?: PersonChaseSettings | null;
  dueDate: string | null;
  unreachable?: string | null;
  errors?: Record<string, string[] | undefined>;
  showShareNotes?: boolean;
}) {
  const id = useId();
  const set = (patch: Partial<ChaseFormValue>) => onChange({ ...value, ...patch });
  const isPerson = assignee?.kind === "person";
  const summary = chaseSummary({ value, assignee, nudgedFounder, person, dueDate, unreachable });
  const err = (f: string) => errors?.[f]?.[0];
  return (
    <div className="space-y-3" data-testid="chase-control">
      {isPerson ? (
        <>
          <Segmented legend={`Chase ${assignee!.name}`} name="chase" value={value.chase} options={CHASE_CHOICES} onChange={(chase) => set({ chase })} />
          {value.chase === "every" && (
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label className="label" htmlFor={`${id}-n`}>
                  Every
                </label>
                <input
                  id={`${id}-n`}
                  name="everyN"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={value.everyUnit === "days" ? 30 : 12}
                  className="input w-[90px]"
                  value={Number.isFinite(value.everyN) ? value.everyN : ""}
                  onChange={(e) => set({ everyN: Number(e.target.value) })}
                  aria-invalid={!!err("everyN")}
                  aria-describedby={err("everyN") ? `${id}-n-err` : undefined}
                />
              </div>
              <div>
                <label className="label" htmlFor={`${id}-unit`}>
                  Unit
                </label>
                <select id={`${id}-unit`} name="everyUnit" className="input w-[120px]" value={value.everyUnit} onChange={(e) => set({ everyUnit: e.target.value as "hours" | "days" })}>
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </select>
              </div>
              <span className="pb-2 text-[13px] text-muted">until done</span>
              {err("everyN") && (
                <p id={`${id}-n-err`} className="w-full text-[12px] text-risk">
                  {err("everyN")}
                </p>
              )}
            </div>
          )}
          <Segmented
            legend="Escalation"
            name="escalation"
            value={value.escalation}
            options={ESCALATION_CHOICES}
            onChange={(escalation) => set({ escalation })}
          />
          {value.escalation === "days" && (
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label className="label" htmlFor={`${id}-d`}>
                  Days after due
                </label>
                <input
                  id={`${id}-d`}
                  name="escalateDays"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={60}
                  className="input w-[90px]"
                  value={Number.isFinite(value.escalateDays) ? value.escalateDays : ""}
                  onChange={(e) => set({ escalateDays: Number(e.target.value) })}
                  aria-invalid={!!err("escalateDays")}
                />
              </div>
              <span className="pb-2 text-[13px] text-muted">then tell both founders</span>
              {err("escalateDays") && <p className="w-full text-[12px] text-risk">{err("escalateDays")}</p>}
            </div>
          )}
          {showShareNotes && (
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" name="shareNotes" checked={value.shareNotes} onChange={(e) => set({ shareNotes: e.target.checked })} />
              Send the notes to {assignee!.name} on Telegram
            </label>
          )}
        </>
      ) : (
        <input type="hidden" name="chase" value={value.chase} />
      )}
      <Segmented
        legend={`Founder reminders (${nudgedFounder})`}
        name="founderNudge"
        value={value.founderNudge}
        options={FOUNDER_NUDGE_CHOICES}
        onChange={(founderNudge) => set({ founderNudge })}
      />
      <div className="rounded-[10px] border border-line bg-sunk/60 px-3 py-2 text-[13px]" aria-live="polite" data-testid="chase-summary">
        {summary.map((s, i) => (
          <p key={i} className={i === 0 ? "font-medium" : "mt-1 text-muted"}>
            {s}
          </p>
        ))}
      </div>
    </div>
  );
}
