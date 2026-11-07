"use client";

import { useActionState, useEffect, useRef, useState, startTransition } from "react";
import { saveRoutineChecklistAction, type RoutineFormState } from "@/app/(app)/routines/actions";
import { ChecklistEditor, type ChecklistDraftItem } from "@/components/ui/ChecklistEditor";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import type { RoutineTodayRun } from "./form-values";

const same = (a: ChecklistDraftItem[], b: ChecklistDraftItem[]) =>
  JSON.stringify(a.map((i) => [i.key ?? "", i.label.trim(), i.details ?? "", !!i.needsComment])) ===
  JSON.stringify(b.map((i) => [i.key ?? "", i.label.trim(), i.details ?? "", !!i.needsComment]));

/**
 * The routine page's checklist: read-only list + "Edit checklist" (add, edit, reorder, remove in
 * place, then Save). Same rules as the edit dialog: with today's run open the person gets ONE
 * updated message (asked first); with today's run done, new items start from the next run unless
 * "Add to today too" is chosen. A "Done button" routine becomes a checklist routine here.
 */
export function RoutineChecklistCard({
  routineId,
  items,
  today,
  assigneeName,
  canEdit,
}: {
  routineId: string;
  items: ChecklistDraftItem[];
  today: RoutineTodayRun | null;
  assigneeName: string;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(items);
  const [confirm, setConfirm] = useState<null | "open" | "done">(null);
  const [state, action, pending] = useActionState<RoutineFormState, FormData>(saveRoutineChecklistAction, {});
  const seen = useRef(state.nonce);
  useEffect(() => {
    if (!state.nonce || state.nonce === seen.current) return;
    seen.current = state.nonce;
    if (state.ok) {
      toast(state.message ?? "Checklist saved");
      setEditing(false);
    } else if (state.error) toast(state.error, { tone: "risk" });
  }, [state]);
  useEffect(() => {
    if (!editing) setDraft(items);
  }, [items, editing]);

  const added = draft.filter((i) => !i.key || !today?.itemKeys.includes(i.key)).length;
  const changed = !same(items, draft);
  const needsConfirm: null | "open" | "done" =
    !changed || !today ? null : today.status === "open" || today.status === "escalated" ? "open" : today.status === "done" && added > 0 ? "done" : null;

  const submit = (applyToToday: boolean) => {
    setConfirm(null);
    const fd = new FormData();
    fd.set("id", routineId);
    fd.set("items", JSON.stringify(draft.map((v) => ({ ...v, label: v.label.trim() })).filter((v) => v.label)));
    if (applyToToday) fd.set("applyToToday", "1");
    startTransition(() => action(fd));
  };

  return (
    <section className="mb-6" aria-labelledby="routine-checklist-heading">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 id="routine-checklist-heading" className="eyebrow">
          Checklist <span className="num">{items.length || ""}</span>
        </h2>
        {canEdit && !editing && (
          <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
            {items.length ? "Edit checklist" : "Add a checklist"}
          </button>
        )}
      </div>
      {editing ? (
        <form
          className="card space-y-3 p-4"
          aria-label="Edit checklist"
          onSubmit={(e) => {
            e.preventDefault();
            if (needsConfirm) setConfirm(needsConfirm);
            else submit(false);
          }}
        >
          <ChecklistEditor value={draft} onChange={setDraft} error={state.fieldErrors?.items?.[0]} />
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setDraft(items);
                setEditing(false);
              }}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={pending || !changed || draft.every((d) => !d.label.trim())}>
              {pending ? "Saving…" : "Save checklist"}
            </button>
          </div>
        </form>
      ) : items.length === 0 ? (
        <p className="card px-4 py-3 text-[13px] text-muted">No checklist: the person confirms with one “Готово” button.</p>
      ) : (
        <ol className="card divide-y divide-line text-[13px]" aria-label="Checklist">
          {items.map((i, n) => (
            <li key={i.key ?? n} className="flex flex-wrap items-baseline gap-2 px-4 py-2">
              <span className="num w-5 text-muted">{n + 1}</span>
              <span className="font-medium">{i.label}</span>
              {i.needsComment && <span className="tag tag-info">needs a comment</span>}
              {i.details && <span className="w-full pl-7 text-[12px] italic text-muted">{i.details}</span>}
            </li>
          ))}
        </ol>
      )}

      <ConfirmDialog
        open={confirm === "open"}
        title="Today's run is open"
        message={
          <>
            New items are added to today&apos;s run, removed items drop out of it (their ticks too), and {assigneeName} gets <b>one updated message</b> with the
            new checklist.
          </>
        }
        confirmLabel="Save and update today"
        onConfirm={() => submit(false)}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "done"}
        title="Today's run is already done"
        message={
          <>
            {assigneeName} finished today&apos;s checklist. The new item{added === 1 ? "" : "s"} can start with the next run, or be added to today too — that
            reopens today&apos;s run and asks {assigneeName} again.
          </>
        }
        confirmLabel="Save from the next run"
        secondary={{ label: "Add to today too", onClick: () => submit(true) }}
        onConfirm={() => submit(false)}
        onCancel={() => setConfirm(null)}
      />
    </section>
  );
}
