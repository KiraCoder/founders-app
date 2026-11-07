"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  createRoutineAction,
  deleteRoutineAction,
  rerunRoutineAction,
  runRoutineNowAction,
  setRoutineStatusAction,
  updateRoutineAction,
  type RoutineFormState,
} from "@/app/(app)/routines/actions";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog } from "@/components/ui/Dialog";
import { IconButton } from "@/components/ui/IconButton";
import { toast } from "@/components/ui/Toast";
import { RoutineForm } from "./RoutineForm";
import { EMPTY_ROUTINE, type RoutineFormOptions, type RoutineFormValues, type RoutineTodayRun } from "./form-values";

/** What the action buttons need to know about a routine (serialisable, from a server page). */
export interface RoutineActionsData {
  id: string;
  title: string;
  status: string;
  /** Today's run status, if there is one. */
  todayStatus: string | null;
  hasRuns: boolean;
  commentsCount: number;
}

type Action = (prev: RoutineFormState, fd: FormData) => Promise<RoutineFormState>;

function useServerAction() {
  const [pending, start] = useTransition();
  const call = (action: Action, fields: Record<string, string>, after?: (s: RoutineFormState) => void) =>
    start(async () => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.set(k, v);
      const res = await action({}, fd);
      if (res.ok) toast(res.message ?? "Done");
      else if (res.error) toast(res.error, { tone: "risk" });
      after?.(res);
    });
  return { pending, call };
}

/**
 * The routine's icon actions (list rows and the routine page header): ▶ Run now, ↻ Re-run (today's
 * missing items, when today's run closed unfinished), ✎ Edit (a dialog), ⏸ / ▶ Pause / Resume,
 * 🗄 Archive (confirm) / Restore, 🗑 Delete (page only, never ran, confirm), 💬 comments, ↗ Open.
 * Every button has an aria-label + tooltip; results show as a toast.
 */
export function RoutineActions({
  data,
  edit,
  variant = "row",
}: {
  data: RoutineActionsData;
  /** The edit dialog (omit: ✎ links to the routine page, which opens it). */
  edit?: { initial: RoutineFormValues; today: RoutineTodayRun | null; options: RoutineFormOptions; openInitially?: boolean } | null;
  variant?: "row" | "page";
}) {
  const router = useRouter();
  const { pending, call } = useServerAction();
  const [editing, setEditing] = useState(!!edit?.openInitially);
  const [ask, setAsk] = useState<null | "archive" | "delete">(null);
  const id = { id: data.id };
  const active = data.status === "active";
  const closedUnfinished = data.todayStatus === "partly" || data.todayStatus === "missed";
  return (
    <div className={`flex flex-wrap items-center gap-0.5 ${pending ? "opacity-60" : ""}`} aria-label={`Actions for ${data.title}`} role="group">
      {active && <IconButton icon="play" tone="primary" label="Run now" disabled={pending} onClick={() => call(runRoutineNowAction, id)} />}
      {active && closedUnfinished && (
        <IconButton icon="rerun" label="Re-run missing items" disabled={pending} onClick={() => call(rerunRoutineAction, id)} />
      )}
      {data.status !== "archived" &&
        (edit ? (
          <IconButton icon="edit" label="Edit" onClick={() => setEditing(true)} />
        ) : (
          <IconButton icon="edit" label="Edit" href={`/routines/${data.id}?edit=1`} />
        ))}
      {(data.status === "active" || data.status === "paused") && (
        <IconButton
          icon={active ? "pause" : "play"}
          label={active ? "Pause" : "Resume"}
          disabled={pending}
          onClick={() => call(setRoutineStatusAction, { ...id, status: active ? "paused" : "active" })}
        />
      )}
      {data.status === "archived" ? (
        <IconButton icon="restore" label="Restore" disabled={pending} onClick={() => call(setRoutineStatusAction, { ...id, status: "active" })} />
      ) : (
        <IconButton icon="archive" label="Archive" disabled={pending} onClick={() => setAsk("archive")} />
      )}
      {variant === "page" && !data.hasRuns && <IconButton icon="trash" tone="danger" label="Delete" disabled={pending} onClick={() => setAsk("delete")} />}
      <IconButton icon="comment" label={`Comments (${data.commentsCount})`} badge={data.commentsCount} href={`/routines/${data.id}#comments`} />
      {variant === "row" && <IconButton icon="external" label="Open" href={`/routines/${data.id}`} />}

      <ConfirmDialog
        open={ask === "archive"}
        title={`Archive “${data.title}”?`}
        message="The bot stops asking and waiting messages are cancelled. The history stays; you can restore it later."
        confirmLabel="Archive"
        tone="danger"
        busy={pending}
        onCancel={() => setAsk(null)}
        onConfirm={() => {
          setAsk(null);
          call(setRoutineStatusAction, { ...id, status: "archived" });
        }}
      />
      <ConfirmDialog
        open={ask === "delete"}
        title={`Delete “${data.title}”?`}
        message="It never ran, so nothing is lost but the routine itself. This cannot be undone."
        confirmLabel="Delete"
        tone="danger"
        busy={pending}
        onCancel={() => setAsk(null)}
        onConfirm={() => {
          setAsk(null);
          call(deleteRoutineAction, id, (s) => s.ok && router.push("/routines"));
        }}
      />
      {edit && (
        <Dialog open={editing} onClose={() => setEditing(false)} title={`Edit “${data.title}”`} size="lg">
          <RoutineForm
            action={updateRoutineAction}
            initial={edit.initial}
            options={edit.options}
            today={edit.today}
            submitLabel="Save routine"
            onCancel={() => setEditing(false)}
            onDone={() => setEditing(false)}
          />
        </Dialog>
      )}
    </div>
  );
}

/** "+ New" (short) → the create dialog. After creating, the new routine's page opens. */
export function NewRoutineButton({
  options,
  prefill,
  openInitially = false,
  label = "+ New",
}: {
  options: RoutineFormOptions;
  prefill?: Partial<RoutineFormValues>;
  openInitially?: boolean;
  label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(openInitially);
  return (
    <>
      <button type="button" className="btn btn-primary" onClick={() => setOpen(true)} aria-label="New routine" title="New routine">
        {label}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="New routine" size="lg">
        <RoutineForm
          action={createRoutineAction}
          initial={{ ...EMPTY_ROUTINE, ...prefill }}
          options={options}
          submitLabel="Create routine"
          onCancel={() => setOpen(false)}
          onDone={(s) => {
            setOpen(false);
            if (s.id) router.push(`/routines/${s.id}`);
          }}
        />
      </Dialog>
    </>
  );
}
