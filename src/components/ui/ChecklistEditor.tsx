"use client";

/**
 * ChecklistEditor — build a checklist item by item: title, optional details / instructions and a
 * "needs a comment" flag; move up / down, edit in place, delete; "+ Add item".
 *
 *   <ChecklistEditor name="items" value={items} onChange={setItems} error={fieldErrors?.items?.[0]} />
 *
 * - Controlled (`value` / `onChange`), items are `ChecklistDraftItem` ({ key?, label, details?,
 *   needsComment? }); an existing item keeps its `key` so the server can keep its state.
 * - With `name`, a hidden input carries the list as JSON for a <form> (the server parses it).
 * - `showNeedsComment={false}` hides the flag (e.g. a plain task checklist).
 * Accessible names: "Item 2 title", "Item 2 details", "Move item 2 up", "Delete item 2", "New item".
 */
import { useId, useRef, useState } from "react";
import { IconButton } from "./IconButton";

export interface ChecklistDraftItem {
  key?: string;
  label: string;
  details?: string;
  needsComment?: boolean;
}

export interface ChecklistEditorProps {
  value: ChecklistDraftItem[];
  onChange: (items: ChecklistDraftItem[]) => void;
  name?: string;
  max?: number;
  maxLabel?: number;
  showNeedsComment?: boolean;
  error?: string;
  placeholder?: string;
}

export function ChecklistEditor({ value, onChange, name, max = 20, maxLabel = 60, showNeedsComment = true, error, placeholder = "e.g. Kiwi Go: enter today's payments" }: ChecklistEditorProps) {
  const [draft, setDraft] = useState("");
  const [openDetails, setOpenDetails] = useState<Set<number>>(new Set());
  const newRef = useRef<HTMLInputElement>(null);
  const errId = useId();
  const set = (i: number, patch: Partial<ChecklistDraftItem>) => onChange(value.map((it, n) => (n === i ? { ...it, ...patch } : it)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const remove = (i: number) => onChange(value.filter((_, n) => n !== i));
  const add = () => {
    const label = draft.trim();
    if (!label || value.length >= max) return;
    onChange([...value, { label: label.slice(0, maxLabel), details: "", needsComment: false }]);
    setDraft("");
    newRef.current?.focus();
  };
  return (
    <div className="flex flex-col gap-2" aria-describedby={error ? errId : undefined}>
      {name && <input type="hidden" name={name} value={JSON.stringify(value.map((v) => ({ ...v, label: v.label.trim() })).filter((v) => v.label))} />}
      {value.length > 0 && (
        <ol className="flex flex-col gap-2" aria-label="Checklist items">
          {value.map((it, i) => {
            const n = i + 1;
            const showDetails = openDetails.has(i) || !!it.details;
            return (
              <li key={it.key ?? `new-${i}`} className="rounded-[var(--radius-btn)] border border-line bg-sunk/40 p-2">
                <div className="flex items-center gap-1.5">
                  <span className="num w-5 shrink-0 text-center text-[12px] text-muted">{n}</span>
                  <input
                    className="input h-8 min-w-0 flex-1"
                    aria-label={`Item ${n} title`}
                    value={it.label}
                    maxLength={maxLabel}
                    onChange={(e) => set(i, { label: e.target.value })}
                  />
                  <IconButton icon="chevronUp" size="sm" label={`Move item ${n} up`} disabled={i === 0} onClick={() => move(i, -1)} />
                  <IconButton icon="chevronDown" size="sm" label={`Move item ${n} down`} disabled={i === value.length - 1} onClick={() => move(i, 1)} />
                  <IconButton icon="trash" size="sm" tone="danger" label={`Delete item ${n}`} onClick={() => remove(i)} />
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-3 pl-6 text-[12px]">
                  {!showDetails && (
                    <button type="button" className="text-accent hover:underline" onClick={() => setOpenDetails(new Set(openDetails).add(i))}>
                      + details / instructions
                    </button>
                  )}
                  {showNeedsComment && (
                    <label className="flex items-center gap-1.5 text-muted">
                      <input type="checkbox" checked={!!it.needsComment} onChange={(e) => set(i, { needsComment: e.target.checked })} />
                      Needs a comment
                    </label>
                  )}
                </div>
                {showDetails && (
                  <textarea
                    className="input mt-1.5 ml-6 min-h-[44px] w-[calc(100%-1.5rem)] text-[13px]"
                    aria-label={`Item ${n} details`}
                    placeholder="Details or instructions (shown in italics under the item)"
                    value={it.details ?? ""}
                    maxLength={500}
                    onChange={(e) => set(i, { details: e.target.value })}
                  />
                )}
              </li>
            );
          })}
        </ol>
      )}
      {value.length < max ? (
        <div className="flex items-center gap-2">
          <input
            ref={newRef}
            className="input h-9 min-w-0 flex-1"
            aria-label="New item"
            placeholder={placeholder}
            value={draft}
            maxLength={maxLabel}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <button type="button" className="btn btn-sm" onClick={add} disabled={!draft.trim()}>
            + Add item
          </button>
        </div>
      ) : (
        <p className="text-[12px] text-muted">At most {max} items.</p>
      )}
      {error && (
        <p id={errId} className="text-[12px] text-risk">
          {error}
        </p>
      )}
    </div>
  );
}
