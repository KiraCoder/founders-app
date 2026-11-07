"use client";

/**
 * The task page's editable parts (0034, Linear style): the big title, the description (simple
 * Markdown, edited in place), the Properties sidebar (every property inline, optimistic with
 * rollback + toast) and the comment cards of the Activity timeline (edit / delete your own).
 */
import { useEffect, useOptimistic, useRef, useState, useTransition, type ReactNode } from "react";
import { updateTaskFieldsAction, type TaskActionResult, type TaskPatchInput } from "@/app/(app)/tasks/actions";
import { deleteCommentAction, editCommentAction } from "@/app/(app)/staff-actions";
import { parseMarkdown, toggleCheckbox, type Inline } from "@/lib/markdown";
import type { TaskFormOptions } from "@/server/services/options";
import { Tag } from "@/components/ui";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { AssigneePicker, CompanyPicker, DuePicker, EstimatePicker, LabelsPicker, PriorityPicker, ProjectPicker, StatusPicker } from "./TaskPickers";
import type { TaskItem } from "./types";

async function save(id: string, patch: TaskPatchInput): Promise<TaskActionResult> {
  try {
    return await updateTaskFieldsAction(id, patch);
  } catch {
    return { ok: false, error: "Could not reach the server. Nothing was changed." };
  }
}

function report(r: TaskActionResult, quiet = true) {
  if (!r.ok) toast(`Couldn't save: ${r.error ?? "something went wrong"}`, { tone: "risk" });
  else if (!quiet || /gets an updated message/.test(r.message ?? "")) toast(r.message ?? "Saved", { ms: 2500 });
}

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------

export function TaskTitleEditor({ taskId, title, closed }: { taskId: string; title: string; closed: boolean }) {
  const [value, setValue] = useState(title);
  const [shown, setShown] = useOptimistic(title);
  const [, start] = useTransition();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setValue(title), [title]);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(fit, [value]);
  const commit = () => {
    const next = value.trim();
    if (!next) {
      setValue(shown);
      return;
    }
    if (next === shown) return;
    start(async () => {
      setShown(next);
      const r = await save(taskId, { title: next });
      report(r, false);
      if (!r.ok) setValue(title);
    });
  };
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      maxLength={300}
      aria-label="Title"
      data-testid="task-title-input"
      onChange={(e) => setValue(e.target.value.replace(/\n/g, " "))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setValue(shown);
          e.currentTarget.blur();
        }
      }}
      className={`-mx-1.5 block w-[calc(100%+12px)] resize-none overflow-hidden rounded-[8px] border border-transparent bg-transparent px-1.5 py-0.5 text-[24px] font-semibold leading-tight outline-none hover:border-line focus:border-accent ${closed ? "text-muted line-through" : ""}`}
    />
  );
}

// ---------------------------------------------------------------------------
// Description (Markdown)
// ---------------------------------------------------------------------------

function InlineText({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.kind === "bold" ? (
          <strong key={i} className="font-semibold">
            {p.text}
          </strong>
        ) : p.kind === "code" ? (
          <code key={i} className="rounded bg-sunk px-1 py-0.5 text-[12.5px]">
            {p.text}
          </code>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/** Read-only Markdown (text nodes only). `onToggle` makes checkboxes clickable. */
export function MarkdownView({ text, onToggle }: { text: string; onToggle?: (line: number) => void }) {
  const blocks = parseMarkdown(text);
  return (
    <div className="space-y-2 text-[14px] leading-relaxed" data-testid="markdown">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "heading": {
            const cls = b.level === 1 ? "text-[18px] font-semibold" : b.level === 2 ? "text-[16px] font-semibold" : "text-[14px] font-semibold";
            const H = b.level === 1 ? "h2" : b.level === 2 ? "h3" : "h4";
            return (
              <H key={i} className={cls}>
                <InlineText parts={b.content} />
              </H>
            );
          }
          case "paragraph":
            return (
              <p key={i}>
                <InlineText parts={b.content} />
              </p>
            );
          case "bullets":
            return (
              <ul key={i} className="list-disc space-y-0.5 pl-5">
                {b.items.map((it, j) => (
                  <li key={j}>
                    <InlineText parts={it.content} />
                  </li>
                ))}
              </ul>
            );
          case "numbers":
            return (
              <ol key={i} start={b.start} className="list-decimal space-y-0.5 pl-5">
                {b.items.map((it, j) => (
                  <li key={j}>
                    <InlineText parts={it.content} />
                  </li>
                ))}
              </ol>
            );
          case "checks":
            return (
              <ul key={i} className="space-y-1">
                {b.items.map((it, j) => (
                  <li key={j} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1 size-3.5 shrink-0 accent-[var(--accent)]"
                      checked={it.checked}
                      disabled={!onToggle}
                      onChange={() => onToggle?.(it.line)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`${it.checked ? "Untick" : "Tick"} ${it.content.map((c) => c.text).join("")}`}
                    />
                    <span className={it.checked ? "text-muted line-through" : ""}>
                      <InlineText parts={it.content} />
                    </span>
                  </li>
                ))}
              </ul>
            );
        }
      })}
    </div>
  );
}

export function TaskDescriptionEditor({ taskId, notes, readOnly }: { taskId: string; notes: string | null; readOnly?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(notes ?? "");
  const [shown, setShown] = useOptimistic(notes ?? "");
  const [pending, start] = useTransition();
  useEffect(() => {
    if (!editing) setDraft(notes ?? "");
  }, [notes, editing]);
  const commit = (text: string) => {
    setEditing(false);
    if (text === shown) return;
    start(async () => {
      setShown(text);
      report(await save(taskId, { notes: text.trim() ? text : null }), false);
    });
  };
  if (editing) {
    return (
      <div className="space-y-2">
        <textarea
          autoFocus
          className="input min-h-[160px] font-mono text-[13px] leading-relaxed"
          value={draft}
          maxLength={5000}
          aria-label="Description"
          placeholder={"# Heading\n**bold**\n- bullet\n1. numbered\n- [ ] checkbox"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setDraft(shown);
              setEditing(false);
            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit(draft);
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => commit(draft)}>
            Save
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setDraft(shown);
              setEditing(false);
            }}
          >
            Cancel
          </button>
          <span className="text-[12px] text-muted">Ctrl/⌘ Enter saves · Esc cancels · # heading, **bold**, - list, 1. list, - [ ] checkbox</span>
        </div>
      </div>
    );
  }
  return (
    <div
      role={readOnly ? undefined : "button"}
      tabIndex={readOnly ? undefined : 0}
      aria-label={readOnly ? undefined : "Edit description"}
      onClick={() => !readOnly && setEditing(true)}
      onKeyDown={(e) => {
        if (!readOnly && (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          setEditing(true);
        }
      }}
      className={`-mx-2 min-h-[48px] rounded-[8px] px-2 py-1.5 ${readOnly ? "" : "cursor-text hover:bg-sunk/60 focus-visible:outline-2 focus-visible:outline-accent"} ${pending ? "opacity-70" : ""}`}
      data-testid="task-description"
    >
      {shown.trim() ? (
        <MarkdownView text={shown} onToggle={readOnly ? undefined : (line) => commit(toggleCheckbox(shown, line))} />
      ) : (
        <p className="text-[14px] text-muted">Add a description…</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Properties sidebar
// ---------------------------------------------------------------------------

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-8 grid-cols-[92px_minmax(0,1fr)] items-center gap-1">
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

export function TaskPropertiesPanel({
  task: given,
  options,
  today,
  createdLine,
  chase,
}: {
  task: TaskItem;
  options: TaskFormOptions;
  today: string;
  createdLine: ReactNode;
  /** The Reminders card (collapsed). */
  chase?: ReactNode;
}) {
  const [task, apply] = useOptimistic(given, (t: TaskItem, p: Partial<TaskItem>) => {
    const next = { ...t, ...p };
    if (p.dueDate !== undefined) next.isOverdue = !!p.dueDate && p.dueDate < today && next.status !== "done" && next.status !== "cancelled";
    if (p.status) {
      next.isOverdue = p.status === "done" || p.status === "cancelled" ? false : !!next.dueDate && next.dueDate < today;
      if (p.status !== "in_progress") next.overEstimate = false;
    }
    return next;
  });
  const [, start] = useTransition();
  const change = (patch: TaskPatchInput, optimistic: Partial<TaskItem>) =>
    start(async () => {
      apply(optimistic);
      report(await save(task.id, patch), false);
    });
  const person = task.assignee?.kind === "person";
  return (
    <aside className="card min-w-0 p-3 lg:sticky lg:top-20" aria-label="Properties" data-testid="task-properties">
      <h2 className="eyebrow mb-2 px-1">Properties</h2>
      <dl className="space-y-0.5" data-testid="task-details">
        <Row label="Status">
          <StatusPicker variant="field" value={task.status} onChange={(v) => change({ status: v }, { status: v })} />
        </Row>
        <Row label="Priority">
          <PriorityPicker variant="field" value={task.priority} onChange={(v) => change({ priority: v }, { priority: v })} />
        </Row>
        <Row label="Assignee">
          <AssigneePicker
            variant="field"
            task={{ visibility: task.visibility, companyId: task.company?.id ?? null, assignee: task.assignee }}
            options={options}
            onChange={(v, name) => {
              const [kind, id] = v.split(":") as ["user" | "person", string];
              change({ assignee: v }, { assignee: v ? { kind, id, name: name ?? "?" } : null });
            }}
          />
        </Row>
        <Row label="Estimate">
          <div className="flex min-w-0 items-center gap-1">
            <EstimatePicker variant="field" value={task.estimate} onChange={(v) => change({ estimate: v }, { estimate: v })} />
            {task.overEstimate && (
              <span className="shrink-0" data-testid="over-estimate">
                <Tag tone="warn" title="In progress longer than the estimate (working hours)">
                  Over estimate
                </Tag>
              </span>
            )}
          </div>
        </Row>
        <Row label="Due date">
          <DuePicker variant="field" value={task.dueDate} today={today} overdue={task.isOverdue} onChange={(v) => change({ dueDate: v }, { dueDate: v })} />
        </Row>
        <Row label="Labels">
          <LabelsPicker variant="field" value={task.labels} options={options} onChange={(ids, labels) => change({ labelIds: ids }, { labels })} />
        </Row>
        <Row label="Company">
          <CompanyPicker
            variant="field"
            value={task.company}
            options={options}
            allowNone={task.visibility === "private"}
            onChange={(id) => {
              const c = options.companies.find((x) => x.id === id);
              change({ companyId: id }, { company: c ? { id: c.id, name: c.name, color: c.color, slug: "" } : null, project: null });
            }}
          />
        </Row>
        <Row label="Project">
          <ProjectPicker
            variant="field"
            value={task.project}
            companyId={task.company?.id ?? null}
            options={options}
            onChange={(id) => {
              const p = options.projects.find((x) => x.id === id);
              change({ projectId: id }, { project: p ? { id: p.id, name: p.name } : null });
            }}
          />
        </Row>
        {person && task.visibility === "shared" && (
          <Row label="Review">
            <label className="flex min-h-8 cursor-pointer items-center gap-2 px-2 text-[13px]">
              <input type="checkbox" checked={task.needsReview} onChange={(e) => change({ needsReview: e.target.checked }, { needsReview: e.target.checked })} />
              <span>Needs review</span>
            </label>
          </Row>
        )}
        {task.orgDepartment && (
          <Row label="Department">
            <span className="px-2 text-[13px]" data-testid="task-department">
              {task.orgDepartment.number} {task.orgDepartment.name}
            </span>
          </Row>
        )}
        <Row label="Who sees it">
          <span className="px-2 text-[13px]">{task.visibility === "private" ? "🔒 Only you (personal)" : "Both founders"}</span>
        </Row>
        <Row label="Created">
          <span className="px-2 text-[12.5px] text-muted">{createdLine}</span>
        </Row>
      </dl>
      {chase && (
        <details className="mt-3 border-t border-line pt-2" data-testid="chase-details">
          <summary className="cursor-pointer px-1 py-1 text-[13px] font-medium">Reminders (chase settings)</summary>
          <div className="mt-2">{chase}</div>
        </details>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// A comment in the activity timeline
// ---------------------------------------------------------------------------

export function CommentCard({
  id,
  author,
  text,
  at,
  edited,
  telegram,
  help,
  mine,
}: {
  id: string;
  author: string;
  text: string;
  at: string;
  edited: boolean;
  telegram: boolean;
  help: boolean;
  mine: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [askDelete, setAskDelete] = useState(false);
  const [pending, start] = useTransition();
  const submit = (fn: typeof editCommentAction, fields: Record<string, string>, after?: () => void) =>
    start(async () => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.set(k, v);
      const r: { ok?: boolean; error?: string; message?: string } = await fn({}, fd).catch(() => ({ ok: false, error: "Could not reach the server" }));
      if (r.ok) {
        toast(r.message ?? "Saved", { ms: 2000 });
        after?.();
      } else toast(r.error ?? "Could not save", { tone: "risk" });
    });
  return (
    <div className={`rounded-[10px] border border-line bg-surface px-3 py-2 ${pending ? "opacity-60" : ""}`} data-testid="task-comment">
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
        <span className="font-semibold text-ink">{author}</span>
        {telegram && <Tag tone="info">Telegram</Tag>}
        {help && <Tag tone="warn">Needs help</Tag>}
        <span className="num">{at}</span>
        {edited && <span>(edited)</span>}
        {mine && !editing && (
          <span className="ml-auto flex gap-1">
            <button type="button" className="rounded px-1.5 py-0.5 hover:bg-sunk hover:text-ink" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button type="button" className="rounded px-1.5 py-0.5 text-risk hover:bg-risk-soft" onClick={() => setAskDelete(true)}>
              Delete
            </button>
          </span>
        )}
      </div>
      {editing ? (
        <div className="mt-1.5 space-y-2">
          <textarea className="input min-h-[60px] text-[13px]" value={draft} maxLength={4000} aria-label="Comment text" onChange={(e) => setDraft(e.target.value)} autoFocus />
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary btn-sm" disabled={!draft.trim()} onClick={() => submit(editCommentAction, { commentId: id, text: draft }, () => setEditing(false))}>
              Save
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setDraft(text);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-1 whitespace-pre-wrap text-[13.5px]">{text}</p>
      )}
      <ConfirmDialog
        open={askDelete}
        title="Delete this comment?"
        confirmLabel="Delete"
        tone="danger"
        onCancel={() => setAskDelete(false)}
        onConfirm={() => {
          setAskDelete(false);
          submit(deleteCommentAction, { commentId: id });
        }}
      >
        <p>The comment is removed from the task.</p>
      </ConfirmDialog>
    </div>
  );
}
