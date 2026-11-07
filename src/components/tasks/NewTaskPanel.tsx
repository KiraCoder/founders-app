"use client";

import { useState } from "react";
import type { TaskFormOptions } from "@/server/services/options";
import { TaskForm, type TaskFormDefaults } from "./TaskForm";
import { Dialog } from "@/components/ui/Dialog";

/**
 * "+ New" (short button; its accessible name says "New task") that opens the task form in a
 * dialog. `label` replaces the text where the context needs more ("Assign a task" on a person).
 */
export function NewTaskPanel({
  options,
  defaults,
  label,
  startOpen = false,
}: {
  options: TaskFormOptions;
  defaults?: TaskFormDefaults;
  label?: string;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  return (
    <>
      <button type="button" className="btn btn-primary" onClick={() => setOpen(true)} aria-label={label ?? "New task"} aria-haspopup="dialog">
        <span aria-hidden="true">+</span> {label ?? "New"}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={label ?? "New task"} size="lg">
        <TaskForm options={options} defaults={defaults} onDone={() => setOpen(false)} />
      </Dialog>
    </>
  );
}
