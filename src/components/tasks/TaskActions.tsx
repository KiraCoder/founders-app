"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  chaseNowAction,
  deleteTaskForGoodAction,
  pauseChasingAction,
  setStatusAction,
  type TaskActionResult,
} from "@/app/(app)/tasks/actions";
import type { TaskFormOptions } from "@/server/services/options";
import { TaskForm } from "./TaskForm";
import type { TaskActivityItem, TaskItem } from "./types";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog } from "@/components/ui/Dialog";
import { IconButton } from "@/components/ui/IconButton";
import { toast } from "@/components/ui/Toast";

type Ask = { kind: "archive" | "chase" | "delete" };

/**
 * The control-center buttons of one task: ✓ Done, ✎ Edit (dialog), ↗ Open, 🔔 Chase now,
 * ⏸ Pause chasing, 🗄 Archive. Each has an accessible name and a tooltip; results go to a toast;
 * archive, delete and anything that messages the person ask first.
 */
export function TaskActions({
  task,
  activity,
  options,
  showOpen = true,
  canChase,
  afterDelete,
}: {
  task: TaskItem;
  activity?: TaskActivityItem;
  options: TaskFormOptions;
  showOpen?: boolean;
  /** Founders manage the team bot (Chase now / Pause). */
  canChase: boolean;
  /** Where to go after "Delete" (the task page leaves itself). */
  afterDelete?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const closed = task.status === "done" || task.status === "cancelled";
  const person = task.assignee?.kind === "person" && task.visibility === "shared" ? task.assignee : null;
  const paused = activity?.chase.paused ?? false;

  const act = (fn: () => Promise<TaskActionResult>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        toast(r.message ?? "Done");
        after?.();
      } else toast(r.error ?? "Something went wrong", { tone: "risk" });
    });

  return (
    <div className={`flex shrink-0 flex-wrap items-center justify-end gap-0.5 ${pending ? "opacity-60" : ""}`} data-testid="task-actions">
      <IconButton
        icon="check"
        label={task.status === "done" ? "Reopen" : "Mark done"}
        tone="ok"
        pressed={task.status === "done"}
        disabled={pending || task.status === "cancelled"}
        onClick={() => act(() => setStatusAction(task.id, task.status === "done" ? "todo" : "done"))}
      />
      <IconButton icon="edit" label="Edit" onClick={() => setEditing(true)} disabled={pending} />
      {showOpen && <IconButton icon="external" label="Open" href={`/tasks/${task.id}`} />}
      {person && canChase && (
        <>
          <IconButton icon="bell" label={`Chase ${person.name} now`} disabled={pending || closed} onClick={() => setAsk({ kind: "chase" })} />
          <IconButton
            icon={paused ? "play" : "pause"}
            label={paused ? "Resume chasing" : "Pause chasing"}
            pressed={paused}
            disabled={pending || closed}
            onClick={() => act(() => pauseChasingAction(task.id, !paused))}
          />
        </>
      )}
      {task.status === "cancelled" ? (
        <IconButton icon="restore" label="Restore" disabled={pending} onClick={() => act(() => setStatusAction(task.id, "todo"))} />
      ) : (
        <IconButton icon="archive" label="Archive" tone="danger" disabled={pending} onClick={() => setAsk({ kind: "archive" })} />
      )}

      <Dialog open={editing} onClose={() => setEditing(false)} title="Edit task" description={task.title} size="lg">
        <TaskForm
          options={options}
          task={task}
          onDone={() => setEditing(false)}
          sentToPerson={activity?.sentToPerson}
          chase={activity?.chase}
        />
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <a href={`/tasks/${task.id}`} className="text-[13px] text-accent hover:underline">
            Checklist, comments and timeline on the task page →
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
