"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import type { CompanyFormState } from "@/app/(app)/settings/companies/actions";
import { CompanyDot } from "@/components/ui";
import { SLUG_MAX, slugifyCompanyName } from "./slug";

export interface KindOption {
  value: string;
  label: string;
}

export interface CompanyFormValues {
  id?: string;
  name: string;
  slug: string;
  kind: string;
  color: string;
  legalName: string;
  description: string;
}

/** Preset dot colors (any hex can still be picked). */
const SWATCHES = ["#1E6B49", "#2F5D9E", "#B7791F", "#9B2C2C", "#6B46C1", "#2C7A7B", "#C05621", "#4A5568"];

function FieldError({ msg }: { msg?: string[] }) {
  return msg?.length ? <p className="mt-1 text-[12px] text-risk">{msg[0]}</p> : null;
}

/**
 * Add or edit form. On add, the slug follows the name until the founder edits it; on edit
 * it stays as saved (changing it changes the company's address).
 */
export function CompanyForm({
  action,
  initial,
  kinds,
  submitLabel,
  onDone,
  onCancel,
  idPrefix,
}: {
  action: (prev: CompanyFormState, fd: FormData) => Promise<CompanyFormState>;
  initial: CompanyFormValues;
  kinds: KindOption[];
  submitLabel: string;
  onDone?: (state: CompanyFormState) => void;
  onCancel?: () => void;
  idPrefix: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const isNew = !initial.id;
  const [name, setName] = useState(initial.name);
  const [slug, setSlug] = useState(initial.slug);
  const [slugEdited, setSlugEdited] = useState(!isNew);
  const [color, setColor] = useState(initial.color);
  const formRef = useRef<HTMLFormElement>(null);
  const lastNonce = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (state.ok && state.nonce && state.nonce !== lastNonce.current) {
      lastNonce.current = state.nonce;
      if (isNew) {
        formRef.current?.reset();
        setName("");
        setSlug("");
        setSlugEdited(false);
        setColor(initial.color);
      }
      onDone?.(state);
    }
  }, [state, isNew, initial.color, onDone]);

  const shownSlug = slugEdited ? slug : name.trim() ? slugifyCompanyName(name) : "";
  const fe = state.fieldErrors ?? {};
  const id = (k: string) => `${idPrefix}-${k}`;

  return (
    <form ref={formRef} action={formAction} className="grid gap-3 sm:grid-cols-2" data-testid={`${idPrefix}-form`}>
      {initial.id && <input type="hidden" name="id" value={initial.id} />}
      <div>
        <label className="label" htmlFor={id("name")}>
          Name
        </label>
        <input
          id={id("name")}
          name="name"
          className="input"
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Kiwi Go"
          autoFocus={isNew}
        />
        <FieldError msg={fe.name} />
      </div>
      <div>
        <label className="label" htmlFor={id("slug")}>
          Address (slug)
        </label>
        <input
          id={id("slug")}
          name="slug"
          className="input font-mono"
          maxLength={SLUG_MAX}
          value={shownSlug}
          onChange={(e) => {
            setSlugEdited(true);
            setSlug(e.target.value);
          }}
          placeholder={isNew ? "made from the name" : ""}
          required={!isNew}
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          title="Latin letters, digits and single hyphens"
        />
        <p className="mt-1 text-[12px] text-muted">/companies/{shownSlug || "…"}</p>
        <FieldError msg={fe.slug} />
      </div>
      <div>
        <label className="label" htmlFor={id("kind")}>
          Kind (dashboard template)
        </label>
        <select id={id("kind")} name="kind" className="input" defaultValue={initial.kind}>
          {kinds.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <FieldError msg={fe.kind} />
      </div>
      <div>
        <span className="label" id={id("color-label")}>
          Color
        </span>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby={id("color-label")}>
          {SWATCHES.map((s) => (
            <button
              key={s}
              type="button"
              aria-label={`Color ${s}`}
              aria-pressed={color.toUpperCase() === s}
              onClick={() => setColor(s)}
              className={`grid size-7 place-items-center rounded-full border ${
                color.toUpperCase() === s ? "border-ink" : "border-transparent"
              }`}
            >
              <CompanyDot color={s} size={16} />
            </button>
          ))}
          <input
            id={id("color")}
            name="color"
            type="color"
            aria-label="Custom color"
            className="h-7 w-10 cursor-pointer rounded border border-line bg-surface"
            value={color}
            onChange={(e) => setColor(e.target.value.toUpperCase())}
          />
        </div>
        <FieldError msg={fe.color} />
      </div>
      <div>
        <label className="label" htmlFor={id("legal")}>
          Legal name <span className="text-muted">(optional)</span>
        </label>
        <input id={id("legal")} name="legalName" className="input" maxLength={200} defaultValue={initial.legalName} placeholder="ОсОО …" />
        <FieldError msg={fe.legalName} />
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor={id("desc")}>
          Description <span className="text-muted">(optional)</span>
        </label>
        <textarea id={id("desc")} name="description" className="input" rows={2} maxLength={2000} defaultValue={initial.description} />
        <FieldError msg={fe.description} />
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        {state.error && !state.fieldErrors && (
          <p className="text-[12px] text-risk" role="alert">
            {state.error}
          </p>
        )}
      </div>
    </form>
  );
}
