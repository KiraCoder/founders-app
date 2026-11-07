"use client";

/**
 * The task list, Linear style (0034): rows grouped by status (or assignee, priority, company,
 * project, none) under collapsible headers with the count, the ▲ points sum and "+" to add a task
 * right into the group. Every property of a row changes inline (status, priority, assignee, due
 * date, labels, estimate, company, project) through the pickers; changes show at once
 * (`useOptimistic`) and roll back with a toast when the server refuses. Rows can be selected
 * (checkbox, shift-click for a range, x on the keyboard) for the bulk bar.
 *
 * Keyboard on a focused row: ↑ ↓ / j k move, Enter opens, x selects, s status, p priority,
 * a assignee, l labels, e estimate, d due date.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useOptimistic, useRef, useState, useTransition, type KeyboardEvent, type MouseEvent } from "react";
import {
  bulkDeleteTasksAction,
  bulkUpdateTasksAction,
  quickCreateTaskAction,
  updateTaskFieldsAction,
  type TaskActionResult,
  type TaskPatchInput,
} from "@/app/(app)/tasks/actions";
import { Icon } from "@/components/Icon";
import { CompanyDot, InitialsAvatar } from "@/components/ui";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Menu, type MenuOption } from "@/components/ui/Menu";
import { toast } from "@/components/ui/Toast";
import type { TaskFormOptions } from "@/server/services/options";
import { PRIORITY_OPTIONS, STATUS_OPTIONS, priorityLabel, statusLabel } from "./labels";
import { TaskActions, type TaskPatch } from "./TaskActions";
import { EstimateIcon, PriorityIcon, StatusIcon } from "./TaskIcons";
import {
  AssigneePicker,
  CompanyPicker,
  DuePicker,
  EstimatePicker,
  LabelsPicker,
  PRIORITY_MENU,
  PriorityPicker,
  ProjectPicker,
  STATUS_MENU,
  StatusPicker,
  assigneeOptions,
  type LabelLite,
} from "./TaskPickers";
import type { TaskActivityItem, TaskItem } from "./types";

export const GROUPINGS = ["status", "assignee", "priority", "company", "project", "none"] as const;
export type Grouping = (typeof GROUPINGS)[number];
export const ORDERINGS = ["priority", "due", "updated", "created"] as const;
export type Ordering = (typeof ORDERINGS)[number];
export const PROPERTIES = ["key", "priority", "labels", "company", "project", "due", "estimate", "assignee", "created", "updated", "activity"] as const;
export type Property = (typeof PROPERTIES)[number];
export const DEFAULT_HIDDEN: readonly Property[] = ["updated"];

const STATUS_GROUP_ORDER = ["in_review", "in_progress", "todo", "backlog", "done", "cancelled"] as const;
const PRIORITY_GROUP_ORDER = ["urgent", "high", "medium", "low", "none"] as const;
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

export interface TaskBoardProps {
  tasks: TaskItem[];
  activity: Record<string, TaskActivityItem>;
  options: TaskFormOptions;
  today: string;
  timeZone: string;
  canChase: boolean;
  group?: Grouping;
  order?: Ordering;
  hidden?: readonly Property[];
  empty?: string;
  /** Status groups always shown (even empty) when grouped by status: the view's statuses. */
  statusScope?: readonly string[];
  /** Defaults of a task created with "+" (the filtered company / project). */
  createDefaults?: { companyId?: string | null; projectId?: string | null };
  /** Group headers, "+" and the bulk bar (the Tasks page). Off: a plain list (Today, a project). */
  full?: boolean;
  /** localStorage key of the collapsed groups. */
  storageKey?: string;
}

type Action = { ids: string[]; patch: Partial<TaskItem> } | { remove: string[] };

/** The optimistic copy of a row after a picker change. */
function applyPatch(t: TaskItem, p: Partial<TaskItem>, today: string): TaskItem {
  const next = { ...t, ...p };
  if (p.status) next.isOverdue = p.status === "done" || p.status === "cancelled" ? false : !!t.dueDate && t.isOverdue;
  if (p.dueDate !== undefined) next.isOverdue = !!p.dueDate && next.status !== "done" && next.status !== "cancelled" && p.dueDate < today;
  if (p.status && p.status !== "in_progress") next.overEstimate = false;
  return next;
}

interface Group {
  key: string;
  label: string;
  icon: React.ReactNode;
  tasks: TaskItem[];
  /** What "+" presets for a new task in this group. */
  preset: { status?: string; priority?: string; assignee?: string; companyId?: string | null; projectId?: string | null };
}

function sortTasks(list: TaskItem[], order: Ordering): TaskItem[] {
  const due = (t: TaskItem) => t.dueDate ?? "9999-99-99";
  return [...list].sort((a, b) => {
    switch (order) {
      case "due":
        return due(a).localeCompare(due(b)) || PRIORITY_RANK[a.priority]! - PRIORITY_RANK[b.priority]! || b.createdAt.localeCompare(a.createdAt);
      case "updated":
        return b.updatedAt.localeCompare(a.updatedAt);
      case "created":
        return b.createdAt.localeCompare(a.createdAt);
      default:
        return PRIORITY_RANK[a.priority]! - PRIORITY_RANK[b.priority]! || due(a).localeCompare(due(b)) || b.updatedAt.localeCompare(a.updatedAt);
    }
  });
}

export function groupTasks(tasks: TaskItem[], group: Grouping, order: Ordering, statusScope?: readonly string[]): Group[] {
  const sorted = sortTasks(tasks, order);
  if (group === "none") return [{ key: "all", label: "All tasks", icon: null, tasks: sorted, preset: {} }];
  const map = new Map<string, Group>();
  const ensure = (key: string, make: () => Omit<Group, "tasks" | "key">) => {
    let g = map.get(key);
    if (!g) {
      g = { key, tasks: [], ...make() };
      map.set(key, g);
    }
    return g;
  };
  if (group === "status") {
    for (const s of STATUS_GROUP_ORDER) {
      if (statusScope && !statusScope.includes(s)) continue;
      ensure(s, () => ({ label: statusLabel(s), icon: <StatusIcon status={s} />, preset: { status: s } }));
    }
  }
  if (group === "priority") for (const p of PRIORITY_GROUP_ORDER) ensure(p, () => ({ label: priorityLabel(p), icon: <PriorityIcon priority={p} />, preset: { priority: p } }));
  for (const t of sorted) {
    let g: Group;
    if (group === "status") g = ensure(t.status, () => ({ label: statusLabel(t.status), icon: <StatusIcon status={t.status} />, preset: { status: t.status } }));
    else if (group === "priority") g = ensure(t.priority, () => ({ label: priorityLabel(t.priority), icon: <PriorityIcon priority={t.priority} />, preset: { priority: t.priority } }));
    else if (group === "assignee") {
      const key = t.assignee ? `${t.assignee.kind}:${t.assignee.id}` : "none";
      g = ensure(key, () => ({
        label: t.assignee?.name ?? "No assignee",
        icon: t.assignee ? <InitialsAvatar name={t.assignee.name} size="xs" tone={t.assignee.kind === "person" ? "neutral" : "accent"} /> : null,
        preset: { assignee: t.assignee ? key : "", companyId: t.company?.id ?? null },
      }));
    } else if (group === "company") {
      const key = t.company?.id ?? "none";
      g = ensure(key, () => ({ label: t.company?.name ?? "No company (personal)", icon: t.company ? <CompanyDot color={t.company.color} size={8} /> : null, preset: { companyId: t.company?.id ?? null } }));
    } else {
      const key = t.project?.id ?? "none";
      g = ensure(key, () => ({ label: t.project?.name ?? "No project", icon: null, preset: { projectId: t.project?.id ?? null, companyId: t.company?.id ?? null } }));
    }
    g.tasks.push(t);
  }
  const out = [...map.values()];
  if (group === "assignee" || group === "company" || group === "project") {
    out.sort((a, b) => (a.key === "none" ? 1 : b.key === "none" ? -1 : a.label.localeCompare(b.label)));
  }
  // Priority groups and other non-status groups: hide empty ones.
  return group === "status" ? out : out.filter((g) => g.tasks.length > 0);
}

const pts = (list: readonly TaskItem[]) => list.reduce((n, t) => n + (t.estimate ?? 0), 0);

function shortDate(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone }).format(new Date(iso));
}

export function TaskBoard(props: TaskBoardProps) {
  const { options, today, timeZone, canChase, activity, full = true, empty = "No tasks.", statusScope, createDefaults, storageKey = "fc:tasks:collapsed" } = props;
  const group = props.group ?? (full ? "status" : "none");
  const order = props.order ?? (full ? "priority" : "due");
  const hidden = useMemo(() => new Set(props.hidden ?? DEFAULT_HIDDEN), [props.hidden]);
  const router = useRouter();
  const [, start] = useTransition();
  const [tasks, apply] = useOptimistic(props.tasks, (state: TaskItem[], a: Action) =>
    "remove" in a ? state.filter((t) => !a.remove.includes(t.id)) : state.map((t) => (a.ids.includes(t.id) ? applyPatch(t, a.patch, today) : t)),
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastClicked = useRef<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<string | null>(null);
  useEffect(() => {
    try {
      const v = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]") as unknown;
      if (Array.isArray(v)) setCollapsed(new Set(v.filter((x): x is string => typeof x === "string")));
    } catch {
      // Storage blocked: groups start open.
    }
  }, [storageKey]);
  // Drop selections of tasks that left the list.
  useEffect(() => {
    setSelected((s) => {
      const ids = new Set(props.tasks.map((t) => t.id));
      const next = new Set([...s].filter((id) => ids.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [props.tasks]);

  const groups = useMemo(() => groupTasks(tasks, group, order, group === "status" ? statusScope : undefined), [tasks, group, order, statusScope]);
  const visibleOrder = useMemo(() => groups.flatMap((g) => (collapsed.has(`${group}:${g.key}`) ? [] : g.tasks.map((t) => t.id))), [groups, collapsed, group]);

  const toggleCollapsed = (key: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        // Convenience only.
      }
      return next;
    });

  /** One inline change: optimistic, then the server; a refusal rolls back with a toast. */
  const change = (ids: string[], optimistic: Partial<TaskItem>, run: () => Promise<TaskActionResult>, quiet = false) =>
    start(async () => {
      apply({ ids, patch: optimistic });
      let r: TaskActionResult;
      try {
        r = await run();
      } catch {
        r = { ok: false, error: "Could not reach the server. Nothing was changed." };
      }
      if (!r.ok) toast(`Couldn't save: ${r.error ?? "something went wrong"}`, { tone: "risk" });
      else if (!quiet || /gets an updated message|not changed/.test(r.message ?? "")) toast(r.message ?? "Saved", { ms: 2500 });
    });
  const patchOne = (t: TaskItem, patch: TaskPatchInput, optimistic: Partial<TaskItem>) => change([t.id], optimistic, () => updateTaskFieldsAction(t.id, patch));

  const select = (id: string, e: MouseEvent | KeyboardEvent | null) => {
    // The range is worked out now (the updater runs later, after lastClicked moved on).
    const anchor = lastClicked.current;
    const range =
      e && "shiftKey" in e && e.shiftKey && anchor && anchor !== id && visibleOrder.includes(anchor)
        ? (() => {
            const a = visibleOrder.indexOf(anchor);
            const b = visibleOrder.indexOf(id);
            return visibleOrder.slice(Math.min(a, b), Math.max(a, b) + 1);
          })()
        : null;
    lastClicked.current = id;
    setSelected((s) => {
      const next = new Set(s);
      if (range) {
        const on = !s.has(id);
        for (const x of range) {
          if (on) next.add(x);
          else next.delete(x);
        }
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (!tasks.length && !full) return <div className="card px-4 py-6 text-center text-[13px] text-muted">{empty}</div>;

  const selection = tasks.filter((t) => selected.has(t.id));
  return (
    <div className="min-w-0" data-testid="task-board">
      {full && tasks.length === 0 && group !== "status" && <div className="card px-4 py-6 text-center text-[13px] text-muted">{empty}</div>}
      <div className={full ? "card overflow-hidden" : "card overflow-hidden"} role="list" aria-label="Tasks">
        {groups.map((g) => {
          const ckey = `${group}:${g.key}`;
          const isCollapsed = collapsed.has(ckey);
          const showHeader = full && group !== "none";
          return (
            <section key={g.key} aria-label={showHeader ? `${g.label} (${g.tasks.length})` : undefined} data-group={g.key}>
              {showHeader && (
                <div className="group/h flex h-9 items-center gap-2 border-b border-line bg-sunk/80 px-3 text-[13px]" data-testid="group-header">
                  <button
                    type="button"
                    className="inline-flex min-w-0 items-center gap-2 rounded-[6px] py-1 pr-1 focus-visible:outline-2 focus-visible:outline-accent"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleCollapsed(ckey)}
                  >
                    <span className={`text-muted transition-transform ${isCollapsed ? "-rotate-90" : ""}`} aria-hidden="true">
                      <Icon name="chevronDown" size={14} />
                    </span>
                    {g.icon}
                    <span className="truncate font-semibold">{g.label}</span>
                    <span className="num text-muted">{g.tasks.length}</span>
                  </button>
                  {pts(g.tasks) > 0 && (
                    <span className="inline-flex items-center gap-1 text-[12px] text-muted" title={`${pts(g.tasks)} points = ${pts(g.tasks)} working hours`} data-testid="group-points">
                      <EstimateIcon /> <span className="num">{pts(g.tasks)}</span>
                    </span>
                  )}
                  <button
                    type="button"
                    className="ml-auto inline-flex size-6 items-center justify-center rounded-[6px] text-muted hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
                    aria-label={`Add a task to ${g.label}`}
                    title={`Add a task to ${g.label}`}
                    onClick={() => {
                      if (isCollapsed) toggleCollapsed(ckey);
                      setAdding(g.key);
                    }}
                  >
                    <Icon name="plus" size={15} />
                  </button>
                </div>
              )}
              {adding === g.key && (
                <QuickAddRow
                  preset={{ ...g.preset, companyId: g.preset.companyId !== undefined ? g.preset.companyId : (createDefaults?.companyId ?? null), projectId: g.preset.projectId ?? createDefaults?.projectId ?? null }}
                  options={options}
                  onClose={() => setAdding(null)}
                />
              )}
              {!isCollapsed && (
                <ul className="divide-y divide-line" data-testid={showHeader ? "group-rows" : undefined}>
                  {g.tasks.map((t) => (
                    <TaskRow
                      key={t.id}
                      task={t}
                      activity={activity[t.id]}
                      options={options}
                      today={today}
                      timeZone={timeZone}
                      canChase={canChase}
                      hidden={hidden}
                      selected={selected.has(t.id)}
                      selecting={selected.size > 0}
                      selectable={full}
                      onSelect={(e) => select(t.id, e)}
                      onPatch={(patch, optimistic) => patchOne(t, patch, optimistic)}
                      onOptimistic={(p) => apply({ ids: [t.id], patch: p })}
                    />
                  ))}
                  {showHeader && g.tasks.length === 0 && adding !== g.key && <li className="px-4 py-2 text-[12px] text-muted">No tasks</li>}
                </ul>
              )}
            </section>
          );
        })}
      </div>
      {full && selection.length > 0 && (
        <BulkBar
          tasks={selection}
          options={options}
          onClear={() => setSelected(new Set())}
          onChange={(patch, optimistic, labels) => change(selection.map((t) => t.id), optimistic, () => bulkUpdateTasksAction(selection.map((t) => t.id), patch, labels))}
          onDelete={() =>
            start(async () => {
              const ids = selection.map((t) => t.id);
              apply({ remove: ids });
              const r = await bulkDeleteTasksAction(ids).catch(() => ({ ok: false, error: "Could not reach the server" }) as TaskActionResult);
              if (r.ok) {
                toast(r.message ?? "Deleted");
                setSelected(new Set());
                router.refresh();
              } else toast(r.error ?? "Could not delete", { tone: "risk" });
            })
          }
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------

const SHORTCUTS: Record<string, string> = { s: "status-picker", p: "priority-picker", a: "assignee-picker", l: "labels-picker", e: "estimate-picker", d: "due-picker" };

function TaskRow({
  task,
  activity,
  options,
  today,
  timeZone,
  canChase,
  hidden,
  selected,
  selecting,
  selectable,
  onSelect,
  onPatch,
  onOptimistic,
}: {
  task: TaskItem;
  activity?: TaskActivityItem;
  options: TaskFormOptions;
  today: string;
  timeZone: string;
  canChase: boolean;
  hidden: Set<Property>;
  selected: boolean;
  selecting: boolean;
  selectable: boolean;
  onSelect: (e: MouseEvent | KeyboardEvent | null) => void;
  onPatch: (patch: TaskPatchInput, optimistic: Partial<TaskItem>) => void;
  onOptimistic: (p: Partial<TaskItem>) => void;
}) {
  const router = useRouter();
  const rowRef = useRef<HTMLLIElement>(null);
  const closed = task.status === "done" || task.status === "cancelled";
  const show = (p: Property) => !hidden.has(p);
  const optimistic = { task, activity, patch: (p: TaskPatch) => onOptimistic(p.status ? { status: p.status } : {}) };

  const onKey = (e: KeyboardEvent<HTMLLIElement>) => {
    if (e.target !== rowRef.current || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "arrowdown" || k === "j" || k === "arrowup" || k === "k") {
      e.preventDefault();
      const rows = [...document.querySelectorAll<HTMLElement>("li[data-task-id]")];
      const i = rows.indexOf(rowRef.current!);
      rows[k === "arrowdown" || k === "j" ? i + 1 : i - 1]?.focus();
    } else if (k === "enter") {
      e.preventDefault();
      router.push(`/tasks/${task.id}`);
    } else if (k === "x" && selectable) {
      e.preventDefault();
      onSelect(null);
    } else if (SHORTCUTS[k]) {
      const btn = rowRef.current?.querySelector<HTMLButtonElement>(`[data-testid="${SHORTCUTS[k]}"]`);
      if (btn) {
        e.preventDefault();
        btn.click();
      }
    }
  };

  const a = activity;
  const person = task.assignee?.kind === "person";
  return (
    <li
      ref={rowRef}
      data-task-id={task.id}
      tabIndex={0}
      onKeyDown={onKey}
      aria-label={`${task.key} ${task.title}`}
      className={`group relative flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 outline-none focus-visible:bg-sunk/70 sm:flex-nowrap sm:px-3 ${selected ? "bg-accent-soft/60" : "hover:bg-sunk/50"}`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {selectable && (
          <label
            className={`inline-flex size-5 shrink-0 cursor-pointer items-center justify-center ${selected || selecting ? "" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"}`}
            onClick={(e) => {
              e.preventDefault();
              onSelect(e);
            }}
          >
            <input type="checkbox" className="size-3.5 cursor-pointer accent-[var(--accent)]" checked={selected} readOnly aria-label={`Select ${task.key} ${task.title}`} tabIndex={-1} />
          </label>
        )}
        {show("priority") && <PriorityPicker value={task.priority} onChange={(v) => onPatch({ priority: v }, { priority: v })} />}
        {show("key") && (
          <span className="num hidden w-[62px] shrink-0 truncate text-[12px] text-muted sm:inline" data-testid="task-key">
            {task.key}
          </span>
        )}
        <StatusPicker value={task.status} onChange={(v) => onPatch({ status: v }, { status: v })} />
        <Link
          href={`/tasks/${task.id}`}
          className={`min-w-0 flex-1 truncate text-[13.5px] hover:underline ${closed ? "text-muted line-through" : "text-ink"}`}
          data-testid="task-title"
        >
          {task.title}
        </Link>
        {task.visibility === "private" && (
          <span className="shrink-0 text-muted" title="Personal todo: only you can see it" aria-label="Personal">
            <Icon name="lock" size={12} />
          </span>
        )}
        {task.overEstimate && (
          <span className="tag tag-warn shrink-0" title="In progress longer than its estimate (working hours)" data-testid="over-estimate">
            Over estimate
          </span>
        )}
        {task.orgDepartment && (
          <span className="hidden max-w-[160px] shrink-0 truncate text-[11.5px] text-muted lg:inline" title={`Department ${task.orgDepartment.number} ${task.orgDepartment.name} (org chart)`} data-testid="task-department">
            {task.orgDepartment.number} {task.orgDepartment.name}
          </span>
        )}
        {show("activity") && a && <ActivityBits task={task} a={a} timeZone={timeZone} person={person} />}
      </div>
      <div className="flex min-w-0 shrink-0 basis-full items-center justify-end gap-1.5 pl-7 sm:basis-auto sm:pl-0">
        {show("labels") && (
          <LabelsPicker value={task.labels} options={options} onChange={(ids, labels: LabelLite[]) => onPatch({ labelIds: ids }, { labels })} />
        )}
        {show("company") && task.company && (
          <span className="hidden md:inline-flex">
            <CompanyPicker
              value={task.company}
              options={options}
              allowNone={task.visibility === "private"}
              onChange={(id) => {
                const c = options.companies.find((x) => x.id === id);
                onPatch({ companyId: id }, { company: c ? { id: c.id, name: c.name, color: c.color, slug: task.company?.slug ?? "" } : null, project: null });
              }}
            />
          </span>
        )}
        {show("project") && task.project && (
          <span className="hidden lg:inline-flex">
            <ProjectPicker
              value={task.project}
              companyId={task.company?.id ?? null}
              options={options}
              onChange={(id) => {
                const p = options.projects.find((x) => x.id === id);
                onPatch({ projectId: id }, { project: p ? { id: p.id, name: p.name } : null });
              }}
            />
          </span>
        )}
        {show("due") && (
          <DuePicker value={task.dueDate} today={today} overdue={task.isOverdue} onChange={(v) => onPatch({ dueDate: v }, { dueDate: v })} />
        )}
        {show("estimate") && <EstimatePicker value={task.estimate} onChange={(v) => onPatch({ estimate: v }, { estimate: v })} />}
        {show("assignee") && (
          <AssigneePicker
            task={{ visibility: task.visibility, companyId: task.company?.id ?? null, assignee: task.assignee }}
            options={options}
            onChange={(v, name) => {
              const [kind, id] = v.split(":") as ["user" | "person", string];
              onPatch({ assignee: v }, { assignee: v ? { kind, id, name: name ?? "?" } : null });
            }}
          />
        )}
        {show("created") && (
          <span className="num hidden w-[46px] shrink-0 text-right text-[11.5px] text-muted sm:inline" title={`Created ${new Date(task.createdAt).toLocaleString("en-GB", { timeZone })}`}>
            {shortDate(task.createdAt, timeZone)}
          </span>
        )}
        {show("updated") && (
          <span className="num hidden w-[46px] shrink-0 text-right text-[11.5px] text-muted sm:inline" title={`Updated ${new Date(task.updatedAt).toLocaleString("en-GB", { timeZone })}`}>
            {shortDate(task.updatedAt, timeZone)}
          </span>
        )}
        <TaskActions task={task} activity={activity} options={options} canChase={canChase} optimistic={optimistic} timeZone={timeZone} variant="menu" />
      </div>
    </li>
  );
}

/** Small signals after the title: sub-tasks, comments, the staff bot's state. */
function ActivityBits({ task, a, timeZone, person }: { task: TaskItem; a: TaskActivityItem; timeZone: string; person: boolean }) {
  const stamp = (iso: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso));
  return (
    <span className="hidden shrink-0 items-center gap-2 text-[11.5px] text-muted sm:inline-flex" data-testid="task-activity">
      {a.checklist && (
        <span aria-label={`Sub-tasks ${a.checklist.done} of ${a.checklist.total} done`} title="Sub-tasks done" className="num inline-flex items-center gap-0.5">
          <Icon name="tasks" size={12} /> {a.checklist.done}/{a.checklist.total}
        </span>
      )}
      {a.comments > 0 && (
        <span aria-label={`${a.comments} comments`} title="Comments" className="num inline-flex items-center gap-0.5">
          <Icon name="comment" size={12} /> {a.comments}
        </span>
      )}
      {person && a.chase.paused && (
        <span className="text-warn" title="Chasing paused">
          <Icon name="pause" size={12} />
          <span className="sr-only">Chasing paused</span>
        </span>
      )}
      {person && a.lastSent?.status === "failed" && (
        <span className="text-risk" title={`${a.lastSent.what} — not delivered · ${stamp(a.lastSent.at)}`}>
          ⚠<span className="sr-only">Telegram message not delivered</span>
        </span>
      )}
      {person && a.lastReply && (
        <span title={`${task.assignee?.name}: ${a.lastReply.what} · ${stamp(a.lastReply.at)}`} className="max-w-[140px] truncate">
          ↩ {a.lastReply.what}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// "+" in a group header
// ---------------------------------------------------------------------------

function QuickAddRow({ preset, options, onClose }: { preset: Group["preset"]; options: TaskFormOptions; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [companyId, setCompanyId] = useState<string | null>(preset.companyId ?? null);
  const [pending, start] = useTransition();
  const company = options.companies.find((c) => c.id === companyId) ?? null;
  const submit = () => {
    const text = title.trim();
    if (!text) return;
    start(async () => {
      const r = await quickCreateTaskAction({ ...preset, companyId, title: text }).catch(() => ({ ok: false, error: "Could not reach the server" }) as TaskActionResult);
      if (r.ok) {
        toast(r.message ?? "Task created", { ms: 2500 });
        setTitle("");
      } else toast(`Couldn't create: ${r.error}`, { tone: "risk" });
    });
  };
  return (
    <form
      className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      aria-label="Add a task"
    >
      {preset.status && <StatusIcon status={preset.status} />}
      <input
        autoFocus
        className="input h-8 min-w-[180px] flex-1 text-[13px]"
        placeholder="Task title — Enter to add, Esc to close"
        aria-label="New task title"
        value={title}
        maxLength={300}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      />
      <CompanyPicker value={company} options={options} allowNone onChange={setCompanyId} />
      <button type="submit" className="btn btn-primary btn-sm" disabled={pending || !title.trim()}>
        {pending ? "Adding…" : "Add"}
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
        Close
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Bulk bar
// ---------------------------------------------------------------------------

function BulkBar({
  tasks,
  options,
  onClear,
  onChange,
  onDelete,
}: {
  tasks: TaskItem[];
  options: TaskFormOptions;
  onClear: () => void;
  onChange: (patch: TaskPatchInput, optimistic: Partial<TaskItem>, labels?: { add?: string[]; remove?: string[] }) => void;
  onDelete: () => void;
}) {
  const [askDelete, setAskDelete] = useState(false);
  const companies = [...new Set(tasks.map((t) => t.company?.id ?? null))];
  const sameCompany = companies.length === 1 ? companies[0]! : null;
  const anyPrivate = tasks.some((t) => t.visibility === "private");
  const people = assigneeOptions({ visibility: anyPrivate ? "private" : "shared", companyId: sameCompany, assignee: null }, options);
  const labelMenu: MenuOption[] = options.labels.map((l) => ({ value: l.id, label: l.name, icon: <span className="size-2.5 rounded-full" style={{ background: l.color }} aria-hidden="true" /> }));
  const btn = "inline-flex h-8 items-center gap-1.5 rounded-[8px] px-2.5 text-[13px] font-medium text-ink hover:bg-sunk focus-visible:outline-2 focus-visible:outline-accent";
  return (
    <div
      role="toolbar"
      aria-label={`${tasks.length} selected`}
      className="card-raised fixed inset-x-3 bottom-20 z-40 mx-auto flex max-w-[760px] flex-wrap items-center gap-1 p-1.5 md:bottom-6"
      data-testid="bulk-bar"
    >
      <span className="num px-2 text-[13px] font-semibold">{tasks.length} selected</span>
      <Menu
        label="Set status of selected"
        title="Status"
        options={STATUS_MENU}
        value={null}
        searchable
        onSelect={(v) => onChange({ status: v }, { status: v as TaskItem["status"] })}
        trigger={(p) => (
          <button type="button" {...p} ref={p.ref as (el: HTMLButtonElement | null) => void} className={btn}>
            <StatusIcon status="in_progress" /> Status
          </button>
        )}
      />
      <Menu
        label="Set priority of selected"
        title="Priority"
        options={PRIORITY_MENU}
        value={null}
        searchable
        onSelect={(v) => onChange({ priority: v }, { priority: v as TaskItem["priority"] })}
        trigger={(p) => (
          <button type="button" {...p} ref={p.ref as (el: HTMLButtonElement | null) => void} className={btn}>
            <PriorityIcon priority="high" /> Priority
          </button>
        )}
      />
      <Menu
        label="Set assignee of selected"
        title="Assignee"
        options={people}
        value={null}
        searchable
        onSelect={(v) => {
          const name = people.find((o) => o.value === v)?.label ?? "?";
          const [kind, id] = v.split(":") as ["user" | "person", string];
          onChange({ assignee: v }, { assignee: v ? { kind, id, name } : null });
        }}
        trigger={(p) => (
          <button type="button" {...p} ref={p.ref as (el: HTMLButtonElement | null) => void} className={btn}>
            <Icon name="people" size={14} /> Assignee
          </button>
        )}
      />
      <Menu
        label="Add a label to selected"
        title="Add label"
        options={labelMenu}
        value={null}
        searchable
        onSelect={(id) => {
          const l = options.labels.find((x) => x.id === id);
          onChange({}, {}, { add: [id] });
          if (l) toast(`Adding “${l.name}”…`, { ms: 1500, tone: "info" });
        }}
        trigger={(p) => (
          <button type="button" {...p} ref={p.ref as (el: HTMLButtonElement | null) => void} className={btn}>
            + Label
          </button>
        )}
      />
      <Menu
        label="Remove a label from selected"
        title="Remove label"
        options={labelMenu.filter((o) => tasks.some((t) => t.labels.some((l) => l.id === o.value)))}
        value={null}
        searchable
        onSelect={(id) => onChange({}, {}, { remove: [id] })}
        trigger={(p) => (
          <button type="button" {...p} ref={p.ref as (el: HTMLButtonElement | null) => void} className={btn}>
            − Label
          </button>
        )}
      />
      <button type="button" className={btn} onClick={() => onChange({ status: "cancelled" }, { status: "cancelled" })}>
        <Icon name="archive" size={14} /> Archive
      </button>
      <button type="button" className={`${btn} text-risk`} onClick={() => setAskDelete(true)}>
        <Icon name="trash" size={14} /> Delete
      </button>
      <button type="button" className={`${btn} ml-auto`} onClick={onClear} aria-label="Clear selection">
        <Icon name="close" size={14} />
      </button>
      <ConfirmDialog
        open={askDelete}
        title={`Delete ${tasks.length} task${tasks.length === 1 ? "" : "s"} for good?`}
        confirmLabel="Yes, delete"
        tone="danger"
        onCancel={() => setAskDelete(false)}
        onConfirm={() => {
          setAskDelete(false);
          onDelete();
        }}
      >
        <p>Their sub-tasks and comments are deleted too. Archive keeps the history instead.</p>
      </ConfirmDialog>
    </div>
  );
}

export { PRIORITY_OPTIONS, STATUS_OPTIONS };
