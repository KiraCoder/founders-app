"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { LinkCreateInput, PersonCreateInput } from "@/lib/people-schemas";
import { getPageContext } from "@/server/context";
import { ImportFileError, MAX_IMPORT_BYTES, parseTableFile, type ParsedTable } from "@/server/import/parse-table";
import { toServiceError } from "@/server/services/errors";
import {
  applyImport,
  describeImportFile,
  importMappingSchema,
  planImport,
  type ImportMapping,
  type ImportPlan,
} from "@/server/services/people-import";
import {
  addPersonLink,
  addPersonSalary,
  createPerson,
  updatePerson,
  updatePersonLink,
} from "@/server/services/people";
import { setSalaryViewer } from "@/server/services/salaries";

export interface PeopleActionState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
  nonce?: number;
}

async function run(fn: () => Promise<unknown>): Promise<PeopleActionState> {
  try {
    await fn();
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return { ok: false, error: se.message, fieldErrors: se.fields };
  }
  revalidatePath("/", "layout");
  return { ok: true, nonce: Date.now() };
}

const str = (fd: FormData, key: string) => {
  const v = fd.get(key);
  return typeof v === "string" ? v : undefined;
};

function linkFromForm(fd: FormData, prefix = ""): LinkCreateInput | null {
  const companyId = str(fd, `${prefix}companyId`);
  if (!companyId) return null;
  const amount = str(fd, `${prefix}salaryAmount`);
  return {
    companyId,
    unitId: str(fd, `${prefix}unitId`) ?? null,
    role: str(fd, `${prefix}role`) ?? "",
    title: str(fd, `${prefix}title`) ?? null,
    employmentType: (str(fd, `${prefix}employmentType`) ?? null) as LinkCreateInput["employmentType"],
    startedOn: str(fd, `${prefix}startedOn`) ?? null,
    ...(amount && amount.trim() !== ""
      ? {
          salary: {
            amount,
            currency: str(fd, `${prefix}salaryCurrency`) ?? "KGS",
            payType: (str(fd, `${prefix}salaryPayType`) ?? null) as never,
            effectiveFrom: str(fd, `${prefix}salaryFrom`) ?? null,
          },
        }
      : {}),
  };
}

const PERSON_FIELDS = ["fullName", "shortName", "phone", "telegramHandle", "email", "notes"] as const;

function personFieldsFromForm(fd: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PERSON_FIELDS) if (fd.has(k)) out[k] = fd.get(k);
  return out;
}

export async function createPersonAction(_prev: PeopleActionState, fd: FormData): Promise<PeopleActionState> {
  const ctx = await getPageContext();
  const link = linkFromForm(fd);
  let id = "";
  const state = await run(async () => {
    const p = await createPerson(ctx, { ...personFieldsFromForm(fd), links: link ? [link] : [] } as PersonCreateInput);
    id = p.id;
  });
  if (state.ok) redirect(`/people/${id}`);
  return state;
}

export async function updatePersonAction(_prev: PeopleActionState, fd: FormData): Promise<PeopleActionState> {
  const ctx = await getPageContext();
  return run(() => updatePerson(ctx, str(fd, "id") ?? "", personFieldsFromForm(fd)));
}

export async function setPersonStatusAction(id: string, status: "active" | "left"): Promise<PeopleActionState> {
  const ctx = await getPageContext();
  return run(() => updatePerson(ctx, id, { status }));
}

export async function addLinkAction(_prev: PeopleActionState, fd: FormData): Promise<PeopleActionState> {
  const ctx = await getPageContext();
  const link = linkFromForm(fd);
  if (!link) return { ok: false, error: "Choose a company", fieldErrors: { companyId: ["Choose a company"] } };
  return run(() => addPersonLink(ctx, str(fd, "personId") ?? "", link));
}

export async function setLinkActiveAction(linkId: string, isActive: boolean): Promise<PeopleActionState> {
  const ctx = await getPageContext();
  return run(() => updatePersonLink(ctx, linkId, { isActive }));
}

export async function addSalaryAction(_prev: PeopleActionState, fd: FormData): Promise<PeopleActionState> {
  const ctx = await getPageContext();
  return run(() =>
    addPersonSalary(ctx, str(fd, "linkId") ?? "", {
      amount: str(fd, "amount") ?? "",
      currency: str(fd, "currency") ?? "KGS",
      payType: (str(fd, "payType") ?? null) as never,
      effectiveFrom: str(fd, "effectiveFrom") ?? null,
      note: str(fd, "note") ?? null,
    }),
  );
}

export async function setSalaryViewerAction(userId: string, enabled: boolean): Promise<PeopleActionState> {
  const ctx = await getPageContext();
  return run(() => setSalaryViewer(ctx, userId, enabled));
}

// ---------------------------------------------------------------------------
// Import (the browser sends the file with every step; nothing is stored on the server)
// ---------------------------------------------------------------------------

export interface ImportState {
  step: "upload" | "map" | "preview" | "done";
  error?: string;
  fileName?: string;
  headers?: string[];
  rowCount?: number;
  allowSalary?: boolean;
  salaryHeaders?: number[];
  mapping?: ImportMapping;
  defaultCompanyId?: string | null;
  plan?: ImportPlan;
  applied?: number;
}

async function readUpload(fd: FormData): Promise<{ table: ParsedTable; name: string } | { error: string }> {
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a .xlsx or .csv file." };
  if (file.size > MAX_IMPORT_BYTES) return { error: "The file is larger than 2 MB." };
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { table: await parseTableFile(bytes, file.name), name: file.name };
  } catch (err) {
    if (err instanceof ImportFileError) return { error: err.message };
    throw err;
  }
}

function mappingFromForm(fd: FormData): ImportMapping {
  const raw = str(fd, "mapping");
  if (!raw) return {};
  try {
    return importMappingSchema.parse(JSON.parse(raw));
  } catch {
    return {};
  }
}

export async function importAction(prev: ImportState, fd: FormData): Promise<ImportState> {
  const ctx = await getPageContext();
  const step = str(fd, "step");
  const upload = await readUpload(fd);
  if ("error" in upload) return { ...prev, step: prev.step === "upload" ? "upload" : prev.step, error: upload.error };
  const { table, name } = upload;
  const defaultCompanyId = str(fd, "defaultCompanyId") || null;

  try {
    if (step === "analyze") {
      const info = await describeImportFile(ctx, table);
      return { step: "map", fileName: name, ...info, defaultCompanyId };
    }
    const mapping = mappingFromForm(fd);
    const base: ImportState = { ...prev, fileName: name, mapping, defaultCompanyId, error: undefined };
    if (step === "preview") {
      const plan = await planImport(ctx, table, mapping, { defaultCompanyId });
      return { ...base, step: "preview", plan };
    }
    if (step === "confirm") {
      const result = await applyImport(ctx, table, mapping, { defaultCompanyId });
      revalidatePath("/", "layout");
      const { applied, ...plan } = result;
      return { ...base, step: "done", plan, applied };
    }
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return { ...prev, error: se.message };
  }
  return { ...prev, error: "Unknown step" };
}
