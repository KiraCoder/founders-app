"use server";

import { revalidatePath } from "next/cache";
import type {
  DepartmentPatch,
  DivisionPatch,
  FunctionPatch,
  JourneyStepCreateInput,
  JourneyStepPatch,
  JourneyTemplateKey,
  OrgNewPersonInput,
  PostCreateInput,
  PostPatch,
} from "@/lib/org";
import { getPageContext } from "@/server/context";
import { toServiceError } from "@/server/services/errors";
import {
  applyVysotskyTemplate,
  createDepartment,
  createFunction,
  createPersonAndAssign,
  createPost,
  moveDepartment,
  moveFunction,
  setArchived,
  setPostArchived,
  undoLastChange,
  updateDepartment,
  updateDivision,
  updateFunction,
  updatePost,
  type OrgWriteOpts,
} from "@/server/services/org";
import { applyJourneyTemplate, createJourneyStep, moveJourneyStep, setJourneyStepArchived, updateJourneyStep } from "@/server/services/org-journey";

export interface OrgActionState {
  ok: boolean;
  error?: string;
  /** The chart changed meanwhile (optimistic concurrency): the board refreshes. */
  conflict?: boolean;
  fieldErrors?: Record<string, string[]>;
  message?: string;
  /** Id of a created row (function / department / person). */
  id?: string;
  /** The chart's version after this change (the board sends it with its next change). */
  version?: string;
}

/**
 * Every org change goes through the service (access, company isolation, change log). The
 * board sends the chart `version` it shows; a change made meanwhile is refused (`conflict`).
 */
async function run(version: string | null | undefined, fn: (opts: OrgWriteOpts) => Promise<{ message?: string; id?: string } | void>): Promise<OrgActionState> {
  const opts: OrgWriteOpts = { expectedVersion: typeof version === "string" ? version : null, result: {} };
  try {
    const res = await fn(opts);
    revalidatePath("/org");
    revalidatePath("/companies/[slug]", "page");
    revalidatePath("/people", "layout");
    return { ok: true, message: res?.message, id: res?.id, version: opts.result?.version };
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return { ok: false, error: se.message, fieldErrors: se.fields, conflict: se.code === "conflict" };
  }
}

export async function applyTemplateAction(companyId: string, companyUnitId: string | null): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(null, async () => {
    await applyVysotskyTemplate(ctx, { companyId, companyUnitId });
    return { message: "Vysotsky template applied — rename and fill in the departments." };
  });
}

export async function updateDivisionAction(id: string, patch: DivisionPatch, version?: string): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(version, (o) => updateDivision(ctx, id, patch, o));
}

export async function updateDepartmentAction(id: string, patch: DepartmentPatch, version?: string): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(version, (o) => updateDepartment(ctx, id, patch, o));
}

export async function updateFunctionAction(id: string, patch: FunctionPatch, version?: string): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(version, (o) => updateFunction(ctx, id, patch, o));
}

export async function createFunctionAction(departmentId: string, text: string, version?: string): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(version, async (o) => ({ id: await createFunction(ctx, { departmentId, text }, o) }));
}

export async function createDepartmentAction(divisionId: string, name: string, version?: string): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(version, async (o) => ({ id: await createDepartment(ctx, { divisionId, name }, o) }));
}

export async function moveFunctionAction(functionId: string, departmentId: string, index: number, version?: string): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(version, (o) => moveFunction(ctx, { functionId, departmentId, index }, o));
}

export async function moveDepartmentAction(departmentId: string, divisionId: string, index: number, version?: string): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(version, (o) => moveDepartment(ctx, { departmentId, divisionId, index }, o));
}

export async function setArchivedAction(entity: "department" | "function", id: string, archived: boolean, version?: string): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(version, async (o) => {
    if (entity !== "department" && entity !== "function") throw new Error("bad entity");
    await setArchived(ctx, entity, id, archived, o);
    return { message: archived ? "Archived — “Show archived” brings it back." : "Restored." };
  });
}

/** "+ New person" on the board: create, link to the company and assign in one step (founders only). */
export async function createPersonAndAssignAction(input: OrgNewPersonInput, version?: string): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(version, async (o) => {
    const { personId } = await createPersonAndAssign(ctx, input, o);
    return { id: personId, message: `${input.fullName} added to People and assigned. Undo takes back the assignment (the person stays).` };
  });
}

export async function undoAction(chartId: string, version?: string): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(version, async (o) => {
    const what = await undoLastChange(ctx, chartId, o);
    return { message: what ? `Undone: ${what}` : "Nothing to undo." };
  });
}

// ---------------------------------------------------------------------------
// Posts (chips on a department card) and the journey strip — founders only, logged, undoable
// ---------------------------------------------------------------------------

export async function createPostAction(input: PostCreateInput, version?: string): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(version, async (o) => ({ id: await createPost(ctx, input, o) }));
}

export async function updatePostAction(id: string, patch: PostPatch, version?: string): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(version, (o) => updatePost(ctx, id, patch, o));
}

export async function removePostAction(id: string, version?: string): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(version, async (o) => {
    await setPostArchived(ctx, id, true, o);
    return { message: "Post removed — Undo brings it back." };
  });
}

export async function createJourneyStepAction(chartId: string, input: JourneyStepCreateInput, version?: string): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(version, async (o) => ({ id: await createJourneyStep(ctx, chartId, input, o) }));
}

export async function updateJourneyStepAction(chartId: string, stepId: string, patch: JourneyStepPatch, version?: string): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(version, (o) => updateJourneyStep(ctx, chartId, stepId, patch, o));
}

export async function moveJourneyStepAction(chartId: string, stepId: string, index: number, version?: string): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(version, (o) => moveJourneyStep(ctx, chartId, { stepId, index }, o));
}

export async function removeJourneyStepAction(chartId: string, stepId: string, version?: string): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(version, async (o) => {
    await setJourneyStepArchived(ctx, chartId, stepId, true, o);
    return { message: "Step removed — Undo brings it back." };
  });
}

export async function applyJourneyTemplateAction(chartId: string, key: JourneyTemplateKey, version?: string): Promise<OrgActionState> {
  const ctx = await getPageContext();
  return run(version, async (o) => {
    const ids = await applyJourneyTemplate(ctx, chartId, key, o);
    return { message: `${ids.length} steps added — link each to its department.` };
  });
}
