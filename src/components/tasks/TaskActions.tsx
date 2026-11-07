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
import { Icon } from "@/components/Icon";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog } from "@/components/ui/Dialog";
import { IconButton } from "@/components/ui/IconButton";
import { Menu, type MenuOption } from "@/components/ui/Menu";
import { toast } from "@/components/ui/Toast";

type Ask = { kind: "archive" | "chase" | "delete" };

/** What a one-tap action changes before the server answers. */
export type TaskPatch = { status?: TaskItem["status"]; paused?: boolean };

/**
 * The task (and its activity) with the pending one-tap changes applied (`useOptimistic`): Done /
 * Reopen and Pause / Resume show at once; when the action fails, or once the page is re-rendered,
 * the server's data takes over again (rollback is automatic). Alone (the task page) TaskActions
 * uses its own; a list row passes its own patch function.
 */
export function useOptimisticTask(task: TaskItem, activity?: TaskActivityItem) {
  const [shown, patch] = useOptimistic({ task, activity }, (s, p: TaskPatch) => ({
    task: p.status ? { ...s.task, status: p.status, isOverdue: p.status === "done" || p.status === "cancelled" ? false : s.task.isOverdue } : s.task,
    activity: p.paused !== undefined && s.activity ? { ...s.activity, chase: { ...s.activity.chase, paused: p.paused } } : s.activity,
  }));
  return { task: shown.task, activity: shown.activity, patch };
}

/**
 * A task's actions: Edit (dialog), Open, Chase now, Pause / Resume chasing, Archive / Restore,
 * Delete. `variant="menu"` (list rows): one "⋯" button opening a menu; `variant="buttons"` (the
 * task page): icon buttons. Each has an accessible name; results go to a toast; archive, delete
 * and anything that messages the person ask first.
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
  variant = "buttons",
}: {
  task: TaskItem;
  activity?: TaskActivityItem;
  options: TaskFormOptions;
  showOpen?: boolean;
  /** Founders manage the team bot (Chase now / Pause). */
  canChase: boolean;
  /** Where to go after "Delete" (the task page leaves itself). */
  afterDelete?: string;
  /** The row's optimistic state; without it the buttons keep their own. */
  optimistic?: { task: TaskItem; activity?: TaskActivityItem; patch: (p: TaskPatch) => void };
  /** For the edit dialog's checklist (tick times). */
  timeZone?: string;
  variant?: "buttons" | "menu";
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
  const togglePause = () => act(() => pauseChasingAction(task.id, !paused), undefined, { paused: !paused });
  const restore = () => act(() => setStatusAction(task.id, "todo"), undefined, { status: "todo" });

  const menu: MenuOption[] = [
    { value: "edit", label: "Edit…", icon: <Icon name="edit" size={14} /> },
    ...(showOpen ? [{ value: "open", label: "Open task", icon: <Icon name="external" size={14} /> }] : []),
    ...(person && canChase && !closed
      ? [
          { value: "chase", label: `Chase ${person.name} now`, icon: <Icon name="play" size={14} /> },
          { value: "pause", label: paused ? "Resume chasing" : "Pause chasing", icon: <Icon name={paused ? "play" : "pause"} size={14} /> },
        ]
      : []),
    task.status === "cancelled"
      ? { value: "restore", label: "Restore", icon: <Icon name="restore" size={14} /> }
      : { value: "archive", label: "Archive (cancel)", icon: <Icon name="archive" size={14} /> },
    { value: "delete", label: "Delete…", icon: <Icon name="trash" size={14} /> },
  ];
  const onMenu = (v: string) => {
    if (v === "edit") setEditing(true);
    else if (v === "open") router.push(`/tasks/${task.id}`);
    else if (v === "chase") setAsk({ kind: "chase" });
    else if (v === "pause") togglePause();
    else if (v === "restore") restore();
    else if (v === "archive") setAsk({ kind: "archive" });
    else if (v === "delete") setAsk({ kind: "delete" });
  };

  return (
    <div className={`flex shrink-0 flex-wrap items-center gap-0.5 ${pending ? "opacity-60" : ""}`} role="group" aria-label={`Actions for ${task.title}`} data-testid="task-actions">
      {variant === "menu" ? (
        <Menu
          label={`More actions for ${task.title}`}
          title="More actions"
          options={menu}
          value={null}
          searchable={false}
          width={220}
          onSelect={onMenu}
          trigger={(p) => (
            <button
              type="button"
              {...p}
              ref={p.ref as (el: HTMLButtonElement | null) => void}
              className="inline-flex size-6 items-center justify-center rounded-[6px] text-muted opacity-60 hover:bg-sunk hover:text-ink hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent group-hover:opacity-100 aria-expanded:opacity-100"
            >
              <Icon name="more" size={16} />
            </button>
          )}
        />
      ) : (
        <>
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
            <IconButton icon={paused ? "play" : "pause"} label={paused ? "Resume chasing" : "Pause chasing"} pressed={paused} disabled={pending || closed} onClick={togglePause} />
          )}
          {task.status === "cancelled" ? (
            <IconButton icon="restore" label="Restore" disabled={pending} onClick={restore} />
          ) : (
            <IconButton icon="archive" label="Archive" disabled={pending} onClick={() => setAsk({ kind: "archive" })} />
          )}
          {showOpen && (
            <>
              <IconButton icon="comment" label={`Comments (${activity?.comments ?? 0})`} badge={activity?.comments ?? 0} href={`/tasks/${task.id}#comments`} />
              <IconButton icon="external" label="Open" href={`/tasks/${task.id}`} />
            </>
          )}
        </>
      )}

      <Dialog open={editing} onClose={() => setEditing(false)} title="Edit task" description={`${task.key} · ${task.title}`} size="lg">
        <TaskForm options={options} task={task} onDone={() => setEditing(false)} sentToPerson={activity?.sentToPerson} chase={activity?.chase} />
        <DialogChecklist taskId={task.id} notifyName={person && activity?.sentToPerson && !closed ? person.name : null} timeZone={timeZone} />
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <a href={`/tasks/${task.id}`} className="text-[13px] text-accent hover:underline">
            Activity and comments on the task page →
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
        onConfirm={() => act(() => setStatusAction(task.id, "cancelled"), () => setAsk(null), { status: "cancelled" })}
      >
        <p>
          “{task.title}” is marked <strong>Canceled</strong> and leaves the active lists (history kept; Restore brings it back).
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
        <p>“{task.title}”, its sub-tasks and comments are deleted. Archive keeps the history instead.</p>
      </ConfirmDialog>
    </div>
  );
}
