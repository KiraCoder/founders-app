"use server";

import { CACHE_TAGS, refreshAfterWrite } from "@/server/cache";
import { getPageContext } from "@/server/context";
import { toServiceError } from "@/server/services/errors";
import { createLabel, deleteLabel, setLabelArchived, updateLabel } from "@/server/services/task-labels";

/** Settings → Labels (0034): thin wrappers over services/task-labels.ts; results go to a toast. */
export interface LabelActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

async function run(fn: () => Promise<unknown>, message: string): Promise<LabelActionResult> {
  try {
    await fn();
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return { ok: false, error: se.message };
  }
  refreshAfterWrite(CACHE_TAGS.labels, CACHE_TAGS.tasks);
  return { ok: true, message };
}

export async function createLabelAction(name: string, color: string): Promise<LabelActionResult> {
  const ctx = await getPageContext();
  return run(() => createLabel(ctx, { name, color }), `Label “${name.trim()}” added`);
}

export async function updateLabelAction(id: string, patch: { name?: string; color?: string }): Promise<LabelActionResult> {
  const ctx = await getPageContext();
  return run(() => updateLabel(ctx, id, patch), "Label saved");
}

export async function archiveLabelAction(id: string, archived: boolean): Promise<LabelActionResult> {
  const ctx = await getPageContext();
  return run(() => setLabelArchived(ctx, id, archived), archived ? "Label archived" : "Label restored");
}

export async function deleteLabelAction(id: string): Promise<LabelActionResult> {
  const ctx = await getPageContext();
  return run(() => deleteLabel(ctx, id), "Label deleted");
}
