"use client";

import { useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  chaseNowAction,
  deleteTaskForGoodAction,
  pauseChasingAction,
  setStatusAction,
  type TaskActionResult,
} from "@/app/(app)/tasks/actions";
import type { TaskFormOptions } from "@/server/services/options";
import { DialogChecklist } from "./TaskChecklist";
import { TaskForm } from "./TaskForm";
import type { TaskActivityItem, TaskItem } from "./types";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog } from "@/components/ui/Dialog";
import { IconButton } from "@/components/ui/IconButton";
import { toast } from "@/components/ui/Toast";

type Ask = { kind: "archive" | "chase" | "delete" };

/** What a one-tap action changes before the server answers. */
export type TaskPatch = { status?: TaskItem["status"]; paused?: boolean };

/**
 * The task (and its activity) with the pending one-tap changes applied (`useOptimistic`): Done /
 * Reopen and Pause / Resume show at once; when the action fails, or once the page is re-rendered,
 * the server's data takes over again (rollback is automatic). A list row calls it to restyle the
 * whole row and passes the result to TaskActions; alone (the task page) TaskActions uses its own.
 */
export function useOptimisticTask(task: TaskItem, activity?: TaskActivityItem) {
  const [shown, patch] = useOptimistic({ task, activity }, (s, p: TaskPatch) => ({
    task: p.status ? { ...s.task, status: p.status, isOverdue: p.status === "done" || p.status === "cancelled" ? false : s.task.isOverdue } : s.task,
    activity: p.paused !== undefined && s.activity ? { ...s.activity, chase: { ...s.activity.chase, paused: p.paused } } : s.activity,
  }));
  return { task: shown.task, activity: shown.activity, patch };
}

/**
 * The control-center buttons of one task: ✓ Done, ✎ Edit (dialog), ↗ Open, 🔔 Chase now,
 * ⏸ Pause chasing, 🗄 Archive. Each has an accessible name and a tooltip; results go to a toast;
 * archive, delete and anything that messages the person ask first.
 */
export function TaskActions({
  task: given,
  activity: givenActivity,
  options,
  showOpen = true,
  canChase,
  afterDelete,
  optimistic,
  timeZone = "Asia/Bishkek",
}: {
  task: TaskItem;
  activity?: TaskActivityItem;
  options: TaskFormOptions;
  showOpen?: boolean;
  /** Founders manage the team bot (Chase now / Pause). */
  canChase: boolean;
  /** Where to go after "Delete" (the task page leaves itself). */
  afterDelete?: string;
  /** The row's optimistic state (`useOptimisticTask`); without it the buttons keep their own. */
  optimistic?: ReturnType<typeof useOptimisticTask>;
  /** For the edit dialog's checklist (tick times). */
  timeZone?: string;
}) {
  const own = useOptimisticTask(given, givenActivity);
  const { task, activity, patch } = optimistic ?? own;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const closed = task.status === "done" || task.status === "cancelled";
  const person = task.assignee?.kind === "person" && task.visibility === "shared" ? task.assignee : null;
  const paused = activity?.chase.paused ?? false;

  const act = (fn: () => Promise<TaskActionResult>, after?: () => void, change?: TaskPatch) =>
    start(async () => {
      if (change) patch(change);
      let r: TaskActionResult;
      try {
        r = await fn();
      } catch {
        r = { ok: false, error: "Could not reach the server. Nothing was changed." };
      }
      if (r.ok) {
        toast(r.message ?? "Done");
        after?.();
      } else toast(r.error ?? "Something went wrong", { tone: "risk" });
    });
  const done = task.status === "done";

  return (
    <div className={`flex shrink-0 flex-wrap items-center gap-0.5 ${pending ? "opacity-60" : ""}`} role="group" aria-label={`Actions for ${task.title}`} data-testid="task-actions">
      <IconButton
        icon="check"
        label={done ? "Reopen" : "Mark done"}
        tone="primary"
        pressed={done}
        disabled={pending || task.status === "cancelled"}
        onClick={() => act(() => setStatusAction(task.id, done ? "todo" : "done"), undefined, { status: done ? "todo" : "done" })}
      />
      {person && canChase && (
        <IconButton icon="play" tone="primary" label={`Chase ${person.name} now`} disabled={pending || closed} onClick={() => setAsk({ kind: "chase" })} />
      )}
      <IconButton icon="edit" label="Edit" onClick={() => setEditing(true)} disabled={pending} />
      {person && canChase && (
        <IconButton
          icon={paused ? "play" : "pause"}
          label={paused ? "Resume chasing" : "Pause chasing"}
          pressed={paused}
          disabled={pending || closed}
          onClick={() => act(() => pauseChasingAction(task.id, !paused), undefined, { paused: !paused })}
        />
      )}
      {task.status === "cancelled" ? (
        <IconButton icon="restore" label="Restore" disabled={pending} onClick={() => act(() => setStatusAction(task.id, "todo"))} />
      ) : (
        <IconButton icon="archive" label="Archive" disabled={pending} onClick={() => setAsk({ kind: "archive" })} />
      )}
      {showOpen && (
        <>
          <IconButton icon="comment" label={`Comments (${activity?.comments ?? 0})`} badge={activity?.comments ?? 0} href={`/tasks/${task.id}#comments`} />
          <IconButton icon="external" label="Open" href={`/tasks/${task.id}`} />
        </>
      )}

      <Dialog open={editing} onClose={() => setEditing(false)} title="Edit task" description={task.title} size="lg">
        <TaskForm
          options={options}
          task={task}
          onDone={() => setEditing(false)}
          sentToPerson={activity?.sentToPerson}
          chase={activity?.chase}
        />
        <DialogChecklist
          taskId={task.id}
          notifyName={person && activity?.sentToPerson && !closed ? person.name : null}
          timeZone={timeZone}
        />
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <a href={`/tasks/${task.id}`} className="text-[13px] text-accent hover:underline">
            Comments and timeline on the task page →
          </a>
          <button type="button" className="btn btn-ghost btn-sm text-risk" onClick={() => setAsk({ kind: "delete" })}>
            Delete task…
          </button>
        </div>
      </Dialog>

      <ConfirmDialog
        open={ask?.kind === "archive"}
        title="Archive this task?"
        confirmLabel="Archive"
        tone="danger"
        busy={pending}
        onCancel={() => setAsk(null)}
        onConfirm={() => act(() => setStatusAction(task.id, "cancelled"), () => setAsk(null))}
      >
        <p>
          “{task.title}” is marked <strong>cancelled</strong> and leaves the open lists (history kept; Restore brings it back).
        </p>
        {person && <p>No more reminders go to {person.name}.</p>}
      </ConfirmDialog>
      <ConfirmDialog
        open={ask?.kind === "chase"}
        title={`Remind ${person?.name ?? ""} now?`}
        confirmLabel="Send reminder"
        busy={pending}
        onCancel={() => setAsk(null)}
        onConfirm={() => act(() => chaseNowAction(task.id), () => setAsk(null))}
      >
        <p>
          {person?.name} gets a reminder about “{task.title}” on Telegram right away (quiet hours and their daily limit still apply).
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={ask?.kind === "delete"}
        title="Delete this task for good?"
        confirmLabel="Yes, delete"
        tone="danger"
        busy={pending}
        onCancel={() => setAsk(null)}
        onConfirm={() =>
          act(
            () => deleteTaskForGoodAction(task.id),
            () => {
              setAsk(null);
              setEditing(false);
              if (afterDelete) router.push(afterDelete);
            },
          )
        }
      >
        <p>“{task.title}”, its checklist and comments are deleted. Archive keeps the history instead.</p>
      </ConfirmDialog>
    </div>
  );
}
