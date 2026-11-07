"use client";

import { useActionState, useEffect, useState } from "react";
import { saveChaseAction, type TaskActionResult } from "@/app/(app)/tasks/actions";
import type { ChaseFormValue, PersonChaseSettings } from "@/lib/task-chase";
import { ChaseControl } from "./ChaseControl";
import { toast } from "@/components/ui/Toast";

/** The task page's "Reminders" card: the explicit chase choice, saved on its own. */
export function TaskChasePanel({
  taskId,
  value,
  assignee,
  nudgedFounder,
  person,
  dueDate,
  unreachable,
  hasNotes,
}: {
  taskId: string;
  value: ChaseFormValue;
  assignee: { kind: "person" | "user"; name: string } | null;
  nudgedFounder: string;
  person: PersonChaseSettings | null;
  dueDate: string | null;
  unreachable: string | null;
  hasNotes: boolean;
}) {
  const [v, setV] = useState(value);
  const [state, action, pending] = useActionState<TaskActionResult, FormData>(saveChaseAction, {});
  useEffect(() => {
    if (state.ok) toast(state.message ?? "Saved");
    else if (state.error) toast(`Couldn't save: ${state.error}`, { tone: "risk" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.nonce, state.error]);
  const dirty = JSON.stringify(v) !== JSON.stringify(value);
  return (
    <form action={action} className="card space-y-3 p-4" aria-label="Reminders for this task">
      <input type="hidden" name="taskId" value={taskId} />
      <ChaseControl
        value={v}
        onChange={setV}
        assignee={assignee}
        nudgedFounder={nudgedFounder}
        person={person}
        dueDate={dueDate}
        unreachable={unreachable}
        errors={state.ok ? undefined : state.fieldErrors}
        showShareNotes={hasNotes}
      />
      <p className="text-[12px] text-muted">Defaults for everyone: Settings → Team on Telegram (and each person&apos;s own chase settings).</p>
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary btn-sm" disabled={pending || !dirty}>
          {pending ? "Saving…" : "Save reminders"}
        </button>
        {dirty && (
          <button type="button" className="btn btn-sm" onClick={() => setV(value)}>
            Undo changes
          </button>
        )}
      </div>
    </form>
  );
}
