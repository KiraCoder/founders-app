"use client";

import { useActionState, useEffect, useRef } from "react";
import { createTaskAction, type ActionState } from "@/app/(app)/actions";

/** One-line personal todo capture for the Today page. */
export function QuickAdd() {
  const [state, action, pending] = useActionState<ActionState, FormData>(createTaskAction, {});
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) ref.current?.reset();
  }, [state.nonce, state.ok]);
  return (
    <form ref={ref} action={action} className="card flex flex-wrap items-center gap-2 p-2" aria-label="Quick add">
      <input type="hidden" name="visibility" value="private" />
      <input
        name="title"
        required
        maxLength={300}
        placeholder="Quick add a personal todo…"
        aria-label="New personal todo"
        className="input min-w-0 flex-1 border-transparent"
      />
      <input type="date" name="dueDate" aria-label="Due date" className="input w-[150px]" />
      <button type="submit" className="btn btn-primary" disabled={pending}>
        Add
      </button>
      {state.error && <p className="w-full px-1 text-[12px] text-risk">{state.error}</p>}
    </form>
  );
}
