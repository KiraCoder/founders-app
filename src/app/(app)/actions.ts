"use server";

import { CACHE_TAGS, refreshAfterWrite } from "@/server/cache";
import { redirect } from "next/navigation";
import { parseAssignee, type TaskCreateInput, type TaskUpdateInput } from "@/lib/schemas";
import { signOut } from "@/server/auth";
import { getPageContext } from "@/server/context";
import { toServiceError } from "@/server/services/errors";
import { createProject } from "@/server/services/projects";
import { createTask, deleteTask, updateTask } from "@/server/services/tasks";

export interface ActionState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
  /** Changes on every success so forms can reset themselves. */
  nonce?: number;
}

async function run(fn: () => Promise<unknown>): Promise<ActionState> {
  try {
    await fn();
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return { ok: false, error: se.message, fieldErrors: se.fields };
  }
  // Tasks (and createProject, whose service drops `projects`).
  refreshAfterWrite(CACHE_TAGS.tasks);
  return { ok: true, nonce: Date.now() };
}

const TASK_FORM_FIELDS = ["title", "notes", "companyId", "projectId", "orgDepartmentId", "visibility", "status", "priority", "dueDate"] as const;

/** Reads task fields from a form. Missing fields are left out so PATCH semantics work. */
function taskFieldsFromForm(fd: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of TASK_FORM_FIELDS) {
    if (fd.has(key)) out[key] = fd.get(key);
  }
  if (fd.has("assignee")) Object.assign(out, parseAssignee(fd.get("assignee")));
  return out;
}

export async function createTaskAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await getPageContext();
  return run(() => createTask(ctx, taskFieldsFromForm(fd) as TaskCreateInput));
}

export async function updateTaskAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await getPageContext();
  const id = String(fd.get("id") ?? "");
  return run(() => updateTask(ctx, id, taskFieldsFromForm(fd)));
}

export async function setTaskStatusAction(id: string, status: string): Promise<ActionState> {
  const ctx = await getPageContext();
  return run(() => updateTask(ctx, id, { status: status as TaskUpdateInput["status"] }));
}

export async function setTaskDeadlineAction(id: string, dueDate: string | null): Promise<ActionState> {
  const ctx = await getPageContext();
  return run(() => updateTask(ctx, id, { dueDate }));
}

export async function deleteTaskAction(id: string): Promise<ActionState> {
  const ctx = await getPageContext();
  return run(() => deleteTask(ctx, id));
}

export async function createProjectAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await getPageContext();
  return run(() =>
    createProject(ctx, {
      companyId: String(fd.get("companyId") ?? ""),
      name: String(fd.get("name") ?? ""),
      description: fd.get("description") as string | null,
      dueDate: fd.get("dueDate") as string | null,
    }),
  );
}

export async function logoutAction(): Promise<void> {
  await signOut();
  redirect("/login");
}
