"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
import type { TaskFormOptions } from "@/server/services/options";
import { TaskForm, type TaskFormDefaults } from "./TaskForm";

/** "New task" button that expands into the full form. */
export function NewTaskPanel({
  options,
  defaults,
  label = "New task",
  startOpen = false,
}: {
  options: TaskFormOptions;
  defaults?: TaskFormDefaults;
  label?: string;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  if (!open) {
    return (
      <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
        <Icon name="plus" size={16} /> {label}
      </button>
    );
  }
  return (
    <div className="card-raised w-full p-4">
      <TaskForm options={options} defaults={defaults} onDone={() => setOpen(false)} />
    </div>
  );
}
