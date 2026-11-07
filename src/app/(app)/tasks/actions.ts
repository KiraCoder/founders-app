"use server";

import { revalidatePath } from "next/cache";
import { parseAssignee, type TaskCreateInput, type TaskUpdateInput } from "@/lib/schemas";
import { getPageContext } from "@/server/context";
import { dispatch } from "@/server/notifications/dispatcher";
import { toServiceError } from "@/server/services/errors";
import { chaseTaskNow, setTaskChase, setTaskChasePaused } from "@/server/services/task-activity";
import {
  addChecklistItem,
  parseChecklistField,
  removeChecklistItem,
  setChecklistItemDone,
  updateChecklistItem,
} from "@/server/services/task-checklist";
import { createTask, deleteTask, updateTaskDetailed } from "@/server/services/tasks";

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
  revalidatePath("/", "layout");
  return { ok: true, message: out.message, taskId: out.taskId, nonce: Date.now() };
}

const TASK_FORM_FIELDS = ["title", "notes", "companyId", "projectId", "orgDepartmentId", "visibility", "status", "priority", "dueDate"] as const;
const CHASE_FIELDS = ["chase", "everyN", "everyUnit", "escalation", "escalateDays", "founderNudge", "shareNotes"] as const;

function taskFields(fd: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of TASK_FORM_FIELDS) if (fd.has(key)) out[key] = fd.get(key);
  if (fd.has("assignee")) Object.assign(out, parseAssignee(fd.get("assignee")));
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

export async function toggleChecklistItemAction(itemId: string, done: boolean): Promise<TaskActionResult> {
  const ctx = await getPageContext();
  return run(async () => {
    await setChecklistItemDone(ctx, itemId, done);
    return { message: done ? "Ticked" : "Unticked" };
  });
}
