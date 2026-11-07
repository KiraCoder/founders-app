"use client";

import { useActionState, useEffect, useId, useOptimistic, useRef, useState, useTransition } from "react";
import {
  addChecklistItemAction,
  loadChecklistAction,
  moveChecklistItemAction,
  removeChecklistItemAction,
  toggleChecklistItemAction,
  updateChecklistItemAction,
  type TaskActionResult,
} from "@/app/(app)/tasks/actions";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { IconButton } from "@/components/ui/IconButton";
import { toast } from "@/components/ui/Toast";

export interface ChecklistItemData {
  id: string;
  title: string;
  details: string | null;
  doneAt: string | null;
  doneBy: string | null;
  doneVia: "app" | "telegram" | null;
}

export interface DraftItem {
  title: string;
  details: string;
}

function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted" aria-label={`${done} of ${total} done`}>
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-sunk" aria-hidden="true">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <span className="num">
        {done}/{total}
      </span>
    </div>
  );
}

/** Title + optional details inputs (shared by the add row and the inline edit). */
function ItemFields({ idPrefix, title, details, errors }: { idPrefix: string; title?: string; details?: string | null; errors?: Record<string, string[]> }) {
  const [showDetails, setShowDetails] = useState(Boolean(details));
  return (
    <div className="min-w-0 flex-1 space-y-2">
      <div>
        <label className="sr-only" htmlFor={`${idPrefix}-title`}>
          Item
        </label>
        <input
          id={`${idPrefix}-title`}
          name="title"
          required
          maxLength={300}
          defaultValue={title}
          className="input"
          placeholder="Checklist item"
          aria-invalid={!!errors?.title}
        />
        {errors?.title && <p className="mt-1 text-[12px] text-risk">{errors.title[0]}</p>}
      </div>
      {showDetails ? (
        <div>
          <label className="sr-only" htmlFor={`${idPrefix}-details`}>
            Details
          </label>
          <textarea id={`${idPrefix}-details`} name="details" rows={2} maxLength={2000} defaultValue={details ?? ""} className="input" placeholder="Details (optional)" />
        </div>
      ) : (
        <button type="button" className="text-[12px] text-accent hover:underline" onClick={() => setShowDetails(true)}>
          + Add details
        </button>
      )}
    </div>
  );
}

/**
 * The task's checklist on the task page / edit dialog: tick (time + who are shown), add one by one,
 * edit, move up / down, remove. When the task was already sent to its person, the first change
 * asks once: they get ONE updated message with the whole checklist.
 */
export function TaskChecklist({
  taskId,
  items,
  notifyName,
  readOnly,
  timeZone,
  onChanged,
}: {
  taskId: string;
  items: ChecklistItemData[];
  /** The person who gets an updated card on a change (task already sent to them), else null. */
  notifyName: string | null;
  readOnly?: boolean;
  timeZone: string;
  /** Called after every saved change (the edit dialog reloads its copy; the page re-renders itself). */
  onChanged?: () => Promise<void> | void;
}) {
  const [state, addAction, adding] = useActionState<TaskActionResult, FormData>(addChecklistItemAction, {});
  const addForm = useRef<HTMLFormElement>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [ask, setAsk] = useState<null | { what: string; go: () => void }>(null);
  const [editing, setEditing] = useState<string | null>(null);
  // Ticks show at once (useOptimistic) and several can be in flight; a failed one rolls back
  // (the server's list takes over when its transition ends) with a toast.
  const [shown, tick] = useOptimistic(items, (list, t: { id: string; done: boolean }) =>
    list.map((i) => (i.id === t.id ? { ...i, doneAt: t.done ? new Date().toISOString() : null, doneBy: null, doneVia: t.done ? ("app" as const) : null, saving: true } : i)),
  );
  const [pending, start] = useTransition();
  const [, startTick] = useTransition();
  const fid = useId();
  const fmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone });
  const done = shown.filter((i) => i.doneAt).length;

  useEffect(() => {
    if (state.ok) {
      addForm.current?.reset();
      toast(state.message ?? "Saved");
      void onChanged?.();
    } else if (state.error) toast(state.error, { tone: "risk" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.nonce, state.error]);

  const guarded = (what: string, go: () => void) => {
    if (notifyName && !confirmed) setAsk({ what, go });
    else go();
  };
  const settle = async (fn: () => Promise<TaskActionResult>) => {
    let r: TaskActionResult;
    try {
      r = await fn();
    } catch {
      r = { ok: false, error: "Could not reach the server. Nothing was changed." };
    }
    if (r.ok) {
      toast(r.message ?? "Saved");
      // Inside the same transition: the optimistic state holds until the fresh copy is in.
      await onChanged?.();
    } else toast(r.error ?? "Something went wrong", { tone: "risk" });
  };
  const act = (fn: () => Promise<TaskActionResult>) => start(() => settle(fn));
  const toggle = (id: string, on: boolean) =>
    startTick(async () => {
      tick({ id, done: on });
      await settle(() => toggleChecklistItemAction(id, on));
    });

  return (
    <div className="space-y-3" data-testid="task-checklist">
      {shown.length > 0 && <Progress done={done} total={shown.length} />}
      <ul className={`card divide-y divide-line ${pending ? "opacity-60" : ""}`} aria-label="Checklist">
        {shown.length === 0 && <li className="px-4 py-3 text-[13px] text-muted">No checklist items yet.</li>}
        {shown.map((item, n) => (
          <li key={item.id} className="flex items-start gap-3 px-3 py-2.5 sm:px-4" data-testid="checklist-item">
            <input
              type="checkbox"
              className="mt-1 size-[18px] shrink-0 accent-[var(--accent)]"
              checked={!!item.doneAt}
              disabled={readOnly || pending}
              aria-label={`${item.doneAt ? "Untick" : "Tick"} “${item.title}”`}
              onChange={(e) => toggle(item.id, e.target.checked)}
            />
            {editing === item.id ? (
              <EditItem
                item={item}
                onDone={() => {
                  setEditing(null);
                  void onChanged?.();
                }}
                guard={(go) => guarded("edit this item", go)}
              />
            ) : (
              <div className="min-w-0 flex-1">
                <p className={`text-[14px] ${item.doneAt ? "text-muted line-through" : ""}`}>
                  <span className="num mr-1 text-muted">{n + 1}.</span>
                  {item.title}
                </p>
                {item.details && <p className="mt-0.5 whitespace-pre-wrap text-[12px] text-muted">{item.details}</p>}
                {item.doneAt && (
                  <p className="mt-0.5 text-[12px] text-ok" data-testid="checklist-done-meta">
                    ✓ {fmt.format(new Date(item.doneAt))} · {item.doneBy ?? ("saving" in item ? "saving…" : "?")}
                    {item.doneVia === "telegram" ? " (Telegram)" : ""}
                  </p>
                )}
              </div>
            )}
            {!readOnly && editing !== item.id && (
              <div className="flex shrink-0 gap-0.5">
                <IconButton
                  icon="chevronUp"
                  size="sm"
                  label={`Move “${item.title}” up`}
                  disabled={pending || n === 0}
                  onClick={() => guarded("reorder the checklist", () => act(() => moveChecklistItemAction(item.id, "up")))}
                />
                <IconButton
                  icon="chevronDown"
                  size="sm"
                  label={`Move “${item.title}” down`}
                  disabled={pending || n === shown.length - 1}
                  onClick={() => guarded("reorder the checklist", () => act(() => moveChecklistItemAction(item.id, "down")))}
                />
                <IconButton icon="edit" label={`Edit “${item.title}”`} onClick={() => setEditing(item.id)} />
                <IconButton
                  icon="trash"
                  label={`Remove “${item.title}”`}
                  tone="danger"
                  onClick={() => setAsk({ what: `remove “${item.title}”`, go: () => act(() => removeChecklistItemAction(item.id)) })}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
      {!readOnly && (
        <form
          ref={addForm}
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            guarded("add this item", () => start(() => addAction(fd)));
          }}
          className="flex flex-wrap items-start gap-2"
          aria-label="Add checklist item"
        >
          <input type="hidden" name="taskId" value={taskId} />
          <ItemFields idPrefix={`${fid}-add`} errors={state.ok ? undefined : state.fieldErrors} />
          <button type="submit" className="btn" disabled={adding}>
            {adding ? "Adding…" : "+ Add item"}
          </button>
        </form>
      )}
      <ConfirmDialog
        open={!!ask}
        title={ask?.what.startsWith("remove") ? "Remove this item?" : "Update the message?"}
        confirmLabel={ask?.what.startsWith("remove") ? "Remove" : "Continue"}
        tone={ask?.what.startsWith("remove") ? "danger" : "primary"}
        onCancel={() => setAsk(null)}
        onConfirm={() => {
          const go = ask?.go;
          setAsk(null);
          if (notifyName) setConfirmed(true);
          go?.();
        }}
      >
        {ask?.what.startsWith("remove") && <p>The item and its tick are removed from the task.</p>}
        {notifyName && (
          <p>
            {notifyName} already has this task on Telegram, so {notifyName} will get <strong>one updated message</strong> with the whole
            checklist (changes made in the next minute go into the same message). Continue?
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}

function EditItem({ item, onDone, guard }: { item: ChecklistItemData; onDone: () => void; guard: (go: () => void) => void }) {
  const [state, action, pending] = useActionState<TaskActionResult, FormData>(updateChecklistItemAction, {});
  const [, start] = useTransition();
  const fid = useId();
  useEffect(() => {
    if (state.ok) {
      toast(state.message ?? "Saved");
      onDone();
    } else if (state.error) toast(state.error, { tone: "risk" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.nonce, state.error]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        guard(() => start(() => action(fd)));
      }}
      className="flex min-w-0 flex-1 flex-wrap items-start gap-2" aria-label="Edit checklist item">
      <input type="hidden" name="itemId" value={item.id} />
      <ItemFields idPrefix={`${fid}-edit`} title={item.title} details={item.details} errors={state.ok ? undefined : state.fieldErrors} />
      <div className="flex gap-1">
        <button type="submit" className="btn btn-sm btn-primary" disabled={pending}>
          Save
        </button>
        <button type="button" className="btn btn-sm" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The create dialog's checklist: items kept in the form until the task is saved (posted as JSON). */
export function DraftChecklist({ items, onChange }: { items: DraftItem[]; onChange: (items: DraftItem[]) => void }) {
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const fid = useId();
  const add = () => {
    if (!title.trim()) return;
    onChange([...items, { title: title.trim(), details: details.trim() }]);
    setTitle("");
    setDetails("");
    setShowDetails(false);
  };
  return (
    <div className="space-y-2" data-testid="draft-checklist">
      <input type="hidden" name="checklist" value={JSON.stringify(items)} />
      {items.length > 0 && (
        <ul className="card divide-y divide-line" aria-label="Checklist">
          {items.map((i, n) => (
            <li key={n} className="flex items-start gap-2 px-3 py-2 text-[13px]">
              <span aria-hidden="true">⬜</span>
              <div className="min-w-0 flex-1">
                <p>{i.title}</p>
                {i.details && <p className="text-[12px] text-muted">{i.details}</p>}
              </div>
              <IconButton icon="close" label={`Remove “${i.title}”`} tone="danger" onClick={() => onChange(items.filter((_, k) => k !== n))} />
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1 space-y-2">
          <label className="sr-only" htmlFor={`${fid}-t`}>
            New checklist item
          </label>
          <input
            id={`${fid}-t`}
            className="input"
            placeholder="Add a checklist item (optional)"
            maxLength={300}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          {showDetails ? (
            <textarea className="input" rows={2} maxLength={2000} placeholder="Details (optional)" aria-label="Item details" value={details} onChange={(e) => setDetails(e.target.value)} />
          ) : (
            <button type="button" className="text-[12px] text-accent hover:underline" onClick={() => setShowDetails(true)}>
              + Add details
            </button>
          )}
        </div>
        <button type="button" className="btn" onClick={add} disabled={!title.trim()}>
          + Add item
        </button>
      </div>
    </div>
  );
}

/**
 * The checklist inside the task's edit dialog: list rows only carry counts, so the items are read
 * when the dialog opens and again after each change (every change is saved at once).
 */
export function DialogChecklist({ taskId, notifyName, timeZone }: { taskId: string; notifyName: string | null; timeZone: string }) {
  const [items, setItems] = useState<ChecklistItemData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = async () => {
    const r = await loadChecklistAction(taskId);
    setError(r.error ?? null);
    setItems(r.items);
  };
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);
  return (
    <section className="mt-5 border-t border-line pt-4" aria-labelledby={`${taskId}-dialog-checklist`}>
      <h3 id={`${taskId}-dialog-checklist`} className="label mb-2">
        Checklist <span className="font-normal text-muted">· each change is saved at once</span>
      </h3>
      {error ? (
        <p className="text-[13px] text-risk">{error}</p>
      ) : items === null ? (
        <p className="text-[13px] text-muted">Loading the checklist…</p>
      ) : (
        <TaskChecklist taskId={taskId} items={items} notifyName={notifyName} timeZone={timeZone} onChanged={reload} />
      )}
    </section>
  );
}
