"use client";

/**
 * The inline property pickers of a task (0034): status, priority, estimate, assignee, due date,
 * labels, company, project. Each is a trigger + a searchable Menu (keyboard: type, ↑ ↓, Enter,
 * 1–9). The same pickers serve the list rows (compact triggers) and the task page's Properties
 * sidebar (`variant="field"`: a full-width row with the value's name).
 */
import { useState, type ReactNode } from "react";
import { addDays, formatDueDate } from "@/lib/dates";
import { assigneePeopleOptions } from "@/lib/task-assignee";
import type { TaskPriorityValue, TaskStatusValue } from "@/lib/schemas";
import type { TaskFormOptions } from "@/server/services/options";
import { createLabelInlineAction } from "@/app/(app)/tasks/actions";
import { CompanyDot, InitialsAvatar } from "@/components/ui";
import { Menu, type MenuOption, type TriggerProps } from "@/components/ui/Menu";
import { toast } from "@/components/ui/Toast";
import { ESTIMATE_OPTIONS, PRIORITY_OPTIONS, STATUS_OPTIONS, estimateLabel, priorityLabel, statusLabel } from "./labels";
import { EstimateIcon, PriorityIcon, StatusIcon } from "./TaskIcons";

export type PickerVariant = "icon" | "chip" | "field";

const ICON_BTN =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-[6px] text-muted hover:bg-sunk hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none";
const CHIP_BTN =
  "inline-flex h-6 max-w-[160px] shrink-0 items-center gap-1 rounded-full border border-line px-2 text-[12px] text-muted hover:border-ink/30 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none";
const FIELD_BTN =
  "flex min-h-8 w-full min-w-0 items-center gap-2 rounded-[6px] px-2 text-left text-[13px] hover:bg-sunk focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none";

function Trigger({ p, variant, children, className = "", testId }: { p: TriggerProps; variant: PickerVariant; children: ReactNode; className?: string; testId?: string }) {
  const base = variant === "icon" ? ICON_BTN : variant === "chip" ? CHIP_BTN : FIELD_BTN;
  return (
    <button type="button" {...p} ref={p.ref as (el: HTMLButtonElement | null) => void} className={`${base} ${className}`} data-testid={testId}>
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Status / priority / estimate
// ---------------------------------------------------------------------------

export const STATUS_MENU: MenuOption[] = STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label, icon: <StatusIcon status={o.value} /> }));
export const PRIORITY_MENU: MenuOption[] = PRIORITY_OPTIONS.map((o) => ({ value: o.value, label: o.label, icon: <PriorityIcon priority={o.value} /> }));
export const ESTIMATE_MENU: MenuOption[] = [
  { value: "none", label: "No estimate", icon: <EstimateIcon /> },
  ...ESTIMATE_OPTIONS.map((n) => ({ value: String(n), label: `${n} point${n === 1 ? "" : "s"}`, hint: `${n} h`, icon: <EstimateIcon /> })),
];

export function StatusPicker({ value, onChange, variant = "icon", disabled }: { value: TaskStatusValue; onChange: (v: TaskStatusValue) => void; variant?: PickerVariant; disabled?: boolean }) {
  return (
    <Menu
      label="Change status"
      title={`Status: ${statusLabel(value)}`}
      options={STATUS_MENU}
      value={value}
      searchable
      disabled={disabled}
      onSelect={(v) => v !== value && onChange(v as TaskStatusValue)}
      trigger={(p) => (
        <Trigger p={p} variant={variant} testId="status-picker">
          <StatusIcon status={value} size={variant === "field" ? 14 : 14} />
          {variant !== "icon" && <span className="min-w-0 truncate text-ink">{statusLabel(value)}</span>}
        </Trigger>
      )}
    />
  );
}

export function PriorityPicker({ value, onChange, variant = "icon", disabled }: { value: TaskPriorityValue; onChange: (v: TaskPriorityValue) => void; variant?: PickerVariant; disabled?: boolean }) {
  return (
    <Menu
      label="Change priority"
      title={`Priority: ${priorityLabel(value)}`}
      options={PRIORITY_MENU}
      value={value}
      searchable
      disabled={disabled}
      onSelect={(v) => v !== value && onChange(v as TaskPriorityValue)}
      trigger={(p) => (
        <Trigger p={p} variant={variant} testId="priority-picker">
          <PriorityIcon priority={value} />
          {variant !== "icon" && <span className={`min-w-0 truncate ${value === "none" ? "text-muted" : "text-ink"}`}>{priorityLabel(value)}</span>}
        </Trigger>
      )}
    />
  );
}

export function EstimatePicker({ value, onChange, variant = "chip", disabled }: { value: number | null; onChange: (v: number | null) => void; variant?: PickerVariant; disabled?: boolean }) {
  return (
    <Menu
      label="Change estimate"
      title={`Estimate: ${estimateLabel(value)}`}
      options={ESTIMATE_MENU}
      value={value ? String(value) : "none"}
      searchable={false}
      disabled={disabled}
      onSelect={(v) => {
        const n = v === "none" ? null : Number(v);
        if (n !== value) onChange(n);
      }}
      trigger={(p) =>
        variant === "field" ? (
          <Trigger p={p} variant="field" testId="estimate-picker">
            <EstimateIcon className="text-muted" />
            <span className={value ? "text-ink" : "text-muted"}>{value ? `${value} points · ${value} h` : "No estimate"}</span>
          </Trigger>
        ) : (
          <Trigger p={p} variant="chip" testId="estimate-picker" className={value ? "" : "border-dashed opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"}>
            <EstimateIcon />
            <span className="num">{value ?? "–"}</span>
          </Trigger>
        )
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Assignee
// ---------------------------------------------------------------------------

export interface AssigneeTarget {
  visibility: "private" | "shared";
  companyId: string | null;
  assignee: { kind: "user" | "person"; id: string; name: string } | null;
}

/** Who can be picked for a task: founders (only me for a personal todo) and the company's people. */
export function assigneeOptions(t: AssigneeTarget, options: TaskFormOptions): MenuOption[] {
  const founders = options.founders.filter((f) => t.visibility === "shared" || f.id === options.currentUserId);
  const people =
    t.visibility === "shared" && t.companyId
      ? assigneePeopleOptions(options.peopleByCompany[t.companyId] ?? [], t.assignee, { taskCompanyId: t.companyId, companyId: t.companyId })
      : [];
  return [
    { value: "", label: "No assignee", icon: <span className="inline-block size-4 rounded-full border border-dashed border-muted" aria-hidden="true" /> },
    ...founders.map((f) => ({
      value: `user:${f.id}`,
      label: f.shortName,
      hint: f.id === options.currentUserId ? "me" : "founder",
      keywords: f.id === options.currentUserId ? "me" : "",
      group: "Founders",
      icon: <InitialsAvatar name={f.shortName} size="xs" />,
    })),
    ...people.map((p) => ({ value: `person:${p.id}`, label: p.name, group: "Team", icon: <InitialsAvatar name={p.name} size="xs" tone="neutral" /> })),
  ];
}

export function AssigneePicker({
  task,
  options,
  onChange,
  variant = "icon",
  disabled,
}: {
  task: AssigneeTarget;
  options: TaskFormOptions;
  onChange: (assignee: string, name: string | null) => void;
  variant?: PickerVariant;
  disabled?: boolean;
}) {
  const value = task.assignee ? `${task.assignee.kind}:${task.assignee.id}` : "";
  const list = assigneeOptions(task, options);
  const name = task.assignee?.name ?? null;
  return (
    <Menu
      label="Change assignee"
      title={name ? `Assignee: ${name}` : "No assignee"}
      options={list}
      value={value}
      searchable
      disabled={disabled}
      onSelect={(v) => v !== value && onChange(v, list.find((o) => o.value === v)?.label ?? null)}
      trigger={(p) => (
        <Trigger p={p} variant={variant} testId="assignee-picker" className={variant === "icon" ? "rounded-full" : ""}>
          {name ? (
            <InitialsAvatar name={name} size={variant === "field" ? "sm" : "xs"} tone={task.assignee?.kind === "person" ? "neutral" : "accent"} />
          ) : (
            <span className="inline-block size-4 rounded-full border border-dashed border-muted" aria-hidden="true" />
          )}
          {variant !== "icon" && <span className={`min-w-0 truncate ${name ? "text-ink" : "text-muted"}`}>{name ?? "No assignee"}</span>}
          {variant === "field" && task.assignee?.kind === "person" && <span className="ml-auto shrink-0 text-[11px] text-muted">Telegram</span>}
        </Trigger>
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Due date
// ---------------------------------------------------------------------------

export function DuePicker({
  value,
  today,
  overdue,
  onChange,
  variant = "chip",
  disabled,
}: {
  value: string | null;
  today: string;
  overdue: boolean;
  onChange: (v: string | null) => void;
  variant?: PickerVariant;
  disabled?: boolean;
}) {
  const nextMonday = (() => {
    const d = new Date(`${today}T00:00:00Z`).getUTCDay();
    return addDays(today, ((8 - d) % 7) || 7);
  })();
  const opts: MenuOption[] = [
    { value: today, label: "Today", hint: formatDueDate(today, today) },
    { value: addDays(today, 1), label: "Tomorrow", hint: formatDueDate(addDays(today, 1), today) },
    { value: nextMonday, label: "Next week", hint: formatDueDate(nextMonday, today) },
    { value: addDays(today, 14), label: "In two weeks", hint: formatDueDate(addDays(today, 14), today) },
    { value: "none", label: "No due date" },
  ];
  const shown = value ? formatDueDate(value, today) : null;
  return (
    <Menu
      label="Change due date"
      title={value ? `Due ${value}${overdue ? " (overdue)" : ""}` : "No due date"}
      options={opts}
      value={value ?? "none"}
      searchable={false}
      disabled={disabled}
      width={240}
      header={(close) => (
        <label className="flex items-center gap-2 text-[12px] text-muted">
          <span className="shrink-0">Date</span>
          <input
            type="date"
            className="input h-8 text-[13px]"
            aria-label="Pick a due date"
            defaultValue={value ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
                onChange(v);
                close();
              }
            }}
          />
        </label>
      )}
      onSelect={(v) => {
        const next = v === "none" ? null : v;
        if (next !== value) onChange(next);
      }}
      trigger={(p) =>
        variant === "field" ? (
          <Trigger p={p} variant="field" testId="due-picker">
            <CalendarGlyph className={overdue ? "text-risk" : "text-muted"} />
            <span className={overdue ? "font-medium text-risk" : value ? "text-ink" : "text-muted"}>
              {value ? `${shown}${overdue ? " · overdue" : ""}` : "No due date"}
            </span>
          </Trigger>
        ) : (
          <Trigger
            p={p}
            variant="chip"
            testId="due-picker"
            className={`${overdue ? "border-risk-line bg-risk-soft text-risk hover:text-risk" : value === today ? "border-warn-line text-warn" : ""} ${value ? "" : "border-dashed opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"}`}
          >
            <CalendarGlyph />
            <span className="num truncate">{shown ?? "Due"}</span>
          </Trigger>
        )
      }
    />
  );
}

function CalendarGlyph({ className = "" }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className={`shrink-0 ${className}`}>
      <path d="M8 2v3M16 2v3M3.5 9h17M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v13a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V6A1.5 1.5 0 0 1 5 4.5Z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export interface LabelLite {
  id: string;
  name: string;
  color: string;
}

export function LabelChip({ label }: { label: LabelLite }) {
  return (
    <span className="inline-flex h-5 max-w-[140px] shrink-0 items-center gap-1 rounded-full border border-line px-1.5 text-[11.5px] text-muted" data-testid="label-chip">
      <span className="size-2 shrink-0 rounded-full" style={{ background: label.color }} aria-hidden="true" />
      <span className="truncate">{label.name}</span>
    </span>
  );
}

/** The label menu: tick several, create a new one from the search text. Keeps labels created here. */
export function LabelsPicker({
  value,
  options,
  onChange,
  variant = "chip",
  disabled,
  max = 3,
}: {
  value: readonly LabelLite[];
  options: TaskFormOptions;
  onChange: (ids: string[], labels: LabelLite[]) => void;
  variant?: PickerVariant;
  disabled?: boolean;
  /** Chips shown on a row before "+N". */
  max?: number;
}) {
  const [extra, setExtra] = useState<LabelLite[]>([]);
  const all = [...options.labels, ...extra.filter((e) => !options.labels.some((l) => l.id === e.id)), ...value.filter((v) => !options.labels.some((l) => l.id === v.id) && !extra.some((e) => e.id === v.id))];
  const ids = value.map((l) => l.id);
  const menu: MenuOption[] = all.map((l) => ({ value: l.id, label: l.name, icon: <span className="size-2.5 rounded-full" style={{ background: l.color }} aria-hidden="true" /> }));
  const toggle = (id: string) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    onChange(next, all.filter((l) => next.includes(l.id)));
  };
  return (
    <Menu
      label="Change labels"
      title={value.length ? `Labels: ${value.map((l) => l.name).join(", ")}` : "Add labels"}
      options={menu}
      value={ids}
      multiple
      searchable
      disabled={disabled}
      placeholder="Search or create a label…"
      createLabel={(t) => `Create label “${t}”`}
      onCreate={async (name) => {
        const r = await createLabelInlineAction(name);
        if (!r.ok || !r.label) {
          toast(r.error ?? "Could not create the label", { tone: "risk" });
          return;
        }
        setExtra((x) => [...x, r.label!]);
        onChange([...ids, r.label.id], [...value, r.label]);
      }}
      onSelect={toggle}
      trigger={(p) =>
        variant === "field" ? (
          <Trigger p={p} variant="field" testId="labels-picker" className="flex-wrap py-1">
            {value.length ? value.map((l) => <LabelChip key={l.id} label={l} />) : <span className="text-muted">Add labels</span>}
          </Trigger>
        ) : (
          <button
            type="button"
            {...p}
            ref={p.ref as (el: HTMLButtonElement | null) => void}
            data-testid="labels-picker"
            className={`inline-flex min-w-0 shrink items-center gap-1 rounded-full focus-visible:outline-2 focus-visible:outline-accent ${value.length ? "" : `${CHIP_BTN} border-dashed opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100`}`}
          >
            {value.length ? (
              <>
                {value.slice(0, max).map((l) => (
                  <LabelChip key={l.id} label={l} />
                ))}
                {value.length > max && <span className="num text-[11.5px] text-muted">+{value.length - max}</span>}
              </>
            ) : (
              <span>Label</span>
            )}
          </button>
        )
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Company / project
// ---------------------------------------------------------------------------

export function CompanyPicker({
  value,
  options,
  allowNone,
  onChange,
  variant = "chip",
  disabled,
  limitTo,
}: {
  value: { id: string; name: string; color: string } | null;
  options: TaskFormOptions;
  /** A personal todo may have no company. */
  allowNone: boolean;
  onChange: (id: string | null) => void;
  variant?: PickerVariant;
  disabled?: boolean;
  /** Only these companies (the assigned person's). */
  limitTo?: string[] | null;
}) {
  const list = options.companies.filter((c) => !limitTo || limitTo.includes(c.id) || c.id === value?.id);
  const menu: MenuOption[] = [
    ...(allowNone ? [{ value: "none", label: "No company (personal)" }] : []),
    ...list.map((c) => ({ value: c.id, label: c.name, icon: <CompanyDot color={c.color} size={8} /> })),
  ];
  return (
    <Menu
      label="Change company"
      title={value ? `Company: ${value.name}` : "No company"}
      options={menu}
      value={value?.id ?? "none"}
      searchable
      disabled={disabled}
      onSelect={(v) => {
        const next = v === "none" ? null : v;
        if (next !== (value?.id ?? null)) onChange(next);
      }}
      trigger={(p) => (
        <Trigger p={p} variant={variant} testId="company-picker">
          {value ? <CompanyDot color={value.color} size={7} /> : null}
          <span className={`min-w-0 truncate ${value ? (variant === "field" ? "text-ink" : "") : "text-muted"}`}>{value?.name ?? "No company"}</span>
        </Trigger>
      )}
    />
  );
}

export function ProjectPicker({
  value,
  companyId,
  options,
  onChange,
  variant = "chip",
  disabled,
}: {
  value: { id: string; name: string } | null;
  companyId: string | null;
  options: TaskFormOptions;
  onChange: (id: string | null) => void;
  variant?: PickerVariant;
  disabled?: boolean;
}) {
  const list = options.projects.filter((p) => !companyId || p.companyId === companyId);
  const menu: MenuOption[] = [{ value: "none", label: "No project" }, ...list.map((p) => ({ value: p.id, label: p.name, icon: <FolderGlyph /> }))];
  return (
    <Menu
      label="Change project"
      title={value ? `Project: ${value.name}` : "No project"}
      options={menu}
      value={value?.id ?? "none"}
      searchable
      disabled={disabled}
      onSelect={(v) => {
        const next = v === "none" ? null : v;
        if (next !== (value?.id ?? null)) onChange(next);
      }}
      trigger={(p) => (
        <Trigger p={p} variant={variant} testId="project-picker" className={variant === "chip" && !value ? "hidden" : ""}>
          <FolderGlyph />
          <span className={`min-w-0 truncate ${value ? (variant === "field" ? "text-ink" : "") : "text-muted"}`}>{value?.name ?? "No project"}</span>
        </Trigger>
      )}
    />
  );
}

function FolderGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="shrink-0">
      <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-11Z" />
    </svg>
  );
}
