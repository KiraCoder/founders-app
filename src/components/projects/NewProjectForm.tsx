"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { createProjectAction, type ActionState } from "@/app/(app)/actions";
import { Icon } from "@/components/Icon";

export function NewProjectForm({ companyId }: { companyId: string }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<ActionState, FormData>(createProjectAction, {});
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) {
      ref.current?.reset();
      setOpen(false);
    }
  }, [state.nonce, state.ok]);

  if (!open) {
    return (
      <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
        <Icon name="plus" size={16} /> New project
      </button>
    );
  }
  return (
    <form ref={ref} action={action} className="card-raised w-full space-y-3 p-4" aria-label="New project">
      <input type="hidden" name="companyId" value={companyId} />
      <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
        <div>
          <label className="label">Name</label>
          <input name="name" required maxLength={200} className="input" autoFocus />
        </div>
        <div>
          <label className="label">Due date</label>
          <input type="date" name="dueDate" className="input" />
        </div>
      </div>
      <div>
        <label className="label">Description</label>
        <textarea name="description" rows={2} className="input" />
      </div>
      {state.error && <p className="text-[12px] text-risk">{state.error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          Create project
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
