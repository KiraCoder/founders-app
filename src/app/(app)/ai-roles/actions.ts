"use server";

import { revalidatePath } from "next/cache";
import type { HireCreateInput, HirePatchInput } from "@/lib/ai-roles";
import { getPageContext } from "@/server/context";
import type { CustomRoleCreateInput } from "@/lib/ai-role-config";
import { createCustomRole, resetHire, resetRoleToDefaults, revertHire, revertRole, updateRoleConfig } from "@/server/services/ai-role-editor";
import { createTaskFromFinding, enterMonthTotalForRun, hireRole, rerunReport, runHireNow, updateHire } from "@/server/services/ai-roles";
import { toServiceError } from "@/server/services/errors";

export interface AiActionState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
  message?: string;
  /** Where to go next (e.g. the report). */
  href?: string;
  nonce?: number;
}

async function run(fn: () => Promise<{ message?: string; href?: string } | void>): Promise<AiActionState> {
  try {
    const res = await fn();
    revalidatePath("/ai-roles");
    revalidatePath("/companies/[slug]", "page");
    return { ok: true, message: res?.message, href: res?.href, nonce: Date.now() };
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return { ok: false, error: se.message, fieldErrors: se.fields };
  }
}

export async function hireAction(input: HireCreateInput): Promise<AiActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    const hire = await hireRole(ctx, input);
    return { message: `${hire.roleName} hired for ${hire.companyName}. ${hire.scheduleLabel}.` };
  });
}

export async function tuneAction(id: string, input: HirePatchInput): Promise<AiActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    const hire = await updateHire(ctx, id, input);
    return { message: input.status ? (hire.status === "paused" ? "Paused." : "Resumed.") : "Saved." };
  });
}

export async function runNowAction(id: string): Promise<AiActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    const r = await runHireNow(ctx, id);
    return {
      href: `/ai-roles/runs/${r.id}`,
      message: r.status === "waiting_for_data" ? `${r.periodLabel}: waiting for ${r.missing.length} number(s).` : `${r.periodLabel}: ${r.summary}.`,
    };
  });
}

export async function rerunAction(runId: string): Promise<AiActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    const r = await rerunReport(ctx, runId);
    revalidatePath(`/ai-roles/runs/${runId}`);
    return { message: r.status === "waiting_for_data" ? "Still waiting for numbers." : "Checked again." };
  });
}

export async function createTaskFromFindingAction(runId: string, findingId: string): Promise<AiActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    const r = await createTaskFromFinding(ctx, runId, findingId);
    revalidatePath(`/ai-roles/runs/${runId}`);
    return { message: r.created ? "Task created." : "A task already exists.", href: `/tasks?view=company` };
  });
}

/** The report's missing list: the month total of a daily number, then the numbers are checked again. */
export async function monthTotalAction(runId: string, metricId: string, value: string): Promise<AiActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    const r = await enterMonthTotalForRun(ctx, runId, metricId, value);
    revalidatePath(`/ai-roles/runs/${runId}`);
    return { message: r.status === "waiting_for_data" ? "Saved. Still waiting for other numbers." : "Saved and checked again." };
  });
}

// ---------------------------------------------------------------------------
// AI role editor (role level, per hire, custom roles, versions)
// ---------------------------------------------------------------------------

/** Saves a role's settings (template level, or a custom role's definition) as a new version. */
export async function saveRoleAction(key: string, config: unknown): Promise<AiActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    const role = await updateRoleConfig(ctx, key, config);
    return { message: `Saved — version ${role.version}.` };
  });
}

/** A hire's own settings (overrides) and notes, as a new version. */
export async function saveHireSettingsAction(hireId: string, input: HirePatchInput): Promise<AiActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    await updateHire(ctx, hireId, input);
    return { message: "Saved." };
  });
}

export async function createCustomRoleAction(input: CustomRoleCreateInput): Promise<AiActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    const role = await createCustomRole(ctx, input);
    return { message: `${role.name} created. Hire it to start.` };
  });
}

export async function revertRoleAction(key: string, version: number): Promise<AiActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    const role = await revertRole(ctx, key, version);
    return { message: `Back to version ${version} (saved as version ${role.version}).` };
  });
}

export async function revertHireAction(hireId: string, version: number): Promise<AiActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    await revertHire(ctx, hireId, version);
    return { message: `Back to version ${version}.` };
  });
}

/** "Reset to defaults" (role: the code's defaults / a custom role's first version; hire: the role's defaults). */
export async function resetRoleAction(key: string): Promise<AiActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    const role = await resetRoleToDefaults(ctx, key);
    return { message: `Back to the defaults (saved as version ${role.version}).` };
  });
}

export async function resetHireAction(hireId: string): Promise<AiActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    await resetHire(ctx, hireId);
    return { message: "Back to the role's defaults." };
  });
}
