"use server";

import { revalidatePath } from "next/cache";
import type { ActPatchInput, ContractCreateInput, ContractUpdateInput, FlowCreateInput, FlowUpdateInput, LedgerEntryInput } from "@/lib/holding-schemas";
import { askedSchema, askOverrideSchema } from "@/lib/holding-schemas";
import { getPageContext } from "@/server/context";
import { toServiceError } from "@/server/services/errors";
import {
  addLedgerEntry,
  archiveContract,
  archiveFlow,
  archiveLedgerEntry,
  createContract,
  createFlow,
  patchAct,
  restoreFlow,
  setAskOverride,
  updateContract,
  updateFlow,
} from "@/server/services/holding";
import { markAskedInApp } from "@/server/services/holding-asks";

export interface HoldingActionState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
  message?: string;
  nonce?: number;
}

async function run(fn: () => Promise<string | void>): Promise<HoldingActionState> {
  try {
    const message = await fn();
    revalidatePath("/holding");
    return { ok: true, message: message || undefined, nonce: Date.now() };
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return { ok: false, error: se.message, fieldErrors: se.fields };
  }
}

/** Save one cell of the акты grid (status, amount, act number/date, note, attachment). */
export async function saveActAction(input: ActPatchInput): Promise<HoldingActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    await patchAct(ctx, input);
    return "Saved.";
  });
}

/** The in-app "I asked …" / "I asked again" button. Nothing is sent to the person asked. */
export async function askedAction(input: { cells: { flowId: string; period: string }[]; again?: boolean }): Promise<HoldingActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    const data = askedSchema.parse({ cells: input.cells });
    const n = await markAskedInApp(ctx, data.cells, input.again ? "again" : "missing");
    return n === 0 ? "Nothing to change — already marked." : `Marked ${n === 1 ? "1 акт" : `${n} акты`} as asked today.`;
  });
}

/** "Who to ask" for one flow, this ask round only (null = back to the flow's person). */
export async function setAskOverrideAction(input: { flowId: string; personId: string | null }): Promise<HoldingActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    const data = askOverrideSchema.parse(input);
    await setAskOverride(ctx, data.flowId, data.personId);
    return data.personId ? "Changed for this month's asks." : "Back to the flow's person.";
  });
}

export async function createFlowAction(input: FlowCreateInput): Promise<HoldingActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    await createFlow(ctx, input);
  });
}

export async function updateFlowAction(id: string, input: FlowUpdateInput): Promise<HoldingActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    await updateFlow(ctx, id, input);
  });
}

export async function archiveFlowAction(id: string, restore = false): Promise<HoldingActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    if (restore) await restoreFlow(ctx, id);
    else await archiveFlow(ctx, id);
  });
}

export async function saveContractAction(id: string | null, input: ContractCreateInput | ContractUpdateInput): Promise<HoldingActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    if (id) await updateContract(ctx, id, input as ContractUpdateInput);
    else await createContract(ctx, input as ContractCreateInput);
  });
}

export async function archiveContractAction(id: string): Promise<HoldingActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    await archiveContract(ctx, id);
  });
}

export async function addLedgerEntryAction(input: LedgerEntryInput): Promise<HoldingActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    await addLedgerEntry(ctx, input);
  });
}

export async function archiveLedgerEntryAction(id: string): Promise<HoldingActionState> {
  const ctx = await getPageContext();
  return run(async () => {
    await archiveLedgerEntry(ctx, id);
  });
}
