"use server";

import { CACHE_TAGS, refreshAfterWrite } from "@/server/cache";
import { parseAssignee, type TaskCreateInput, type TaskUpdateInput } from "@/lib/schemas";
import { getPageContext } from "@/server/context";
import { dispatch } from "@/server/notifications/dispatcher";
import { toServiceError } from "@/server/services/errors";
import { chaseTaskNow, setTaskChase, setTaskChasePaused } from "@/server/services/task-activity";
import {
  addChecklistItem,
  listChecklist,
  moveChecklistItem,
  parseChecklistField,
  promoteChecklistItem,
  removeChecklistItem,
  setChecklistItemDone,
  updateChecklistItem,
} from "@/server/services/task-checklist";
import { bulkUpdateTasks, createTask, deleteTask, updateTaskDetailed } from "@/server/services/tasks";
import { ServiceError } from "@/server/services/errors";
import { createLabel } from "@/server/services/task-labels";
import type { ChecklistItemData } from "@/components/tasks/TaskChecklist";

/**
 * Tasks (0032): the dialog's save, the list's one-tap actions, the checklist and the chase
 * control. Thin wrappers over the service layer; every result carries a message for the toast.
 */
export interface TaskActionResult {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
  message?: string;
  nonce?: number;
  /** The saved task (a new task's id, for "Open"). */
  taskId?: string;
}

async function run(fn: () => Promise<{ message: string; taskId?: string }>): Promise<TaskActionResult> {
  let out: { message: string; taskId?: string };
  try {
    out = await fn();
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return { ok: false, error: se.message, fieldErrors: se.fields };
  }
  refreshAfterWrite(CACHE_TAGS.tasks);
  return { ok: true, message: out.message, taskId: out.taskId, nonce: Date.now() };
}

const TASK_FORM_FIELDS = ["title", "notes", "companyId", "projectId", "orgDepartmentId", "visibility", "status", "priority", "dueDate", "estimate", "needsReview"] as const;
const CHASE_FIELDS = ["chase", "everyN", "everyUnit", "escalation", "escalateDays", "founderNudge", "shareNotes"] as const;

function taskFields(fd: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of TASK_FORM_FIELDS) if (fd.has(key)) out[key] = fd.get(key);
  if (fd.has("assignee")) Object.assign(out, parseAssignee(fd.get("assignee")));
  // The label picker posts one labelIds per label, plus labelsField so "none" is told from "not shown".
  if (fd.has("labelsField")) out.labelIds = fd.getAll("labelIds").map(String).filter(Boolean);
  return out;
}

function chaseFields(fd: FormData): Record<string, string> | null {
  if (!fd.has("chase")) return null;
  const out: Record<string, string> = {};
  for (const k of CHASE_FIELDS) if (fd.has(k)) out[k] = String(fd.get(k));
  // An unticked checkbox posts nothing: "shareNotes" off.
  if (!fd.has("shareNotes")) out.shareNotes = "";
  return out;
}

async function sendNow(db: Parameters<typeof dispatch>[0]) {
  // Like Routines → Run now: send right away instead of waiting for the next tick. Failures stay
  // queued and the next tick retries them, so the action itself still succeeds.
  await dispatch(db, new Date(), { limit: 25 }).catch((err: unknown) => console.error("[tasks] immediate send failed", err));
}

/** The create / edit dialog. A new task's checklist and chase choice are saved with it. */
export async function saveTaskAction(_prev: TaskActionResult, fd: FormData): Promise<TaskActionResult> {
  const ctx = await getPageContext();
  const id = String(fd.get("id") ?? "");
  return run(async () => {
    const chase = chaseFields(fd);
    if (!id) {
      const items = parseChecklistField(fd.get("checklist"));
      const task = await createTask(ctx, taskFields(fd) as TaskCreateInput);
      for (const item of items) await addChecklistItem(ctx, task.id, item, { notify: false });
      if (chase && task.visibility === "shared") await setTaskChase(ctx, task.id, chase);
      else if (chase) await setTaskChase(ctx, task.id, { founderNudge: chase.founderNudge });
      const to = task.assignee?.kind === "person" ? ` · ${task.assignee.name} gets it on Telegram with the next tick` : "";
      return { message: `Task created${to}`, taskId: task.id };
    }
    const { task, staffNotice } = await updateTaskDetailed(ctx, id, taskFields(fd) as TaskUpdateInput);
    if (chase) await setTaskChase(ctx, task.id, chase);
    return {
      message: staffNotice.notified ? `Saved · ${staffNotice.personName} gets an updated message` : "Saved",
      taskId: task.id,
    };
  });
}

export async function setStatusAction(id: string, status: string): Promise<TaskActionResult> {
  const ctx = await getPageContext();
  const label: Record<string, string> = { done: "Marked done", cancelled: "Archived (cancelled)", todo: "Reopened" };
  return run(async () => {
    await updateTaskDetailed(ctx, id, { status: status as TaskUpdateInput["status"] });
    return { message: label[status] ?? "Status changed" };
  });
}

export async function chaseNowAction(id: string): Promise<TaskActionResult> {
  const ctx = await getPageContext();
  return run(async () => {
    const r = await chaseTaskNow(ctx, id);
    await sendNow(ctx.db);
    return { message: `Reminder sent to ${r.personName}` };
  });
}

export async function pauseChasingAction(id: string, paused: boolean): Promise<TaskActionResult> {
  const ctx = await getPageContext();
  return run(async () => {
    await setTaskChasePaused(ctx, id, paused);
    return { message: paused ? "Chasing paused" : "Chasing resumed" };
  });
}

export async function deleteTaskForGoodAction(id: string): Promise<TaskActionResult> {
  const ctx = await getPageContext();
  return run(async () => {
    await deleteTask(ctx, id);
    return { message: "Task deleted" };
  });
}

export async function saveChaseAction(_prev: TaskActionResult, fd: FormData): Promise<TaskActionResult> {
  const ctx = await getPageContext();
  return run(async () => {
    await setTaskChase(ctx, String(fd.get("taskId") ?? ""), chaseFields(fd) ?? {});
    return { message: "Chase settings saved" };
  });
}

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

const updatedLine = (n: { notified: boolean; personName: string | null }, base: string) =>
  n.notified ? `${base} · ${n.personName} gets an updated message` : base;

export async function addChecklistItemAction(_prev: TaskActionResult, fd: FormData): Promise<TaskActionResult> {
  const ctx = await getPageContext();
  return run(async () => {
    const r = await addChecklistItem(ctx, String(fd.get("taskId") ?? ""), { title: String(fd.get("title") ?? ""), details: String(fd.get("details") ?? "") });
    return { message: updatedLine(r, "Item added") };
  });
}

export async function updateChecklistItemAction(_prev: TaskActionResult, fd: FormData): Promise<TaskActionResult> {
  const ctx = await getPageContext();
  return run(async () => {
    const r = await updateChecklistItem(ctx, String(fd.get("itemId") ?? ""), { title: String(fd.get("title") ?? ""), details: String(fd.get("details") ?? "") });
    return { message: updatedLine(r, "Item saved") };
  });
}

export async function removeChecklistItemAction(itemId: string): Promise<TaskActionResult> {
  const ctx = await getPageContext();
  return run(async () => {
    const r = await removeChecklistItem(ctx, itemId);
    return { message: updatedLine(r, "Item removed") };
  });
}

export async function moveChecklistItemAction(itemId: string, direction: "up" | "down"): Promise<TaskActionResult> {
  const ctx = await getPageContext();
  return run(async () => {
    const r = await moveChecklistItem(ctx, itemId, direction);
    return { message: updatedLine(r, direction === "up" ? "Moved up" : "Moved down") };
  });
}

/** The edit dialog's checklist (the list rows only carry counts). Read-only, so no revalidation. */
export async function loadChecklistAction(taskId: string): Promise<{ items: ChecklistItemData[]; error?: string }> {
  const ctx = await getPageContext();
  try {
    const items = await listChecklist(ctx, taskId);
    return { items: items.map((i) => ({ ...i, doneAt: i.doneAt?.toISOString() ?? null })) };
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return { items: [], error: se.message };
  }
}

export async function toggleChecklistItemAction(itemId: string, done: boolean): Promise<TaskActionResult> {
  const ctx = await getPageContext();
  return run(async () => {
    await setChecklistItemDone(ctx, itemId, done);
    return { message: done ? "Ticked" : "Unticked" };
  });
}

// ---------------------------------------------------------------------------
// Inline changes (the Linear-style list and the task page's properties, 0034)
// ---------------------------------------------------------------------------

/** One property change from a row or the task page. `assignee` is "user:<id>", "person:<id>" or "". */
export interface TaskPatchInput {
  title?: string;
  notes?: string | null;
  status?: string;
  priority?: string;
  estimate?: number | null;
  dueDate?: string | null;
  assignee?: string;
  companyId?: string | null;
  projectId?: string | null;
  labelIds?: string[];
  needsReview?: boolean;
}

function toUpdate(p: TaskPatchInput): TaskUpdateInput {
  const out: Record<string, unknown> = {};
  for (const k of ["title", "notes", "status", "priority", "estimate", "dueDate", "companyId", "projectId", "labelIds", "needsReview"] as const) {
    if (p[k] !== undefined) out[k] = p[k];
  }
  if (p.assignee !== undefined) Object.assign(out, parseAssignee(p.assignee));
  return out as TaskUpdateInput;
}

const STATUS_WORD: Record<string, string> = { backlog: "Backlog", todo: "Todo", in_progress: "In Progress", in_review: "In Review", done: "Done", cancelled: "Canceled" };

function patchMessage(p: TaskPatchInput): string {
  if (p.status) return `Status: ${STATUS_WORD[p.status] ?? p.status}`;
  if (p.priority) return "Priority changed";
  if (p.estimate !== undefined) return p.estimate ? `Estimate: ${p.estimate} points` : "Estimate cleared";
  if (p.dueDate !== undefined) return p.dueDate ? `Due ${p.dueDate}` : "Due date cleared";
  if (p.assignee !== undefined) return p.assignee ? "Assignee changed" : "Unassigned";
  if (p.labelIds) return "Labels changed";
  if (p.companyId !== undefined) return "Company changed";
  if (p.projectId !== undefined) return "Project changed";
  if (p.title !== undefined) return "Title saved";
  if (p.notes !== undefined) return "Description saved";
  if (p.needsReview !== undefined) return p.needsReview ? "Needs review: on" : "Needs review: off";
  return "Saved";
}

export async function updateTaskFieldsAction(id: string, patch: TaskPatchInput): Promise<TaskActionResult> {
  const ctx = await getPageContext();
  return run(async () => {
    const { task, staffNotice } = await updateTaskDetailed(ctx, id, toUpdate(patch));
    const base = patchMessage(patch);
    return { message: staffNotice.notified ? `${base} · ${staffNotice.personName} gets an updated message` : base, taskId: task.id };
  });
}

/** The bulk bar: the same change for the selected tasks (labels are added / removed, not replaced). */
export async function bulkUpdateTasksAction(
  ids: string[],
  patch: TaskPatchInput,
  labels: { add?: string[]; remove?: string[] } = {},
): Promise<TaskActionResult> {
  const ctx = await getPageContext();
  return run(async () => {
    const r = await bulkUpdateTasks(ctx, ids, toUpdate(patch), labels);
    if (!r.updated && r.failed.length) throw new ServiceError("validation", r.failed[0]!.error);
    const failed = r.failed.length ? ` · ${r.failed.length} not changed: ${r.failed[0]!.error}` : "";
    return { message: `${r.updated} task${r.updated === 1 ? "" : "s"} updated${failed}` };
  });
}

export async function bulkDeleteTasksAction(ids: string[]): Promise<TaskActionResult> {
  const ctx = await getPageContext();
  return run(async () => {
    let n = 0;
    for (const id of new Set(ids)) {
      await deleteTask(ctx, id);
      n++;
    }
    return { message: `${n} task${n === 1 ? "" : "s"} deleted` };
  });
}

/** "+" in a group header: a task with just a title, in that group (status / priority / assignee / company / project). */
export async function quickCreateTaskAction(input: {
  title: string;
  status?: string;
  priority?: string;
  assignee?: string;
  companyId?: string | null;
  projectId?: string | null;
  labelIds?: string[];
}): Promise<TaskActionResult> {
  const ctx = await getPageContext();
  return run(async () => {
    const who = parseAssignee(input.assignee ?? "");
    const shared = !!(input.companyId || input.projectId || who.assigneePersonId || (who.assigneeUserId && who.assigneeUserId !== ctx.user.id));
    const task = await createTask(ctx, {
      title: input.title,
      status: (input.status ?? "todo") as TaskCreateInput["status"],
      priority: (input.priority ?? "none") as TaskCreateInput["priority"],
      visibility: shared ? "shared" : "private",
      companyId: input.companyId ?? null,
      projectId: input.projectId ?? null,
      labelIds: input.labelIds,
      ...who,
    });
    return { message: `${task.key} created${task.visibility === "private" ? " (personal)" : ""}`, taskId: task.id };
  });
}

/** A label created from a task's label picker. */
export async function createLabelInlineAction(name: string): Promise<{ ok: boolean; error?: string; label?: { id: string; name: string; color: string } }> {
  const ctx = await getPageContext();
  try {
    const l = await createLabel(ctx, { name });
    refreshAfterWrite(CACHE_TAGS.tasks, CACHE_TAGS.labels);
    return { ok: true, label: { id: l.id, name: l.name, color: l.color } };
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return { ok: false, error: se.message };
  }
}

/** Sub-task → a full task (the checklist item becomes its own task, linked to this one). */
export async function promoteChecklistItemAction(itemId: string): Promise<TaskActionResult> {
  const ctx = await getPageContext();
  return run(async () => {
    const task = await promoteChecklistItem(ctx, itemId);
    return { message: `${task.key} created from the sub-task`, taskId: task.id };
  });
}
