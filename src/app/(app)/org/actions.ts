"use server";

import { revalidatePath } from "next/cache";
import type { DepartmentPatch, DivisionPatch, FunctionPatch } from "@/lib/org";
import { getPageContext } from "@/server/context";
import { toServiceError } from "@/server/services/errors";
import {
  applyVysotskyTemplate,
  createDepartment,
  createFunction,
  moveDepartment,
  moveFunction,
  setArchived,
  undoLastChange,
  updateDepartment,
  updateDivision,
  updateFunction,
} from "@/server/services/org";

export interface OrgActionState {
  ok: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
  message?: string;
  /** Id of a created row (function / department). */
  id?: string;
}

/** Every org change goes through the service (access, company isolation, change log). */
async function run(fn: () => Promise<{ message?: string; id?: string } | void>): Promise<OrgActionState> {
  try {
    const res = await fn();
    revalidatePath("/org");
    revalidatePath("/companies/[slug]", "page");
    return { ok: true, message: res?.message, id: res?.id };
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return { ok: false, error: se.message, fieldErrors: se.fields };
  }
}

export async function applyTemplateAction(companyId: string, companyUnitId: string | null): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    await applyVysotskyTemplate(ctx, { companyId, companyUnitId });
    return { message: "Vysotsky template applied — rename and fill in the departments." };
  });
}

export async function updateDivisionAction(id: string, patch: DivisionPatch): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(() => updateDivision(ctx, id, patch));
}

export async function updateDepartmentAction(id: string, patch: DepartmentPatch): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(() => updateDepartment(ctx, id, patch));
}

export async function updateFunctionAction(id: string, patch: FunctionPatch): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(() => updateFunction(ctx, id, patch));
}

export async function createFunctionAction(departmentId: string, text: string): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(async () => ({ id: await createFunction(ctx, { departmentId, text }) }));
}

export async function createDepartmentAction(divisionId: string, name: string): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(async () => ({ id: await createDepartment(ctx, { divisionId, name }) }));
}

export async function moveFunctionAction(functionId: string, departmentId: string, index: number): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(() => moveFunction(ctx, { functionId, departmentId, index }));
}

export async function moveDepartmentAction(departmentId: string, divisionId: string, index: number): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(() => moveDepartment(ctx, { departmentId, divisionId, index }));
}

export async function setArchivedAction(entity: "department" | "function", id: string, archived: boolean): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    if (entity !== "department" && entity !== "function") throw new Error("bad entity");
    await setArchived(ctx, entity, id, archived);
    return { message: archived ? "Archived — “Show archived” brings it back." : "Restored." };
  });
}

export async function undoAction(chartId: string): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    const what = await undoLastChange(ctx, chartId);
    return { message: what ? `Undone: ${what}` : "Nothing to undo." };
  });
}
