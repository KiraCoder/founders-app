"use client";

import { useState, useTransition } from "react";
import { archiveLabelAction, createLabelAction, deleteLabelAction, updateLabelAction, type LabelActionResult } from "@/app/(app)/settings/labels/actions";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";

export interface LabelRow {
  id: string;
  name: string;
  color: string;
  archived: boolean;
  uses: number;
}

function Swatches({ value, palette, onPick, name }: { value: string; palette: string[]; onPick: (c: string) => void; name: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label={`Color of ${name}`}>
      {palette.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value.toUpperCase() === c.toUpperCase()}
          aria-label={c}
          className={`size-5 rounded-full border-2 ${value.toUpperCase() === c.toUpperCase() ? "border-ink" : "border-transparent"}`}
          style={{ background: c }}
          onClick={() => onPick(c)}
        />
      ))}
      <input type="color" className="h-5 w-7 cursor-pointer rounded border border-line bg-transparent" value={value} aria-label="Any color" onChange={(e) => onPick(e.target.value.toUpperCase())} />
    </div>
  );
}

/** Settings → Labels: add, rename (inline), recolor, archive / restore, delete when unused. */
export function LabelsManager({ labels, palette }: { labels: LabelRow[]; palette: string[] }) {
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [color, setColor] = useState(palette[labels.length % palette.length] ?? "#2563EB");
  const [askDelete, setAskDelete] = useState<LabelRow | null>(null);
  const act = (fn: () => Promise<LabelActionResult>, after?: () => void) =>
    start(async () => {
      const r = await fn().catch(() => ({ ok: false, error: "Could not reach the server" }) as LabelActionResult);
      if (r.ok) {
        toast(r.message ?? "Saved");
        after?.();
      } else toast(r.error ?? "Something went wrong", { tone: "risk" });
    });
  const active = labels.filter((l) => !l.archived);
  const archived = labels.filter((l) => l.archived);
  return (
    <div className={`space-y-5 ${pending ? "opacity-70" : ""}`}>
      <form
        className="card flex flex-wrap items-center gap-3 p-4"
        aria-label="New label"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          act(() => createLabelAction(name, color), () => setName(""));
        }}
      >
        <span className="size-3 rounded-full" style={{ background: color }} aria-hidden="true" />
        <input className="input h-9 w-[220px]" placeholder="New label name" aria-label="New label name" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
        <Swatches value={color} palette={palette} onPick={setColor} name="the new label" />
        <button type="submit" className="btn btn-primary btn-sm" disabled={!name.trim() || pending}>
          Add label
        </button>
      </form>

      <section className="card" aria-labelledby="labels-active">
        <h2 id="labels-active" className="eyebrow px-4 pb-2 pt-4">
          Labels · {active.length}
        </h2>
        <ul className="divide-y divide-line border-t border-line">
          {active.length === 0 && <li className="px-4 py-3 text-[13px] text-muted">No labels yet.</li>}
          {active.map((l) => (
            <LabelItem key={l.id} label={l} palette={palette} pending={pending} act={act} onDelete={() => setAskDelete(l)} />
          ))}
        </ul>
      </section>

      {archived.length > 0 && (
        <section className="card" aria-labelledby="labels-archived">
          <h2 id="labels-archived" className="eyebrow px-4 pb-2 pt-4">
            Archived · kept on their tasks, not offered
          </h2>
          <ul className="divide-y divide-line border-t border-line">
            {archived.map((l) => (
              <LabelItem key={l.id} label={l} palette={palette} pending={pending} act={act} onDelete={() => setAskDelete(l)} />
            ))}
          </ul>
        </section>
      )}

      <ConfirmDialog
        open={!!askDelete}
        title={`Delete “${askDelete?.name}”?`}
        confirmLabel="Delete"
        tone="danger"
        onCancel={() => setAskDelete(null)}
        onConfirm={() => {
          const l = askDelete!;
          setAskDelete(null);
          act(() => deleteLabelAction(l.id));
        }}
      >
        <p>No task uses it, so nothing else changes.</p>
      </ConfirmDialog>
    </div>
  );
}

function LabelItem({
  label: l,
  palette,
  pending,
  act,
  onDelete,
}: {
  label: LabelRow;
  palette: string[];
  pending: boolean;
  act: (fn: () => Promise<LabelActionResult>, after?: () => void) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(l.name);
  const [recolor, setRecolor] = useState(false);
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-2.5" data-testid="label-row">
      <button
        type="button"
        className="size-4 shrink-0 rounded-full ring-offset-2 hover:ring-2 hover:ring-line"
        style={{ background: l.color }}
        aria-label={`Change the color of ${l.name}`}
        aria-expanded={recolor}
        onClick={() => setRecolor((v) => !v)}
      />
      <input
        className={`input h-8 w-[200px] border-transparent text-[14px] hover:border-line ${l.archived ? "text-muted" : ""}`}
        value={name}
        maxLength={40}
        aria-label={`Name of ${l.name}`}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name.trim() !== l.name && act(() => updateLabelAction(l.id, { name: name.trim() }))}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setName(l.name);
        }}
      />
      <span className="num text-[12px] text-muted">
        {l.uses} task{l.uses === 1 ? "" : "s"}
      </span>
      {recolor && <Swatches value={l.color} palette={palette} name={l.name} onPick={(c) => act(() => updateLabelAction(l.id, { color: c }), () => setRecolor(false))} />}
      <div className="ml-auto flex gap-1.5">
        <button type="button" className="btn btn-sm" disabled={pending} onClick={() => act(() => archiveLabelAction(l.id, !l.archived))}>
          {l.archived ? "Restore" : "Archive"}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm text-risk"
          disabled={pending || l.uses > 0}
          title={l.uses > 0 ? "Used by tasks: archive it instead" : "Delete"}
          onClick={onDelete}
        >
          Delete
        </button>
      </div>
    </li>
  );
}
