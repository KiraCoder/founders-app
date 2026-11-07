"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { assigneePeopleOptions } from "@/lib/task-assignee";
import { createTaskAction, updateTaskAction, type ActionState } from "@/app/(app)/actions";
import type { TaskFormOptions } from "@/server/services/options";
import { PRIORITY_OPTIONS, STATUS_OPTIONS } from "./labels";
import type { TaskItem } from "./types";
import { DateInput } from "@/components/DateInput";

export interface TaskFormDefaults {
  visibility?: "private" | "shared";
  companyId?: string;
  projectId?: string;
  orgDepartmentId?: string;
  /** Preset assignee ("user:<id>" or "person:<id>"), e.g. "Assign a task" on a person page. */
  assignee?: string;
}

export function TaskForm({
  options,
  task,
  defaults,
  onDone,
  compact,
}: {
  options: TaskFormOptions;
  task?: TaskItem;
  defaults?: TaskFormDefaults;
  onDone?: () => void;
  compact?: boolean;
}) {
  const isEdit = Boolean(task);
  const [state, action, pending] = useActionState<ActionState, FormData>(
    isEdit ? updateTaskAction : createTaskAction,
    {},
  );
  const formRef = useRef<HTMLFormElement>(null);
  const [visibility, setVisibility] = useState(task?.visibility ?? defaults?.visibility ?? "shared");
  const [companyId, setCompanyId] = useState(task?.company?.id ?? defaults?.companyId ?? "");
  const [projectId, setProjectId] = useState(task?.project?.id ?? defaults?.projectId ?? "");
  const [departmentId, setDepartmentId] = useState(task?.orgDepartment?.id ?? defaults?.orgDepartmentId ?? "");
  const initialAssignee = task?.assignee ? `${task.assignee.kind}:${task.assignee.id}` : task ? "" : (defaults?.assignee ?? "");
  const [assignee, setAssignee] = useState(initialAssignee);

  useEffect(() => {
    if (!state.ok) return;
    if (!isEdit) {
      formRef.current?.reset();
      setAssignee(defaults?.assignee ?? "");
    }
    onDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.nonce]);

  const projects = options.projects.filter((p) => !companyId || p.companyId === companyId);
  // Anyone who works for the task's company (the current assignee is kept even if they left).
  const people = companyId
    ? assigneePeopleOptions(options.peopleByCompany[companyId] ?? [], task?.assignee, { taskCompanyId: task?.company?.id, companyId })
    : [];
  const liveDepartments = companyId ? (options.departmentsByCompany?.[companyId] ?? []) : [];
  // The task's current department may be archived (not in the live list): keep it as an
  // option, or the controlled select would show "None" and saving would clear the link.
  const current = task?.orgDepartment && task.company?.id === companyId ? task.orgDepartment : null;
  const departments =
    current && !liveDepartments.some((d) => d.id === current.id)
      ? [...liveDepartments, { id: current.id, label: `${current.number} ${current.name} (archived)` }]
      : liveDepartments;
  const err = (f: string) => state.fieldErrors?.[f]?.[0];

  return (
    <form ref={formRef} action={action} className="space-y-3" aria-label={isEdit ? "Edit task" : "New task"}>
      {task && <input type="hidden" name="id" value={task.id} />}
      <div>
        <label className="label" htmlFor={`title-${task?.id ?? "new"}`}>
          Title
        </label>
        <input
          id={`title-${task?.id ?? "new"}`}
          name="title"
          required
          maxLength={300}
          defaultValue={task?.title}
          className="input"
          placeholder="What needs to happen?"
          autoFocus={!compact && !isEdit}
        />
        {err("title") && <p className="mt-1 text-[12px] text-risk">{err("title")}</p>}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <label className="label">Who sees it</label>
          <select
            name="visibility"
            className="input"
            value={visibility}
            onChange={(e) => {
              const v = e.target.value as "private" | "shared";
              setVisibility(v);
              if (v === "private") setAssignee("");
            }}
            disabled={isEdit && task?.ownerUserId !== options.currentUserId}
          >
            <option value="private">Only me (personal)</option>
            <option value="shared">Both founders</option>
          </select>
          {isEdit && task?.ownerUserId !== options.currentUserId && (
            <input type="hidden" name="visibility" value={visibility} />
          )}
        </div>
        <div>
          <label className="label">Company</label>
          <select
            name="companyId"
            className="input"
            value={companyId}
            onChange={(e) => {
              setCompanyId(e.target.value);
              setProjectId("");
              setDepartmentId("");
              if (assignee.startsWith("person:")) setAssignee("");
            }}
          >
            <option value="">{visibility === "private" ? "None" : "Choose…"}</option>
            {options.companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {err("companyId") && <p className="mt-1 text-[12px] text-risk">{err("companyId")}</p>}
        </div>
        <div>
          <label className="label">Due date</label>
          <DateInput name="dueDate" aria-label="Due date" defaultValue={task?.dueDate ?? ""} />
        </div>
        <div>
          <label className="label">Priority</label>
          <select name="priority" className="input" defaultValue={task?.priority ?? "normal"}>
            {PRIORITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!compact && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <label className="label">Assignee</label>
            <select name="assignee" className="input" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Nobody</option>
              {options.founders
                .filter((f) => visibility === "shared" || f.id === options.currentUserId)
                .map((f) => (
                  <option key={f.id} value={`user:${f.id}`}>
                    {f.shortName}
                    {f.id === options.currentUserId ? " (me)" : ""}
                  </option>
                ))}
              {visibility === "shared" &&
                people.map((p) => (
                  <option key={p.id} value={`person:${p.id}`}>
                    {p.name}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <label className="label">Project</label>
            <select name="projectId" className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">None</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Status</label>
            <select name="status" className="input" defaultValue={task?.status ?? "todo"}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {!compact && departments.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="col-span-2">
            <label className="label" htmlFor={`dept-${task?.id ?? "new"}`}>
              Department (org chart)
            </label>
            <select
              id={`dept-${task?.id ?? "new"}`}
              name="orgDepartmentId"
              className="input"
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
            >
              <option value="">None</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            {err("orgDepartmentId") && <p className="mt-1 text-[12px] text-risk">{err("orgDepartmentId")}</p>}
          </div>
        </div>
      )}

      {!compact && (
        <div>
          <label className="label">Notes</label>
          <textarea name="notes" rows={2} maxLength={5000} className="input" defaultValue={task?.notes ?? ""} />
        </div>
      )}

      {state.error && (
        <p role="alert" className="rounded-[8px] border border-risk-line bg-risk-soft px-3 py-2 text-[13px] text-risk">
          {state.error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : isEdit ? "Save changes" : "Add task"}
        </button>
        {onDone && (
          <button type="button" className="btn" onClick={onDone}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
