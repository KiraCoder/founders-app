"use client";

import { useRef, useState } from "react";
import type { OrgActionState } from "@/app/(app)/org/actions";
import { deptLabel, journeyNumber, type JourneyStepPatch, type JourneyTemplateKey } from "@/lib/org";
import type { OrgJourneyView } from "@/server/services/org-journey";

export interface JourneyHandlers {
  addStep: (label: string) => Promise<OrgActionState>;
  updateStep: (stepId: string, patch: JourneyStepPatch) => Promise<OrgActionState>;
  moveStep: (stepId: string, index: number) => Promise<OrgActionState>;
  removeStep: (stepId: string) => Promise<OrgActionState>;
  applyTemplate: (key: JourneyTemplateKey) => Promise<OrgActionState>;
}

/**
 * The journey strip above the board (like the old cockpit): numbered steps of the company's
 * work; clicking a step highlights its department. Founders edit it (Edit journey): rename,
 * link a department, reorder (← →), remove, add — and start from a template (Upsell Group).
 */
export function OrgJourneyStrip({
  journey,
  editable,
  departments,
  activeStepId,
  onSelect,
  h,
}: {
  journey: OrgJourneyView;
  editable: boolean;
  departments: { id: string; number: number; name: string }[];
  activeStepId: string | null;
  onSelect: (step: { id: string; departmentId: string | null } | null) => void;
  h: JourneyHandlers;
}) {
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState("");
  const { steps, template } = journey;
  if (!steps.length && !editable) return null;
  const sortedDepts = [...departments].sort((a, b) => a.number - b.number);

  return (
    <section aria-label="Journey" className="card mb-3 px-2.5 py-2" data-testid="org-journey">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="eyebrow">Journey</span>
        {steps.length > 0 && !editing && <span className="text-[11.5px] text-muted">Click a step to see its department</span>}
        {editable && (steps.length > 0 || editing) && (
          <button type="button" className={`btn btn-sm ml-auto ${editing ? "btn-primary" : "btn-ghost"}`} aria-pressed={editing} onClick={() => setEditing((v) => !v)}>
            {editing ? "Done" : "Edit journey"}
          </button>
        )}
      </div>

      {!steps.length && (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
          <span>No journey yet — the numbered steps of this company&apos;s work, each linked to the department doing it.</span>
          {template && (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void h.applyTemplate(template.key)} title={template.steps.map((s, i) => `${journeyNumber(i + 1)} ${s}`).join(" → ")} data-testid="org-journey-template">
              Use {template.label} template
            </button>
          )}
          {!editing && (
            <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
              + Add step
            </button>
          )}
        </div>
      )}

      {steps.length > 0 && !editing && (
        <ol className="flex gap-1 overflow-x-auto pb-1" aria-label="Journey steps">
          {steps.map((s, i) => {
            const active = s.id === activeStepId;
            return (
              <li key={s.id} className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => onSelect(active ? null : { id: s.id, departmentId: s.departmentId })}
                  className={`flex max-w-[190px] flex-col items-start rounded-[8px] border px-2 py-1 text-left ${active ? "border-accent bg-accent-soft" : "border-line bg-surface hover:bg-sunk"}`}
                  title={s.departmentLabel ? `${s.label} → ${s.departmentLabel}` : `${s.label} (no department yet)`}
                  data-testid="org-journey-step"
                >
                  <span className="flex items-baseline gap-1.5 text-[12.5px] font-semibold leading-[16px]">
                    <span className="num text-accent">{journeyNumber(s.number)}</span>
                    <span>{s.label}</span>
                  </span>
                  <span className={`text-[11px] leading-[14px] ${s.departmentArchived ? "text-risk" : "text-muted"}`}>
                    {s.departmentLabel ? `${s.departmentLabel}${s.departmentArchived ? " (archived)" : ""}` : "отдел не выбран"}
                  </span>
                </button>
                {i < steps.length - 1 && (
                  <span aria-hidden="true" className="text-muted">
                    →
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {editing && (
        <div className="flex flex-col gap-1.5" data-testid="org-journey-editor">
          {steps.map((s, i) => (
            <div key={s.id} className="flex flex-wrap items-center gap-1.5 rounded-[8px] border border-line bg-surface px-2 py-1.5">
              <span className="num w-6 text-[13px] font-bold text-accent">{journeyNumber(s.number)}</span>
              <StepLabel value={s.label} label={`Name of step ${journeyNumber(s.number)}`} onSave={(v) => void h.updateStep(s.id, { label: v })} />
              <select
                aria-label={`Department of step ${journeyNumber(s.number)}`}
                className="input h-8 w-auto max-w-[220px] text-[12.5px]"
                value={s.departmentId ?? ""}
                onChange={(e) => void h.updateStep(s.id, { departmentId: e.target.value || null })}
              >
                <option value="">— отдел не выбран —</option>
                {s.departmentId && !sortedDepts.some((d) => d.id === s.departmentId) && <option value={s.departmentId}>{s.departmentLabel}</option>}
                {sortedDepts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {deptLabel(d)}
                  </option>
                ))}
              </select>
              <span className="ml-auto flex gap-1">
                <button type="button" className="org-icon-btn" aria-label={`Move step ${journeyNumber(s.number)} earlier`} disabled={i === 0} onClick={() => void h.moveStep(s.id, i - 1)}>
                  ←
                </button>
                <button type="button" className="org-icon-btn" aria-label={`Move step ${journeyNumber(s.number)} later`} disabled={i === steps.length - 1} onClick={() => void h.moveStep(s.id, i + 1)}>
                  →
                </button>
                <button type="button" className="org-icon-btn" aria-label={`Remove step ${journeyNumber(s.number)}`} onClick={() => void h.removeStep(s.id)}>
                  ✕
                </button>
              </span>
            </div>
          ))}
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!adding.trim()) return;
              void h.addStep(adding.trim());
              setAdding("");
            }}
          >
            <input className="input h-8 flex-1 text-[13px]" aria-label="New journey step" placeholder={`${journeyNumber(steps.length + 1)} Новый шаг`} value={adding} maxLength={160} onChange={(e) => setAdding(e.target.value)} />
            <button type="submit" className="btn btn-sm" disabled={!adding.trim()}>
              + Step
            </button>
          </form>
        </div>
      )}
    </section>
  );
}

/** A step's name: an input saved on blur / Enter (Escape reverts). */
function StepLabel({ value, label, onSave }: { value: string; label: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  const cancelled = useRef(false);
  if (value !== seen) {
    setSeen(value);
    setDraft(value);
  }
  return (
    <input
      aria-label={label}
      className="input h-8 min-w-[140px] flex-1 text-[13px]"
      value={draft}
      maxLength={160}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const next = draft.trim();
        if (!cancelled.current && next && next !== value) onSave(next);
        else setDraft(value);
        cancelled.current = false;
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          cancelled.current = true;
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
