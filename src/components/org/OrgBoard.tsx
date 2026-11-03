"use client";

import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import {
  createDepartmentAction,
  createFunctionAction,
  createPersonAndAssignAction,
  moveDepartmentAction,
  moveFunctionAction,
  setArchivedAction,
  undoAction,
  updateDepartmentAction,
  updateDivisionAction,
  updateFunctionAction,
  type OrgActionState,
} from "@/app/(app)/org/actions";
import { formatDisplayDateTime } from "@/lib/dates";
import { defaultOrgRole, deptLabel, personInitials, placeAt, type OrgAssignTarget } from "@/lib/org";
import type { OrgChartView, OrgDepartmentView, OrgDivisionView, OrgFunctionView } from "@/server/services/org";
import { DepartmentPanel, DivisionPanel, type CreatePersonFor } from "./OrgPanels";
import { PersonPicker, type NewPersonData, type PersonOption } from "./PersonPicker";

export type { PersonOption };

export interface LinkedMetric {
  label: string;
  value: string | null;
  period: string | null;
  freshness: string;
  tone: "ok" | "warn" | "risk";
}

type Panel = { kind: "department" | "division"; id: string } | null;
type DragData = { type: "function"; id: string; deptId: string } | { type: "department"; id: string; divId: string } | { type: "fzone"; deptId: string } | { type: "dzone"; divId: string };

// ---------------------------------------------------------------------------
// Local (optimistic) moves — the server does the same and is the source of truth
// ---------------------------------------------------------------------------

function moveFunctionLocal(chart: OrgChartView, fnId: string, deptId: string, index: number): OrgChartView {
  const all = chart.divisions.flatMap((d) => d.departments);
  const fn = all.flatMap((d) => d.functions).find((f) => f.id === fnId);
  if (!fn) return chart;
  return {
    ...chart,
    divisions: chart.divisions.map((div) => ({
      ...div,
      departments: div.departments.map((d) => {
        if (d.id === deptId) return { ...d, functions: placeAt(d.functions.filter((f) => f.id !== fnId), { ...fn, departmentId: deptId }, index) };
        if (d.functions.some((f) => f.id === fnId)) return { ...d, functions: d.functions.filter((f) => f.id !== fnId) };
        return d;
      }),
    })),
  };
}

function moveDepartmentLocal(chart: OrgChartView, deptId: string, divId: string, index: number): OrgChartView {
  const dept = chart.divisions.flatMap((d) => d.departments).find((d) => d.id === deptId);
  if (!dept) return chart;
  return {
    ...chart,
    divisions: chart.divisions.map((div) => {
      const rest = div.departments.filter((d) => d.id !== deptId);
      return div.id === divId ? { ...div, departments: placeAt(rest, { ...dept, divisionId: divId }, index) } : { ...div, departments: rest };
    }),
  };
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

/** Text that becomes an inline editor in edit mode; saves on blur (Enter saves single-line fields, Escape reverts). */
function InlineText({
  value,
  editing,
  onSave,
  label,
  className = "",
  placeholder = "",
  multiline = true,
}: {
  value: string;
  editing: boolean;
  onSave: (next: string) => void;
  label: string;
  className?: string;
  placeholder?: string;
  multiline?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setDraft(value);
  }
  if (!editing) return value ? <span className={className}>{value}</span> : placeholder ? <span className={`${className} text-muted italic`}>{placeholder}</span> : null;
  return (
    <textarea
      aria-label={label}
      value={draft}
      rows={1}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft.trim() !== value.trim()) onSave(draft.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setDraft(value);
          (e.target as HTMLTextAreaElement).blur();
        } else if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
      className={`org-inline w-full resize-none rounded-[6px] border border-dashed border-line bg-surface/70 px-1 py-0.5 ${className}`}
    />
  );
}

/** "+ Функция" / "+ Отдел": a dashed button that turns into a one-line input. */
function AddInline({ label, placeholder, onAdd, onStart, testId }: { label: string; placeholder: string; onAdd: (text: string) => void; onStart?: () => void; testId?: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  if (!open) {
    return (
      <button
        type="button"
        className="org-add"
        onClick={() => {
          onStart?.();
          setOpen(true);
        }}
        data-testid={testId}
      >
        {label}
      </button>
    );
  }
  const submit = () => {
    if (text.trim()) onAdd(text.trim());
    setText("");
    setOpen(false);
  };
  return (
    <input
      autoFocus
      aria-label={placeholder}
      placeholder={placeholder}
      className="input h-8 text-[13px]"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={submit}
      onKeyDown={(e) => {
        if (e.key === "Enter") submit();
        if (e.key === "Escape") {
          setText("");
          setOpen(false);
        }
      }}
    />
  );
}

/** A small "⋯" menu (keyboard and phone path for moves; drag stays the laptop path). */
function ItemMenu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative shrink-0">
      <button type="button" aria-label={label} aria-expanded={open} className="org-icon-btn" onClick={() => setOpen((v) => !v)}>
        ⋯
      </button>
      {open && (
        <div role="menu" aria-label={label} className="card-raised absolute right-0 top-7 z-30 flex w-[230px] flex-col gap-1 p-2 text-[13px]">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuButton({ onClick, children, disabled }: { onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" role="menuitem" className="rounded-[6px] px-2 py-1.5 text-left hover:bg-sunk disabled:opacity-40" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

/** Responsible person of a function: initials in a small circle, the full name on hover / focus. */
function Initials({ fullName }: { fullName: string }) {
  return (
    <span tabIndex={0} className="org-initials" title={fullName} data-tip={fullName} aria-label={`Responsible: ${fullName}`} data-testid="org-initials">
      {personInitials(fullName)}
    </span>
  );
}

/**
 * "+ назначить" (founders, view mode): a small popover with the company's people and
 * "+ New person". Picking someone saves at once.
 */
function AssignPopover({
  what,
  target,
  targetId,
  defaultRole,
  h,
  align = "left",
}: {
  /** "head of 1 Найм и ввод в должность" — for screen readers. */
  what: string;
  target: OrgAssignTarget;
  targetId: string;
  defaultRole: string;
  h: BoardHandlers;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <span ref={ref} className="relative inline-block">
      <button type="button" className="org-assign" aria-expanded={open} aria-label={`Assign ${what}`} onClick={() => setOpen((v) => !v)}>
        + назначить
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={`Assign ${what}`}
          className={`card-raised absolute top-6 z-30 flex w-[260px] flex-col gap-1 p-2.5 text-[13px] ${align === "right" ? "right-0" : "left-0"}`}
          data-testid="org-assign-popover"
        >
          <PersonPicker
            id={`org-assign-${targetId}`}
            label={`Assign ${what}`}
            value=""
            people={h.people}
            autoFocus
            defaultRole={defaultRole}
            onChange={(personId) => {
              if (!personId) return;
              if (target === "function") h.saveFunction(targetId, { responsiblePersonId: personId });
              else if (target === "department") h.saveDepartment(targetId, { headPersonId: personId });
              else h.saveDivision(targetId, { headPersonId: personId });
              setOpen(false);
            }}
            onCreate={async (data) => {
              const res = await h.createPerson(target, targetId, data);
              if (res.ok) setOpen(false);
              return res;
            }}
          />
        </div>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

export function OrgBoard({
  chart: serverChart,
  company,
  editable,
  people,
  metrics,
  linkedMetrics,
  showArchived,
  archivedHref,
  timeZone,
}: {
  chart: OrgChartView;
  company: { id: string; slug: string; name: string };
  editable: boolean;
  people: PersonOption[];
  metrics: { id: string; label: string }[];
  linkedMetrics: Record<string, LinkedMetric>;
  showArchived: boolean;
  archivedHref: string;
  timeZone: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  // The server copy wins whenever it changes (after every saved change); in between, moves
  // are shown at once (optimistic) and rolled back if the server refuses them.
  const [chart, setChart] = useState(serverChart);
  const [synced, setSynced] = useState(serverChart);
  if (serverChart !== synced) {
    setSynced(serverChart);
    setChart(serverChart);
  }
  const [editMode, setEditMode] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [mobileDiv, setMobileDiv] = useState(serverChart.divisions[0]?.id ?? "");
  const [dragging, setDragging] = useState<{ label: string } | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const editing = editable && editMode;

  // Optimistic concurrency (review #6): every change carries the chart version this board
  // shows; the server refuses it when the chart changed meanwhile. Changes run one after
  // another, each with the version the previous one returned.
  const version = useRef(serverChart.version);
  useEffect(() => {
    if (Number(serverChart.version) > Number(version.current)) version.current = serverChart.version;
  }, [serverChart.version]);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const act = (fn: (version: string) => Promise<OrgActionState>, optimistic?: OrgChartView): Promise<OrgActionState> => {
    const before = chart;
    if (optimistic) setChart(optimistic);
    const run = queue.current.then(async (): Promise<OrgActionState> => {
      let res: OrgActionState;
      try {
        res = await fn(version.current);
      } catch {
        res = { ok: false, error: "Not saved — check the connection and try again" };
      }
      if (!res.ok) {
        setChart(before);
        setNotice({ text: res.error ?? "Not saved", error: true });
        if (res.conflict) router.refresh();
        return res;
      }
      if (res.version) version.current = res.version;
      setNotice(res.message ? { text: res.message } : null);
      router.refresh();
      return res;
    });
    queue.current = run;
    start(async () => {
      await run;
    });
    return run;
  };

  const departments = chart.divisions.flatMap((d) => d.departments);
  const deptById = (id: string) => departments.find((d) => d.id === id);
  const moveFunction = (fnId: string, deptId: string, index: number) =>
    void act((v) => moveFunctionAction(fnId, deptId, index, v), moveFunctionLocal(chart, fnId, deptId, index));
  const moveDepartment = (deptId: string, divId: string, index: number) =>
    void act((v) => moveDepartmentAction(deptId, divId, index, v), moveDepartmentLocal(chart, deptId, divId, index));

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  // A function lands on functions or a department's list; a department on departments or a division's list.
  const collision: CollisionDetection = (args) => {
    const type = (args.active.data.current as DragData | undefined)?.type;
    const fits = (t?: string) => (type === "function" ? t === "function" || t === "fzone" : t === "department" || t === "dzone");
    const droppableContainers = args.droppableContainers.filter((c) => fits((c.data.current as DragData | undefined)?.type));
    const within = pointerWithin({ ...args, droppableContainers });
    if (within.length) {
      const items = within.filter((c) => (droppableContainers.find((x) => x.id === c.id)?.data.current as DragData | undefined)?.type === type);
      return items.length ? items : within;
    }
    // Keyboard drags have no pointer: closest corners (not centres) picks the right neighbour
    // between cards of different heights; same-type items first, a list's empty zone otherwise.
    const sameType = droppableContainers.filter((c) => (c.data.current as DragData | undefined)?.type === type);
    const near = closestCorners({ ...args, droppableContainers: sameType.length ? sameType : droppableContainers });
    return near.length ? near : closestCorners({ ...args, droppableContainers });
  };

  const onDragStart = (e: DragStartEvent) => {
    const a = e.active.data.current as DragData;
    if (a.type === "function") setDragging({ label: departments.flatMap((d) => d.functions).find((f) => f.id === a.id)?.text ?? "" });
    if (a.type === "department") setDragging({ label: deptLabel(deptById(a.id) ?? { number: 0, name: "" }) });
  };

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const a = e.active.data.current as DragData | undefined;
    const o = e.over?.data.current as DragData | undefined;
    if (!a || !o) return;
    if (a.type === "function") {
      const from = deptById(a.deptId);
      if (o.type === "function") {
        const target = deptById(o.deptId);
        if (!target || o.id === a.id) return;
        const index = target.functions.findIndex((f) => f.id === o.id);
        if (target.id === from?.id && from.functions.findIndex((f) => f.id === a.id) === index) return;
        moveFunction(a.id, target.id, index);
      } else if (o.type === "fzone" && o.deptId !== a.deptId) {
        moveFunction(a.id, o.deptId, deptById(o.deptId)?.functions.length ?? 0);
      }
    } else if (a.type === "department") {
      if (o.type === "department") {
        const div = chart.divisions.find((d) => d.id === o.divId);
        if (!div || o.id === a.id) return;
        moveDepartment(a.id, div.id, div.departments.findIndex((d) => d.id === o.id));
      } else if (o.type === "dzone" && o.divId !== a.divId) {
        moveDepartment(a.id, o.divId, chart.divisions.find((d) => d.id === o.divId)?.departments.length ?? 0);
      }
    }
  };

  // Screen readers hear names, not ids ("Picked up Testing … dropped on 4 Маркетинг").
  const nameOf = (id: string | number | undefined): string => {
    const [kind, raw] = String(id ?? "").split(":");
    if (kind === "f") return `function ${departments.flatMap((d) => d.functions).find((f) => f.id === raw)?.text ?? ""}`;
    if (kind === "d" || kind === "fz") return `department ${deptLabel(deptById(raw ?? "") ?? { number: 0, name: "" })}`;
    if (kind === "dz") return `division ${deptLabel(chart.divisions.find((d) => d.id === raw) ?? { number: 0, name: "" })}`;
    return "";
  };
  const accessibility = {
    screenReaderInstructions: { draggable: "Press space or enter to pick up. Use the arrow keys to move, space or enter to drop, escape to cancel." },
    announcements: {
      onDragStart: ({ active }: { active: { id: string | number } }) => `Picked up ${nameOf(active.id)}.`,
      onDragOver: ({ active, over }: { active: { id: string | number }; over: { id: string | number } | null }) =>
        over ? `${nameOf(active.id)} is over ${nameOf(over.id)}.` : `${nameOf(active.id)} is not over a drop place.`,
      onDragEnd: ({ active, over }: { active: { id: string | number }; over: { id: string | number } | null }) =>
        over ? `Dropped ${nameOf(active.id)} at ${nameOf(over.id)}.` : `Dropped ${nameOf(active.id)}.`,
      onDragCancel: ({ active }: { active: { id: string | number } }) => `Moving ${nameOf(active.id)} was cancelled.`,
    },
  };

  const createPerson: CreatePersonFor = (target, targetId, data: NewPersonData) =>
    act((v) => createPersonAndAssignAction({ target, targetId, ...data }, v));

  const handlers: BoardHandlers = {
    editing,
    editable,
    showArchived,
    departments,
    divisions: chart.divisions,
    people,
    open: (p) => setPanel(p),
    startEditing: () => setEditMode(true),
    saveDivision: (id, patch) => void act((v) => updateDivisionAction(id, patch, v)),
    saveDepartment: (id, patch) => void act((v) => updateDepartmentAction(id, patch, v)),
    saveFunction: (id, patch) => void act((v) => updateFunctionAction(id, patch, v)),
    addFunction: (deptId, text) => void act((v) => createFunctionAction(deptId, text, v)),
    addDepartment: (divId, name) => void act((v) => createDepartmentAction(divId, name, v)),
    archive: (entity, id, archived) => void act((v) => setArchivedAction(entity, id, archived, v)),
    createPerson,
    moveFunction,
    moveDepartment,
  };

  const panelDept = panel?.kind === "department" ? deptById(panel.id) : undefined;
  const panelDiv = panel?.kind === "division" ? chart.divisions.find((d) => d.id === panel.id) : undefined;

  return (
    <div data-testid="org-board" data-edit={editing ? "1" : "0"}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {editable && (
          <button type="button" className={`btn btn-sm ${editMode ? "btn-primary" : ""}`} aria-pressed={editMode} onClick={() => setEditMode((v) => !v)}>
            {editMode ? "Done editing" : "Edit mode"}
          </button>
        )}
        {editable && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={!chart.undo || pending}
            title={chart.undo ? `Undo: ${chart.undo.summary}` : "Nothing to undo"}
            onClick={() => void act((v) => undoAction(chart.id, v))}
          >
            Undo{chart.undoAvailable ? ` (${chart.undoAvailable})` : ""}
          </button>
        )}
        <Link href={archivedHref} className="btn btn-sm btn-ghost">
          {showArchived ? "Hide archived" : "Show archived"}
        </Link>
        <details className="relative">
          <summary className="btn btn-sm btn-ghost list-none">History</summary>
          <div className="card-raised absolute left-0 top-9 z-30 w-[min(420px,85vw)] p-3">
            <p className="eyebrow mb-2">Last {chart.history.length} changes</p>
            <ul className="flex max-h-[320px] flex-col gap-2 overflow-y-auto text-[12.5px]" data-testid="org-history">
              {chart.history.map((h) => (
                <li key={h.id} className={h.undone ? "text-muted line-through" : ""}>
                  {h.summary}
                  <span className="block text-[11.5px] text-muted no-underline">
                    {h.actorName ?? "Seed"} · {formatDisplayDateTime(h.at, timeZone)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </details>
        {pending && <span className="text-[12px] text-muted">Saving…</span>}
        {notice && (
          <span role="status" className={`text-[12px] ${notice.error ? "text-risk" : "text-muted"}`}>
            {notice.text}
          </span>
        )}
        {editing && <span className="ml-auto hidden text-[12px] text-muted md:inline">Drag ⠿ to move · ⋯ for keyboard moves · click a text to edit</span>}
      </div>

      {/* Phone: one division at a time. */}
      <nav className="-mx-4 mb-3 flex gap-1.5 overflow-x-auto px-4 md:hidden" aria-label="Divisions">
        {chart.divisions.map((d) => (
          <button
            key={d.id}
            type="button"
            aria-pressed={d.id === mobileDiv}
            onClick={() => setMobileDiv(d.id)}
            className={`btn btn-sm shrink-0 ${d.id === mobileDiv ? "btn-primary" : ""}`}
          >
            <span className="num font-bold">{d.number}</span> {d.name || "—"}
          </button>
        ))}
      </nav>

      <DndContext accessibility={accessibility} sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
        <div className="org-scroll -mx-4 overflow-x-auto px-4 pb-3 md:mx-0 md:px-0">
          <div className="flex items-start gap-3 md:w-max">
            {chart.divisions.map((div) => (
              <DivisionColumn key={div.id} division={div} h={handlers} mobileHidden={div.id !== mobileDiv} />
            ))}
          </div>
        </div>
        <DragOverlay>{dragging ? <div className="card-raised max-w-[260px] px-3 py-2 text-[12.5px]">{dragging.label}</div> : null}</DragOverlay>
      </DndContext>

      {panelDept && (
        <DepartmentPanel
          key={`${panelDept.id}:${chart.version}`}
          dept={panelDept}
          companySlug={company.slug}
          editable={editable}
          people={people}
          metrics={metrics}
          linked={panelDept.metricDefinitionId ? (linkedMetrics[panelDept.metricDefinitionId] ?? null) : null}
          onClose={() => setPanel(null)}
          onSave={(patch) => handlers.saveDepartment(panelDept.id, patch)}
          onSaveFunction={handlers.saveFunction}
          onAddFunction={(text) => handlers.addFunction(panelDept.id, text)}
          onCreatePerson={editable ? createPerson : undefined}
          onArchive={() => {
            handlers.archive("department", panelDept.id, true);
            setPanel(null);
          }}
        />
      )}
      {panelDiv && (
        <DivisionPanel
          key={`${panelDiv.id}:${chart.version}`}
          division={panelDiv}
          editable={editable}
          people={people}
          onClose={() => setPanel(null)}
          onSave={(patch) => handlers.saveDivision(panelDiv.id, patch)}
          onCreatePerson={editable ? createPerson : undefined}
        />
      )}
    </div>
  );
}

interface BoardHandlers {
  editing: boolean;
  editable: boolean;
  showArchived: boolean;
  departments: OrgDepartmentView[];
  divisions: OrgDivisionView[];
  people: PersonOption[];
  open: (p: Panel) => void;
  /** "+ Функция" / "+ Отдел" in view mode switch the board to edit mode. */
  startEditing: () => void;
  saveDivision: (id: string, patch: Record<string, string | null>) => void;
  saveDepartment: (id: string, patch: Record<string, string | number | null>) => void;
  saveFunction: (id: string, patch: Record<string, string | null>) => void;
  addFunction: (deptId: string, text: string) => void;
  addDepartment: (divId: string, name: string) => void;
  archive: (entity: "department" | "function", id: string, archived: boolean) => void;
  createPerson: CreatePersonFor;
  moveFunction: (fnId: string, deptId: string, index: number) => void;
  moveDepartment: (deptId: string, divId: string, index: number) => void;
}

function DivisionColumn({ division: d, h, mobileHidden }: { division: OrgDivisionView; h: BoardHandlers; mobileHidden: boolean }) {
  const { setNodeRef } = useDroppable({ id: `dz:${d.id}`, data: { type: "dzone", divId: d.id } satisfies DragData });
  return (
    <section
      aria-label={`Division ${d.number} ${d.name}`}
      data-testid="org-division"
      data-number={d.number}
      className={`${mobileHidden ? "hidden" : "flex"} card w-full shrink-0 flex-col md:flex md:w-[212px]`}
    >
      <header className="flex flex-col gap-1 p-2.5">
        <div className="flex items-start justify-between gap-2">
          <span className="num text-[34px] font-bold leading-[34px] text-accent">{d.number}</span>
          <button type="button" className="org-icon-btn mt-1" aria-label={`Details of division ${d.number}`} onClick={() => h.open({ kind: "division", id: d.id })}>
            ⓘ
          </button>
        </div>
        <h3 className="text-[14px] font-semibold leading-[18px]">
          <InlineText value={d.name} editing={h.editing} label={`Name of division ${d.number}`} multiline={false} onSave={(v) => h.saveDivision(d.id, { name: v })} />
          {d.nameIsDefault && <span className="tag ml-1.5 align-middle" title="The template's name — rename it if it does not fit">default name</span>}
        </h3>
        <p className="text-[12px] leading-[17px]" data-testid="org-division-head">
          <span className="font-semibold">Руководитель:</span>{" "}
          <InlineText value={d.headTitle} editing={h.editing} label={`Head title of division ${d.number}`} multiline={false} className="text-muted" onSave={(v) => h.saveDivision(d.id, { headTitle: v })} />
          {d.headName &&
            (h.editing ? (
              <span className="tag tag-ok ml-1">{d.headName}</span>
            ) : (
              <>
                {d.headTitle ? " — " : ""}
                <span className="font-semibold" title={d.headFullName ?? undefined} data-testid="org-head-name">
                  {d.headName}
                </span>
              </>
            ))}
          {!d.headPersonId && h.editable && !h.editing && (
            <>
              {" "}
              <AssignPopover what={`head of division ${deptLabel(d)}`} target="division" targetId={d.id} defaultRole={defaultOrgRole(d.headTitle || d.name)} h={h} />
            </>
          )}
        </p>
        {(d.reportsTo || h.editing) && (
          <p className="rounded-[6px] bg-sunk px-2 py-0.5 text-[11px] text-muted">
            Подчинение:{" "}
            <InlineText value={d.reportsTo} editing={h.editing} label={`Подчинение of division ${d.number}`} multiline={false} onSave={(v) => h.saveDivision(d.id, { reportsTo: v })} />
          </p>
        )}
        {(d.ckp || h.editing) && (
          <div className="rounded-[8px] bg-accent-soft px-2 py-1.5 text-[12px] leading-[17px]">
            <span className="font-semibold">ЦКП:</span>{" "}
            <InlineText value={d.ckp} editing={h.editing} label={`ЦКП of division ${d.number}`} onSave={(v) => h.saveDivision(d.id, { ckp: v })} />
          </div>
        )}
      </header>
      <div ref={setNodeRef} className="flex flex-col gap-2 border-t border-line p-2">
        <SortableContext items={d.departments.map((x) => `d:${x.id}`)} strategy={verticalListSortingStrategy}>
          {d.departments.map((dept, i) => (
            <DepartmentCard key={dept.id} dept={dept} index={i} count={d.departments.length} division={d} h={h} />
          ))}
        </SortableContext>
        {h.showArchived &&
          d.archivedDepartments.map((dept) => (
            <div key={dept.id} className="flex items-center justify-between gap-2 rounded-[10px] border border-dashed border-line px-2.5 py-2 text-[12.5px] text-muted" data-testid="org-archived-department">
              <span>
                <span className="num font-bold">{dept.number}</span> {dept.name} · archived
              </span>
              {h.editable && (
                <button type="button" className="btn btn-sm" onClick={() => h.archive("department", dept.id, false)}>
                  Restore
                </button>
              )}
            </div>
          ))}
        {h.editable && <AddInline label="+ Отдел" placeholder={`Name of a new department in division ${d.number}`} onStart={h.startEditing} onAdd={(name) => h.addDepartment(d.id, name)} />}
      </div>
    </section>
  );
}

function DepartmentCard({ dept, index, count, division, h }: { dept: OrgDepartmentView; index: number; count: number; division: OrgDivisionView; h: BoardHandlers }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: `d:${dept.id}`,
    data: { type: "department", id: dept.id, divId: division.id } satisfies DragData,
    disabled: !h.editing,
  });
  const zone = useDroppable({ id: `fz:${dept.id}`, data: { type: "fzone", deptId: dept.id } satisfies DragData });
  const label = deptLabel(dept);
  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`org-dept flex flex-col gap-1 rounded-[10px] border border-line p-2 ${isDragging ? "opacity-40" : ""}`}
      aria-label={`Department ${label}`}
      data-testid="org-department"
      data-number={dept.number}
      data-id={dept.id}
    >
      <div className="flex items-start gap-1.5">
        {h.editing && (
          <button type="button" ref={setActivatorNodeRef} className="org-handle hidden md:inline-flex" aria-label={`Drag department ${label}`} {...attributes} {...listeners}>
            ⠿
          </button>
        )}
        <span className="num w-5 shrink-0 text-[13px] font-bold leading-[18px] text-accent">{dept.number}</span>
        <div className="min-w-0 flex-1 text-[13px] font-semibold leading-[18px]">
          {h.editing ? (
            <InlineText value={dept.name} editing label={`Name of department ${dept.number}`} placeholder="Название отдела" multiline={false} onSave={(v) => h.saveDepartment(dept.id, { name: v })} />
          ) : (
            <button type="button" className="text-left hover:underline" onClick={() => h.open({ kind: "department", id: dept.id })} aria-label={`Open department ${label}`}>
              {dept.name || <span className="font-normal italic text-muted">без названия</span>}
            </button>
          )}
        </div>
        {h.editing && (
          <>
            <button type="button" className="org-icon-btn" aria-label={`Details of department ${label}`} onClick={() => h.open({ kind: "department", id: dept.id })}>
              ⓘ
            </button>
            <ItemMenu label={`Actions for department ${label}`}>
              {(close) => (
                <>
                  <MenuButton disabled={index === 0} onClick={() => (h.moveDepartment(dept.id, division.id, index - 1), close())}>
                    Move up
                  </MenuButton>
                  <MenuButton disabled={index === count - 1} onClick={() => (h.moveDepartment(dept.id, division.id, index + 1), close())}>
                    Move down
                  </MenuButton>
                  <label className="px-2 pt-1 text-[12px] text-muted">
                    Move to division
                    <select
                      aria-label="Move to division"
                      className="input mt-1 h-8 text-[13px]"
                      value=""
                      onChange={(e) => {
                        const to = h.divisions.find((x) => x.id === e.target.value);
                        if (to) h.moveDepartment(dept.id, to.id, to.departments.length);
                        close();
                      }}
                    >
                      <option value="">Choose…</option>
                      {h.divisions
                        .filter((x) => x.id !== division.id)
                        .map((x) => (
                          <option key={x.id} value={x.id}>
                            {deptLabel(x)}
                          </option>
                        ))}
                    </select>
                  </label>
                  <MenuButton onClick={() => (h.archive("department", dept.id, true), close())}>Archive department</MenuButton>
                </>
              )}
            </ItemMenu>
          </>
        )}
      </div>
      {(dept.ckp || h.editing) && (
        <p className="text-[12px] leading-[17px]">
          <span className="font-semibold">ЦКП:</span>{" "}
          <InlineText value={dept.ckp} editing={h.editing} label={`ЦКП of department ${dept.number}`} onSave={(v) => h.saveDepartment(dept.id, { ckp: v })} />
        </p>
      )}
      {(dept.statistic || h.editing) && (
        <p className="text-[11.5px] leading-[16px] text-muted">
          Статистика:{" "}
          <InlineText value={dept.statistic} editing={h.editing} label={`Statistic of department ${dept.number}`} onSave={(v) => h.saveDepartment(dept.id, { statistic: v })} />
        </p>
      )}
      {(dept.headName || dept.openTasks > 0 || (h.editable && !h.editing)) && (
        <p className="flex flex-wrap items-center gap-1 text-[11.5px]" data-testid="org-department-head">
          {dept.headName ? (
            <span className="text-[11.5px]">
              <span className="text-muted">Руководитель:</span>{" "}
              <span className="font-semibold" title={dept.headFullName ?? undefined} data-testid="org-head-name">
                {dept.headName}
              </span>
            </span>
          ) : (
            h.editable &&
            !h.editing && (
              <span className="text-[11.5px]">
                <span className="text-muted">Руководитель:</span>{" "}
                <AssignPopover what={`head of ${deptLabel(dept)}`} target="department" targetId={dept.id} defaultRole={defaultOrgRole(dept.name || deptLabel(dept))} h={h} />
              </span>
            )
          )}
          {dept.openTasks > 0 && (
            <span className={`tag ${dept.overdueTasks ? "tag-risk" : ""}`}>
              {dept.openTasks} task{dept.openTasks === 1 ? "" : "s"}
              {dept.overdueTasks ? ` · ${dept.overdueTasks} overdue` : ""}
            </span>
          )}
        </p>
      )}
      <ul ref={zone.setNodeRef} className={`flex min-h-1 flex-col gap-1 ${zone.isOver ? "rounded-[8px] outline-2 outline-dashed outline-accent" : ""}`} aria-label={`Functions of ${label}`}>
        <SortableContext items={dept.functions.map((f) => `f:${f.id}`)} strategy={verticalListSortingStrategy}>
          {dept.functions.map((f, i) => (
            <FunctionRow key={f.id} fn={f} index={i} dept={dept} h={h} />
          ))}
        </SortableContext>
      </ul>
      {h.showArchived &&
        dept.archivedFunctions.map((f) => (
          <div key={f.id} className="flex items-center justify-between gap-2 rounded-[6px] border border-dashed border-line px-2 py-1 text-[12px] text-muted">
            <span className="line-through">{f.text}</span>
            {h.editable && (
              <button type="button" className="btn btn-sm h-6 px-2 text-[12px]" onClick={() => h.archive("function", f.id, false)}>
                Restore
              </button>
            )}
          </div>
        ))}
      {h.editable && <AddInline label="+ Функция" placeholder={`New function in department ${dept.number}`} onStart={h.startEditing} onAdd={(text) => h.addFunction(dept.id, text)} />}
    </article>
  );
}

function FunctionRow({ fn, index, dept, h }: { fn: OrgFunctionView; index: number; dept: OrgDepartmentView; h: BoardHandlers }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: `f:${fn.id}`,
    data: { type: "function", id: fn.id, deptId: dept.id } satisfies DragData,
    disabled: !h.editing,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`flex items-start gap-1.5 rounded-[6px] bg-surface px-1.5 py-1 text-[12px] leading-[17px] ${isDragging ? "opacity-40" : ""}`}
      data-testid="org-function"
      data-text={fn.text}
    >
      {h.editing ? (
        <button type="button" ref={setActivatorNodeRef} className="org-handle hidden md:inline-flex" aria-label={`Drag function ${fn.text}`} {...attributes} {...listeners}>
          ⠿
        </button>
      ) : (
        <span aria-hidden="true" className="select-none text-[11px] leading-[18px] text-muted/60">
          ⠿
        </span>
      )}
      <div className="min-w-0 flex-1">
        <InlineText value={fn.text} editing={h.editing} label={`Function text: ${fn.text}`} onSave={(v) => v && h.saveFunction(fn.id, { text: v })} />
        {!fn.responsiblePersonId && h.editable && !h.editing && (
          <span className="block">
            <AssignPopover what={`responsible for ${fn.text}`} target="function" targetId={fn.id} defaultRole={defaultOrgRole(fn.text)} h={h} />
          </span>
        )}
      </div>
      {fn.responsibleFullName && <Initials fullName={fn.responsibleFullName} />}
      {h.editing && (
        <ItemMenu label={`Actions for function ${fn.text}`}>
          {(close) => (
            <>
              <MenuButton disabled={index === 0} onClick={() => (h.moveFunction(fn.id, dept.id, index - 1), close())}>
                Move up
              </MenuButton>
              <MenuButton disabled={index === dept.functions.length - 1} onClick={() => (h.moveFunction(fn.id, dept.id, index + 1), close())}>
                Move down
              </MenuButton>
              <label className="px-2 pt-1 text-[12px] text-muted">
                Move to department
                <select
                  aria-label="Move to department"
                  className="input mt-1 h-8 text-[13px]"
                  value=""
                  onChange={(e) => {
                    const to = h.departments.find((d) => d.id === e.target.value);
                    if (to) h.moveFunction(fn.id, to.id, to.functions.length);
                    close();
                  }}
                >
                  <option value="">Choose…</option>
                  {h.departments
                    .filter((d) => d.id !== dept.id)
                    .sort((a, b) => a.number - b.number)
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {deptLabel(d)}
                      </option>
                    ))}
                </select>
              </label>
              <MenuButton onClick={() => (h.archive("function", fn.id, true), close())}>Archive function</MenuButton>
            </>
          )}
        </ItemMenu>
      )}
    </li>
  );
}
