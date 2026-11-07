"use server";

import { CACHE_TAGS, refreshAfterWrite } from "@/server/cache";
import { getPageContext } from "@/server/context";
import { toServiceError } from "@/server/services/errors";
import {
  archiveCompany,
  createCompany,
  deleteCompany,
  moveCompany,
  reorderCompanies,
  restoreCompany,
  updateCompany,
  type CompanyCreateInput,
} from "@/server/services/companies";

export interface CompanyFormState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
  /** Changes on every success so the form can reset/close. */
  nonce?: number;
  slug?: string;
}

export interface CompanyActionResult {
  ok: boolean;
  error?: string;
}

const text = (fd: FormData, key: string) => {
  const v = fd.get(key);
  return typeof v === "string" ? v : undefined;
};

/**
 * The sidebar, pickers and company pages all list companies: the service dropped the cached
 * list (tag `companies`); this re-renders the calling page, layout included.
 */
function refresh() {
  refreshAfterWrite(CACHE_TAGS.companies);
}

async function run(fn: () => Promise<unknown>): Promise<CompanyActionResult> {
  try {
    await fn();
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return { ok: false, error: se.message };
  }
  refresh();
  return { ok: true };
}

function formFields(fd: FormData) {
  return {
    name: text(fd, "name") ?? "",
    slug: text(fd, "slug") ?? "",
    // Untrusted: the service validates it against COMPANY_KINDS.
    kind: text(fd, "kind") as CompanyCreateInput["kind"],
    color: text(fd, "color") || undefined,
    legalName: text(fd, "legalName") ?? "",
    description: text(fd, "description") ?? "",
  };
}

export async function createCompanyAction(_prev: CompanyFormState, fd: FormData): Promise<CompanyFormState> {
  const ctx = await getPageContext();
  try {
    const c = await createCompany(ctx, formFields(fd));
    refresh();
    return { ok: true, nonce: Date.now(), slug: c.slug };
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return { ok: false, error: se.message, fieldErrors: se.fields };
  }
}

export async function updateCompanyAction(_prev: CompanyFormState, fd: FormData): Promise<CompanyFormState> {
  const ctx = await getPageContext();
  const id = text(fd, "id") ?? "";
  try {
    const c = await updateCompany(ctx, id, formFields(fd));
    refresh();
    return { ok: true, nonce: Date.now(), slug: c.slug };
  } catch (err) {
    const se = toServiceError(err);
    if (!se) throw err;
    return { ok: false, error: se.message, fieldErrors: se.fields };
  }
}

export async function archiveCompanyAction(id: string): Promise<CompanyActionResult> {
  const ctx = await getPageContext();
  return run(() => archiveCompany(ctx, id));
}

export async function restoreCompanyAction(id: string): Promise<CompanyActionResult> {
  const ctx = await getPageContext();
  return run(() => restoreCompany(ctx, id));
}

export async function deleteCompanyAction(id: string): Promise<CompanyActionResult> {
  const ctx = await getPageContext();
  return run(() => deleteCompany(ctx, id));
}

export async function moveCompanyAction(id: string, direction: "up" | "down"): Promise<CompanyActionResult> {
  const ctx = await getPageContext();
  return run(() => moveCompany(ctx, id, direction));
}

export async function reorderCompaniesAction(ids: string[]): Promise<CompanyActionResult> {
  const ctx = await getPageContext();
  return run(() => reorderCompanies(ctx, ids));
}
