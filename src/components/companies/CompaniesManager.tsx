"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import {
  archiveCompanyAction,
  createCompanyAction,
  deleteCompanyAction,
  moveCompanyAction,
  restoreCompanyAction,
  updateCompanyAction,
  type CompanyActionResult,
} from "@/app/(app)/settings/companies/actions";
import { CompanyDot, Tag } from "@/components/ui";
import { CompanyForm, type KindOption } from "./CompanyForm";

export interface CompanyRow {
  id: string;
  name: string;
  slug: string;
  kind: string;
  kindLabel: string;
  color: string;
  legalName: string;
  description: string;
  archived: boolean;
  /** "12 tasks, 3 people" — empty when nothing refers to the company. */
  usage: string;
  canDelete: boolean;
}

const DEFAULT_COLOR = "#1E6B49";

export function CompaniesManager({ companies, kinds, openNew }: { companies: CompanyRow[]; kinds: KindOption[]; openNew: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [adding, setAdding] = useState(openNew);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // `?new=1` (the sidebar's "+ Add company") opens the form, also when already on this page.
  const showAdd = adding || params.get("new") === "1";

  const active = companies.filter((c) => !c.archived);
  const archived = companies.filter((c) => c.archived);

  const closeAdd = useCallback(() => {
    setAdding(false);
    if (params.get("new")) router.replace(pathname);
  }, [params, pathname, router]);

  const act = (fn: () => Promise<CompanyActionResult>, ok?: string) =>
    start(async () => {
      const r = await fn();
      setError(r.ok ? null : r.error ?? "Something went wrong");
      setNotice(r.ok ? ok ?? null : null);
    });

  const onAdded = useCallback(
    (s: { slug?: string }) => {
      setNotice(s.slug ? `Added. Its page: /companies/${s.slug}` : "Added.");
      setError(null);
      closeAdd();
    },
    [closeAdd],
  );
  const onEdited = useCallback(() => {
    setEditing(null);
    setNotice("Saved.");
  }, []);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {!showAdd && (
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)} data-testid="add-company">
            + Add company
          </button>
        )}
        {notice && <p className="text-[12px] text-muted" role="status">{notice}</p>}
        {error && (
          <p className="text-[12px] text-risk" role="alert">
            {error}
          </p>
        )}
      </div>

      {showAdd && (
        <section className="card mb-5 p-4 md:p-5" aria-labelledby="add-company-heading">
          <h2 id="add-company-heading" className="eyebrow mb-3">
            Add company
          </h2>
          <CompanyForm
            idPrefix="new-company"
            action={createCompanyAction}
            initial={{ name: "", slug: "", kind: "generic", color: DEFAULT_COLOR, legalName: "", description: "" }}
            kinds={kinds}
            submitLabel="Add company"
            onDone={onAdded}
            onCancel={closeAdd}
          />
        </section>
      )}

      <section className="card mb-5 p-0" aria-labelledby="active-companies-heading">
        <h2 id="active-companies-heading" className="eyebrow px-4 pb-2 pt-4 md:px-5">
          Companies · sidebar order
        </h2>
        {active.length === 0 ? (
          <p className="px-4 pb-4 text-[13px] text-muted md:px-5">No companies yet. Add the first one.</p>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {active.map((c, i) => (
              <li key={c.id} className="px-4 py-3 md:px-5" data-testid={`company-row-${c.slug}`}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <div className="flex flex-col">
                    <button
                      type="button"
                      className="btn-ghost rounded px-1 text-[12px] leading-4 disabled:opacity-30"
                      aria-label={`Move ${c.name} up`}
                      disabled={pending || i === 0}
                      onClick={() => act(() => moveCompanyAction(c.id, "up"))}
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      className="btn-ghost rounded px-1 text-[12px] leading-4 disabled:opacity-30"
                      aria-label={`Move ${c.name} down`}
                      disabled={pending || i === active.length - 1}
                      onClick={() => act(() => moveCompanyAction(c.id, "down"))}
                    >
                      ▼
                    </button>
                  </div>
                  <CompanyDot color={c.color} size={10} />
                  <div className="min-w-0 flex-1">
                    <Link href={`/companies/${c.slug}`} className="font-medium hover:underline">
                      {c.name}
                    </Link>
                    <p className="truncate text-[12px] text-muted">
                      <span className="font-mono">/{c.slug}</span>
                      {c.legalName && ` · ${c.legalName}`}
                      {c.usage && ` · ${c.usage}`}
                    </p>
                  </div>
                  <Tag>{c.kindLabel}</Tag>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setEditing(editing === c.id ? null : c.id)}
                      aria-expanded={editing === c.id}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={pending}
                      onClick={() => {
                        if (confirm(`Archive ${c.name}? It disappears from the sidebar and pickers; all data is kept and it can be restored here.`)) {
                          act(() => archiveCompanyAction(c.id), `${c.name} archived.`);
                        }
                      }}
                    >
                      Archive
                    </button>
                    <DeleteButton company={c} pending={pending} onDelete={() => act(() => deleteCompanyAction(c.id), `${c.name} deleted.`)} />
                  </div>
                </div>
                {editing === c.id && (
                  <div className="mt-3 rounded-[8px] border border-line p-3">
                    <CompanyForm
                      idPrefix={`edit-${c.slug}`}
                      action={updateCompanyAction}
                      initial={c}
                      kinds={kinds}
                      submitLabel="Save"
                      onDone={onEdited}
                      onCancel={() => setEditing(null)}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {archived.length > 0 && (
        <section className="card mb-5 p-0" aria-labelledby="archived-companies-heading">
          <h2 id="archived-companies-heading" className="eyebrow px-4 pb-2 pt-4 md:px-5">
            Archived · hidden everywhere
          </h2>
          <ul className="divide-y divide-line border-t border-line">
            {archived.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3 opacity-80 md:px-5" data-testid={`company-row-${c.slug}`}>
                <CompanyDot color={c.color} size={10} />
                <div className="min-w-0 flex-1">
                  <span className="font-medium">{c.name}</span>
                  <p className="truncate text-[12px] text-muted">
                    <span className="font-mono">/{c.slug}</span>
                    {c.usage && ` · ${c.usage}`}
                  </p>
                </div>
                <Tag>{c.kindLabel}</Tag>
                <div className="flex flex-wrap gap-1.5">
                  <button type="button" className="btn btn-sm" disabled={pending} onClick={() => act(() => restoreCompanyAction(c.id), `${c.name} restored.`)}>
                    Restore
                  </button>
                  <DeleteButton company={c} pending={pending} onDelete={() => act(() => deleteCompanyAction(c.id), `${c.name} deleted.`)} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function DeleteButton({ company, pending, onDelete }: { company: CompanyRow; pending: boolean; onDelete: () => void }) {
  const why = company.canDelete ? undefined : `Has ${company.usage}: archive instead`;
  return (
    <button
      type="button"
      className="btn btn-sm btn-danger"
      disabled={pending || !company.canDelete}
      title={why}
      aria-label={company.canDelete ? `Delete ${company.name}` : `Delete ${company.name} (not possible: ${why})`}
      onClick={() => {
        if (confirm(`Delete ${company.name} for good? This cannot be undone.`)) onDelete();
      }}
    >
      Delete
    </button>
  );
}
