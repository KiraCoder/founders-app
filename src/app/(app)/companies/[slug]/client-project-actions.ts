"use server";

import { revalidatePath } from "next/cache";
import { getPageContext } from "@/server/context";
import { createClientProject, setClientProjectArchived, updateClientProject } from "@/server/services/client-projects";
import { toServiceError } from "@/server/services/errors";

export interface ClientProjectActionState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
  nonce?: number;
}

const FIELDS = [
  "clientName",
  "title",
  "stage",
  "status",
  "startDate",
  "dueDate",
  "slaMonthlyFee",
  "slaCurrency",
  "slaResponseHours",
  "nextInvoiceDate",
  "notes",
] as const;

const str = (fd: FormData, key: string) => {
  const v = fd.get(key);
  return typeof v === "string" ? v : undefined;
};

function readFields(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of FIELDS) {
    const v = str(fd, k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

async function run(fn: () => Promise<unknown>): Promise<ClientProjectActionState> {
  try {
    await fn();
    revalidatePath("/companies/[slug]", "page");
    return { ok: true, nonce: Date.now() };
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return { ok: false, error: se.message, fieldErrors: se.fields, nonce: Date.now() };
  }
}

/** "New client project" (create) or "Save" (edit, when the form carries an id). */
export async function saveClientProjectAction(_prev: ClientProjectActionState, fd: FormData): Promise<ClientProjectActionState> {
  const ctx = await getPageContext();
  const companyId = str(fd, "companyId") ?? "";
  const id = str(fd, "id");
  return run(() => (id ? updateClientProject(ctx, companyId, id, readFields(fd)) : createClientProject(ctx, companyId, readFields(fd))));
}

/** Archive / restore (never a hard delete). */
export async function archiveClientProjectAction(companyId: string, id: string, archived: boolean): Promise<ClientProjectActionState> {
  const ctx = await getPageContext();
  return run(() => setClientProjectArchived(ctx, companyId, id, archived));
}
