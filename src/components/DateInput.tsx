"use client";

import { useId, useRef, useState } from "react";
import { formatDisplayDate, parseDisplayDate } from "@/lib/dates";

/**
 * A date field that always shows and accepts **dd.mm.yyyy**, whatever the browser's language.
 * (A native `<input type="date">` shows mm/dd/yyyy in an English browser, and `lang="ru"` on
 * the input does not change that reliably — Chrome follows the browser locale.)
 *
 * - The visible field is text ("02.11.2026"); the value submitted with the form (hidden input
 *   `name`) and passed to `onChange` is the ISO date ("2026-11-02") the server expects.
 * - A wrong date (31.02.2026, 2-digit year, "tomorrow") blocks the form with a message; for a
 *   controlled field `onChange` gets the raw text so the server refuses it too.
 * - The calendar button opens the browser's own date picker (hidden native input).
 */
export function DateInput({
  id,
  name,
  value,
  defaultValue,
  onChange,
  min,
  max,
  required,
  className = "input",
  "aria-label": ariaLabel,
}: {
  id?: string;
  name?: string;
  /** Controlled: ISO date or "". */
  value?: string;
  /** Uncontrolled: initial ISO date. */
  defaultValue?: string;
  onChange?: (iso: string) => void;
  min?: string;
  max?: string;
  required?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const autoId = useId();
  const inputId = id ?? `date-${autoId}`;
  const controlled = value !== undefined;
  const [text, setText] = useState(() => formatDisplayDate(controlled ? value : defaultValue));
  const [iso, setIso] = useState(() => (controlled ? value : defaultValue) ?? "");
  const [error, setError] = useState<string | null>(null);
  const [lastValue, setLastValue] = useState(value);
  const textRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);

  // A controlled value changed from outside (e.g. reset): show it.
  if (controlled && value !== lastValue) {
    setLastValue(value);
    if (value !== iso) {
      setIso(value);
      setText(formatDisplayDate(value));
      setError(null);
    }
  }

  const problem = (raw: string): { iso: string; error: string | null } => {
    const parsed = parseDisplayDate(raw);
    if (parsed === "invalid") return { iso: raw, error: "Use dd.mm.yyyy, e.g. 02.11.2026" };
    if (parsed === null) return { iso: "", error: required ? "Enter a date" : null };
    if (min && parsed < min) return { iso: parsed, error: `Not before ${formatDisplayDate(min)}` };
    if (max && parsed > max) return { iso: parsed, error: `Not after ${formatDisplayDate(max)}` };
    return { iso: parsed, error: null };
  };

  const apply = (raw: string) => {
    setText(raw);
    const r = problem(raw);
    setError(r.error);
    textRef.current?.setCustomValidity(r.error ?? "");
    const next = r.error && parseDisplayDate(raw) === "invalid" ? raw : r.iso;
    setIso(next);
    if (controlled) setLastValue(next);
    onChange?.(next);
  };

  return (
    <div className="relative">
      <input
        ref={textRef}
        id={inputId}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="dd.mm.yyyy"
        className={`${className} pr-9 ${error ? "border-risk" : ""}`}
        value={text}
        onChange={(e) => apply(e.target.value)}
        onBlur={(e) => {
          // Normalise "2.1.2026" → "02.01.2026" once the founder leaves the field.
          const parsed = parseDisplayDate(e.target.value);
          if (parsed && parsed !== "invalid") setText(formatDisplayDate(parsed));
        }}
        required={required}
        aria-label={ariaLabel}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-err` : undefined}
        data-date-input=""
      />
      {name && <input type="hidden" name={name} value={iso} />}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-muted hover:text-ink"
        onClick={() => {
          const p = pickerRef.current;
          if (!p) return;
          p.value = parseDisplayDate(text) && parseDisplayDate(text) !== "invalid" ? (parseDisplayDate(text) as string) : "";
          try {
            p.showPicker();
          } catch {
            textRef.current?.focus();
          }
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <rect x="2" y="3" width="12" height="11" rx="1.5" />
          <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" />
        </svg>
      </button>
      <input
        ref={pickerRef}
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 right-0 h-0 w-0 opacity-0"
        min={min}
        max={max}
        onChange={(e) => {
          if (e.target.value) apply(formatDisplayDate(e.target.value));
        }}
      />
      {error && (
        <p id={`${inputId}-err`} className="mt-1 text-[12px] text-risk">
          {error}
        </p>
      )}
    </div>
  );
}
