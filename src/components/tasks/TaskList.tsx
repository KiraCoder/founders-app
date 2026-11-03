"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { deleteTaskAction, setTaskDeadlineAction, setTaskStatusAction } from "@/app/(app)/actions";
import { Icon } from "@/components/Icon";
import { CompanyDot, Tag } from "@/components/ui";
import { daysBetween, formatDueDate } from "@/lib/dates";
import type { TaskFormOptions } from "@/server/services/options";
import { PRIORITY_TONE, STATUS_OPTIONS, STATUS_TONE, priorityLabel, statusLabel } from "./labels";
import { TaskForm } from "./TaskForm";
import type { TaskItem } from "./types";
import { DateInput } from "@/components/DateInput";

export function TaskList({
  tasks,
  today,
  options,
  empty = "Nothing here.",
  showCompany = true,
}: {
  tasks: TaskItem[];
  today: string;
  options: TaskFormOptions;
  empty?: string;
  showCompany?: boolean;
}) {
  if (tasks.length === 0) {
    return <div className="card px-4 py-6 text-center text-[13px] text-muted">{empty}</div>;
  }
  return (
    <ul className="card divide-y divide-line" aria-label="Tasks">
      {tasks.map((t) => (
        <TaskRow key={t.id} task={t} today={today} options={options} showCompany={showCompany} />
      ))}
    </ul>
  );
}

function DueChip({ task, today }: { task: TaskItem; today: string }) {
  if (!task.dueDate) return null;
  if (task.isOverdue) {
    const days = daysBetween(task.dueDate, today);
    return (
      <Tag tone="risk" title={`Due ${task.dueDate}`}>
        Overdue · <span className="num">{days}d</span>
      </Tag>
    );
  }
  const closed = task.status === "done" || task.status === "cancelled";
  return (
    <Tag tone={!closed && task.dueDate === today ? "warn" : "neutral"} title={task.dueDate}>
      <span className="num">{formatDueDate(task.dueDate, today)}</span>
    </Tag>
  );
}

function TaskRow({
  task,
  today,
  options,
  showCompany,
}: {
  task: TaskItem;
  today: string;
  options: TaskFormOptions;
  showCompany: boolean;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "confirm-delete">("view");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [deadline, setDeadline] = useState(task.dueDate ?? "");
  const closed = task.status === "done" || task.status === "cancelled";

  const act = (fn: () => Promise<{ ok?: boolean; error?: string }>) =>
    startTransition(async () => {
      const res = await fn();
      setError(res.ok ? null : res.error ?? "Something went wrong");
    });

  return (
    <li className={`px-3 py-2.5 sm:px-4 ${pending ? "opacity-60" : ""}`} data-task-id={task.id}>
      <div className="flex items-start gap-3">
        <button
          type="button"
          aria-label={task.status === "done" ? `Reopen "${task.title}"` : `Mark "${task.title}" done`}
          onClick={() => act(() => setTaskStatusAction(task.id, task.status === "done" ? "todo" : "done"))}
          className={`mt-0.5 grid size-[18px] shrink-0 place-items-center rounded-[5px] border ${
            task.status === "done" ? "border-accent bg-accent text-accent-ink" : "border-line bg-surface hover:border-accent"
          }`}
        >
          {task.status === "done" && <Icon name="check" size={13} />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={`text-[14px] ${closed ? "text-muted line-through" : "font-medium"}`}>{task.title}</span>
            {task.visibility === "private" && (
              <Tag title="Only you can see this">
                <Icon name="lock" size={11} /> Personal
              </Tag>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
            <DueChip task={task} today={today} />
            {task.status !== "todo" && <Tag tone={STATUS_TONE[task.status]}>{statusLabel(task.status)}</Tag>}
            {task.priority !== "normal" && <Tag tone={PRIORITY_TONE[task.priority]}>{priorityLabel(task.priority)}</Tag>}
            {showCompany && task.company && (
              <Link href={`/companies/${task.company.slug}`} className="inline-flex items-center gap-1 hover:text-ink">
                <CompanyDot color={task.company.color} size={7} /> {task.company.name}
              </Link>
            )}
            {task.project && (
              <Link href={`/projects/${task.project.id}`} className="inline-flex items-center gap-1 hover:text-ink">
                <Icon name="folder" size={12} /> {task.project.name}
              </Link>
            )}
            {task.orgDepartment && (
              <span className="tag" title={`Department ${task.orgDepartment.number} ${task.orgDepartment.name} (org chart)`} data-testid="task-department">
                {task.orgDepartment.number} {task.orgDepartment.name}
              </span>
            )}
            {task.assignee && <span>→ {task.assignee.name}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <select
            aria-label="Status"
            className="input hidden h-[30px] w-[124px] text-[13px] sm:block"
            value={task.status}
            onChange={(e) => act(() => setTaskStatusAction(task.id, e.target.value))}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setMode(mode === "edit" ? "view" : "edit")}
            aria-expanded={mode === "edit"}
          >
            Edit
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-[12px] text-risk">
          {error}
        </p>
      )}

      {mode !== "view" && (
        <div className="mt-3 space-y-4 rounded-[10px] border border-line bg-sunk/60 p-3">
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="label" htmlFor={`deadline-${task.id}`}>
                Move deadline
              </label>
              <DateInput id={`deadline-${task.id}`} className="input w-[170px]" value={deadline} onChange={setDeadline} />
            </div>
            <button
              type="button"
              className="btn"
              disabled={deadline === (task.dueDate ?? "")}
              onClick={() => act(() => setTaskDeadlineAction(task.id, deadline || null))}
            >
              Save deadline
            </button>
            <select
              aria-label="Status (mobile)"
              className="input w-[140px] sm:hidden"
              value={task.status}
              onChange={(e) => act(() => setTaskStatusAction(task.id, e.target.value))}
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <TaskForm options={options} task={task} onDone={() => setMode("view")} />

          <div className="border-t border-line pt-3">
            {mode === "confirm-delete" ? (
              <div role="alertdialog" aria-label="Confirm delete" className="flex flex-wrap items-center gap-2">
                <span className="text-[13px]">Delete this task for good?</span>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  onClick={() => act(() => deleteTaskAction(task.id))}
                >
                  Yes, delete
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setMode("edit")}>
                  Keep it
                </button>
              </div>
            ) : (
              <button type="button" className="btn btn-ghost btn-sm text-risk" onClick={() => setMode("confirm-delete")}>
                Delete task…
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
