"use client";

import { useActionState, useEffect, useId, useMemo, useRef, useState } from "react";
import { saveTaskAction, type TaskActionResult } from "@/app/(app)/tasks/actions";
import { DateInput } from "@/components/DateInput";
import { assigneePeopleOptions } from "@/lib/task-assignee";
import { chaseFormValue, type ChaseFormValue } from "@/lib/task-chase";
import type { TaskFormOptions } from "@/server/services/options";
import { ChaseControl } from "./ChaseControl";
import { PRIORITY_OPTIONS, STATUS_OPTIONS } from "./labels";
import { DraftChecklist, type DraftItem } from "./TaskChecklist";
import type { TaskItem } from "./types";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { useToast } from "./ui/Toast";

export interface TaskFormDefaults {
  visibility?: "private" | "shared";
  companyId?: string;
  projectId?: string;
  orgDepartmentId?: string;
  /** Preset assignee ("user:<id>" or "person:<id>"), e.g. "Assign a task" on a person page. */
  assignee?: string;
}

/** Companies each person works for (inverted from options.peopleByCompany). */
export function companiesByPerson(options: TaskFormOptions): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [companyId, list] of Object.entries(options.peopleByCompany)) {
    for (const p of list) out.set(p.id, [...(out.get(p.id) ?? []), companyId]);
  }
  return out;
}

/**
 * Create / edit a task (inside a dialog). Pick the assignee first: a person limits the company
 * choice to the companies they work for (one company is picked for you); the server checks the
 * same. Inline field errors; the result goes to a toast. Editing a task its person already got on
 * Telegram (title, deadline, priority, shared notes) asks first: they get one updated message.
 */
export function TaskForm({
  options,
  task,
  defaults,
  onDone,
  sentToPerson,
  chase,
}: {
  options: TaskFormOptions;
  task?: TaskItem;
  defaults?: TaskFormDefaults;
  onDone?: () => void;
  /** The task's person already got it on Telegram (edit only). */
  sentToPerson?: boolean;
  /** The task's current chase choice (edit only; without it the chase control is not shown). */
  chase?: ChaseFormValue;
}) {
  const isEdit = Boolean(task);
  const toast = useToast();
  const [state, action, pending] = useActionState<TaskActionResult, FormData>(saveTaskAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  const confirmedRef = useRef(false);
  const fid = useId();
  const [visibility, setVisibility] = useState(task?.visibility ?? defaults?.visibility ?? "shared");
  const [companyId, setCompanyId] = useState(task?.company?.id ?? defaults?.companyId ?? "");
  const [projectId, setProjectId] = useState(task?.project?.id ?? defaults?.projectId ?? "");
  const [departmentId, setDepartmentId] = useState(task?.orgDepartment?.id ?? defaults?.orgDepartmentId ?? "");
  const initialAssignee = task?.assignee ? `${task.assignee.kind}:${task.assignee.id}` : task ? "" : (defaults?.assignee ?? "");
  const [assignee, setAssignee] = useState(initialAssignee);
  const [dueDate, setDueDate] = useState(task?.dueDate ?? "");
  const [chaseValue, setChaseValue] = useState<ChaseFormValue>(chase ?? { ...chaseFormValue({}), shareNotes: !isEdit });
  const [draft, setDraft] = useState<DraftItem[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const byPerson = useMemo(() => companiesByPerson(options), [options]);
  const allPeople = useMemo(() => {
    const seen = new Map<string, string>();
    for (const list of Object.values(options.peopleByCompany)) for (const p of list) seen.set(p.id, p.name);
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [options]);
  const personId = assignee.startsWith("person:") ? assignee.slice(7) : null;
  const personCompanies = personId ? (byPerson.get(personId) ?? []) : null;
  // A person limits the companies to theirs (the task's current company is kept when editing).
  const companyOptions = personCompanies
    ? options.companies.filter((c) => personCompanies.includes(c.id) || (isEdit && c.id === task?.company?.id && personId === task?.assignee?.id))
    : options.companies;
  const people = assigneePeopleOptions(allPeople, task?.assignee, { taskCompanyId: task?.company?.id, companyId: task?.company?.id ?? "" });

  const pickAssignee = (value: string) => {
    setAssignee(value);
    if (!value.startsWith("person:")) return;
    const theirs = byPerson.get(value.slice(7)) ?? [];
    if (theirs.length === 1) setCompanyId(theirs[0]!);
    else if (companyId && !theirs.includes(companyId)) setCompanyId("");
    if (theirs.length === 1 || (companyId && !theirs.includes(companyId))) {
      setProjectId("");
      setDepartmentId("");
    }
  };

  useEffect(() => {
    if (state.ok) {
      toast(state.message ?? "Saved");
      if (!isEdit) {
        formRef.current?.reset();
        setAssignee(defaults?.assignee ?? "");
        setDraft([]);
        setDueDate("");
      }
      onDone?.();
    } else if (state.error) {
      toast(`Couldn't save: ${state.error}`, "risk");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.nonce, state.error]);

  const projects = options.projects.filter((p) => !companyId || p.companyId === companyId);
  const liveDepartments = companyId ? (options.departmentsByCompany?.[companyId] ?? []) : [];
  // The task's current department may be archived (not in the live list): keep it as an
  // option, or the controlled select would show "None" and saving would clear the link.
  const current = task?.orgDepartment && task.company?.id === companyId ? task.orgDepartment : null;
  const departments =
    current && !liveDepartments.some((d) => d.id === current.id)
      ? [...liveDepartments, { id: current.id, label: `${current.number} ${current.name} (archived)` }]
      : liveDepartments;
  const err = (f: string) => (state.ok ? undefined : state.fieldErrors?.[f]?.[0]);
  const fieldId = (f: string) => `${fid}-${f}`;
  const errId = (f: string) => (err(f) ? `${fid}-${f}-err` : undefined);
  const FieldError = ({ f }: { f: string }) =>
    err(f) ? (
      <p id={`${fid}-${f}-err`} className="mt-1 text-[12px] text-risk">
        {err(f)}
      </p>
    ) : null;

  const assigneeInfo: { kind: "person" | "user"; name: string } | null = personId
    ? { kind: "person", name: allPeople.find((p) => p.id === personId)?.name ?? task?.assignee?.name ?? "the person" }
    : assignee.startsWith("user:")
      ? { kind: "user", name: options.founders.find((f) => `user:${f.id}` === assignee)?.shortName ?? "?" }
      : null;
  const owner = task ? task.ownerName : (options.founders.find((f) => f.id === options.currentUserId)?.shortName ?? "you");
  const nudged = assigneeInfo?.kind === "user" ? assigneeInfo.name : owner;
  const showChase = !isEdit || chase !== undefined;

  /** Editing what the person sees on Telegram after they got it: ask first. */
  const needsConfirm = (fd: FormData) => {
    if (!isEdit || !task || !sentToPerson || task.assignee?.kind !== "person" || assignee !== initialAssignee) return false;
    const changed =
      String(fd.get("title") ?? "") !== task.title ||
      String(fd.get("dueDate") ?? "") !== (task.dueDate ?? "") ||
      String(fd.get("priority") ?? "") !== task.priority ||
      (chaseValue.shareNotes && String(fd.get("notes") ?? "") !== (task.notes ?? ""));
    return changed;
  };

  return (
    <>
      <form
        ref={formRef}
        action={action}
        onSubmit={(e) => {
          if (confirmedRef.current) {
            confirmedRef.current = false;
            return;
          }
          if (needsConfirm(new FormData(e.currentTarget))) {
            e.preventDefault();
            setConfirmOpen(true);
          }
        }}
        className="space-y-4"
        aria-label={isEdit ? "Edit task" : "New task"}
        noValidate={false}
      >
        {task && <input type="hidden" name="id" value={task.id} />}
        <div>
          <label className="label" htmlFor={fieldId("title")}>
            Title
          </label>
          <input
            id={fieldId("title")}
            name="title"
            required
            maxLength={300}
            defaultValue={task?.title}
            className="input"
            placeholder="What needs to happen?"
            autoFocus={!isEdit}
            aria-invalid={!!err("title")}
            aria-describedby={errId("title")}
          />
          <FieldError f="title" />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor={fieldId("assignee")}>
              Assignee
            </label>
            <select
              id={fieldId("assignee")}
              name="assignee"
              className="input"
              value={assignee}
              onChange={(e) => pickAssignee(e.target.value)}
              aria-invalid={!!err("assigneePersonId")}
              aria-describedby={errId("assigneePersonId")}
            >
              <option value="">Nobody</option>
              <optgroup label="Founders">
                {options.founders
                  .filter((f) => visibility === "shared" || f.id === options.currentUserId)
                  .map((f) => (
                    <option key={f.id} value={`user:${f.id}`}>
                      {f.shortName}
                      {f.id === options.currentUserId ? " (me)" : ""}
                    </option>
                  ))}
              </optgroup>
              {visibility === "shared" && people.length > 0 && (
                <optgroup label="Team">
                  {people.map((p) => (
                    <option key={p.id} value={`person:${p.id}`}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <FieldError f="assigneePersonId" />
          </div>
          <div>
            <label className="label" htmlFor={fieldId("companyId")}>
              Company
            </label>
            <select
              id={fieldId("companyId")}
              name="companyId"
              className="input"
              value={companyId}
              onChange={(e) => {
                setCompanyId(e.target.value);
                setProjectId("");
                setDepartmentId("");
              }}
              aria-invalid={!!err("companyId")}
              aria-describedby={errId("companyId") ?? (personCompanies ? `${fid}-company-hint` : undefined)}
            >
              <option value="">{visibility === "private" ? "None" : "Choose…"}</option>
              {companyOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {personCompanies && !err("companyId") && (
              <p id={`${fid}-company-hint`} className="mt-1 text-[12px] text-muted">
                {personCompanies.length === 0
                  ? `${assigneeInfo?.name} is not linked to any company`
                  : `Only ${assigneeInfo?.name}'s ${personCompanies.length === 1 ? "company" : `${personCompanies.length} companies`}`}
              </p>
            )}
            <FieldError f="companyId" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <label className="label" htmlFor={fieldId("dueDate")}>
              Due date
            </label>
            <DateInput id={fieldId("dueDate")} name="dueDate" aria-label="Due date" value={dueDate} onChange={setDueDate} />
            <FieldError f="dueDate" />
          </div>
          <div>
            <label className="label" htmlFor={fieldId("priority")}>
              Priority
            </label>
            <select id={fieldId("priority")} name="priority" className="input" defaultValue={task?.priority ?? "normal"}>
              {PRIORITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor={fieldId("visibility")}>
              Who sees it
            </label>
            <select
              id={fieldId("visibility")}
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
            {isEdit && task?.ownerUserId !== options.currentUserId && <input type="hidden" name="visibility" value={visibility} />}
            <FieldError f="visibility" />
          </div>
          <div>
            <label className="label" htmlFor={fieldId("status")}>
              Status
            </label>
            <select id={fieldId("status")} name="status" className="input" defaultValue={task?.status ?? "todo"}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor={fieldId("projectId")}>
              Project
            </label>
            <select id={fieldId("projectId")} name="projectId" className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">None</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <FieldError f="projectId" />
          </div>
          {departments.length > 0 && (
            <div>
              <label className="label" htmlFor={fieldId("dept")}>
                Department (org chart)
              </label>
              <select id={fieldId("dept")} name="orgDepartmentId" className="input" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                <option value="">None</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
              <FieldError f="orgDepartmentId" />
            </div>
          )}
        </div>

        <div>
          <label className="label" htmlFor={fieldId("notes")}>
            Notes
          </label>
          <textarea id={fieldId("notes")} name="notes" rows={2} maxLength={5000} className="input" defaultValue={task?.notes ?? ""} />
        </div>

        {!isEdit && (
          <fieldset>
            <legend className="label">Checklist</legend>
            <DraftChecklist items={draft} onChange={setDraft} />
          </fieldset>
        )}

        {showChase && visibility === "shared" && (
          <fieldset className="rounded-[12px] border border-line p-3">
            <legend className="px-1 text-[13px] font-semibold">Reminders</legend>
            <ChaseControl
              value={chaseValue}
              onChange={setChaseValue}
              assignee={assigneeInfo}
              nudgedFounder={nudged}
              person={personId ? options.personChase?.[personId] : null}
              dueDate={dueDate || null}
              errors={state.ok ? undefined : state.fieldErrors}
              showShareNotes
            />
          </fieldset>
        )}
        {showChase && visibility === "private" && <input type="hidden" name="chase" value="default" />}
        {showChase && visibility === "private" && <input type="hidden" name="founderNudge" value={chaseValue.founderNudge} />}

        {state.error && !state.fieldErrors && (
          <p role="alert" className="rounded-[8px] border border-risk-line bg-risk-soft px-3 py-2 text-[13px] text-risk">
            {state.error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
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
      <ConfirmDialog
        open={confirmOpen}
        title={`Update ${task?.assignee?.name ?? "the person"}'s message?`}
        confirmLabel="Save and update"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          confirmedRef.current = true;
          formRef.current?.requestSubmit();
        }}
      >
        <p>
          {task?.assignee?.name} already has this task on Telegram. {task?.assignee?.name} will get an updated message with the new
          details — continue?
        </p>
      </ConfirmDialog>
    </>
  );
}
