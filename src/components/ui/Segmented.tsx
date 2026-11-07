"use client";

/**
 * Segmented — one clear choice out of a few, as a row of segments (a radio group underneath).
 *
 *   <Segmented label="Reminders" name="reminderMode" value={mode} onChange={setMode}
 *     options={[{ value: "once", label: "Ask once" }, { value: "every", label: "Remind every…" }]} />
 *
 * Each option is a real radio input (getByLabel("Ask once") / getByRole("radio")), the group is
 * named by `label` (getByRole("radiogroup", { name })). With `name`, the value is submitted.
 * Wraps on narrow screens.
 */
import { useId } from "react";

export interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string; hint?: string }[];
  name?: string;
  hideLabel?: boolean;
}

export function Segmented<T extends string>({ label, value, onChange, options, name, hideLabel }: SegmentedProps<T>) {
  const id = useId();
  return (
    <div role="radiogroup" aria-labelledby={`${id}-l`} className="flex flex-col gap-1">
      <span id={`${id}-l`} className={hideLabel ? "sr-only" : "label mb-0"}>
        {label}
      </span>
      <div className="inline-flex w-fit max-w-full flex-wrap gap-1 rounded-[var(--radius-btn)] border border-line bg-sunk p-0.5">
        {options.map((o) => {
          const checked = o.value === value;
          return (
            <label
              key={o.value}
              title={o.hint}
              className={`relative cursor-pointer rounded-[6px] px-2.5 py-1 text-[13px] transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${
                checked ? "bg-surface font-semibold text-ink shadow-sm" : "text-muted hover:text-ink"
              }`}
            >
              <input type="radio" className="absolute inset-0 m-0 cursor-pointer opacity-0" name={name ?? `${id}-r`} value={o.value} checked={checked} onChange={() => onChange(o.value)} />
              {o.label}
            </label>
          );
        })}
      </div>
    </div>
  );
}
