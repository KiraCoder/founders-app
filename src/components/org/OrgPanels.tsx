"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import type { OrgActionState } from "@/app/(app)/org/actions";
import { defaultOrgRole, deptLabel, type OrgAssignTarget } from "@/lib/org";
import type { OrgDepartmentView, OrgDivisionView } from "@/server/services/org";
import type { LinkedMetric } from "./OrgBoard";
import { PersonPicker, type NewPersonData, type PersonOption } from "./PersonPicker";

/** "+ New person" (founders): create, link to the company and assign to this target. */
export type CreatePersonFor = (target: OrgAssignTarget, targetId: string, data: NewPersonData) => Promise<OrgActionState>;

function Sheet({ title, onClose, children, testId }: { title: ReactNode; onClose: () => void; children: ReactNode; testId: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20 md:bg-transparent" onClick={onClose} aria-hidden="true" />
      <aside
        role="dialog"
        aria-label={typeof title === "string" ? title : "Details"}
        data-testid={testId}
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[420px] flex-col border-l border-line bg-surface shadow-card"
      >
        <div className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="text-[16px] font-semibold leading-6">{title}</h2>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>
      </aside>
    </>
  );
}

const TONE: Record<LinkedMetric["tone"], string> = { ok: "tag-ok", warn: "tag-warn", risk: "tag-risk" };

/** Right-side panel of a department: head, ЦКП, statistic + linked number, functions with responsible people, tasks. */
export function DepartmentPanel({
  dept,
  companySlug,
  editable,
  people,
  metrics,
  linked,
  onClose,
  onSave,
  onSaveFunction,
  onAddFunction,
  onArchive,
  onCreatePerson,
}: {
  dept: OrgDepartmentView;
  companySlug: string;
  editable: boolean;
  people: PersonOption[];
  metrics: { id: string; label: string }[];
  linked: LinkedMetric | null;
  onClose: () => void;
  onSave: (patch: Record<string, string | null>) => void;
  onSaveFunction: (id: string, patch: Record<string, string | null>) => void;
  onAddFunction: (text: string) => void;
  onArchive: () => void;
  onCreatePerson?: CreatePersonFor;
}) {
  const [form, setForm] = useState({
    name: dept.name,
    headPersonId: dept.headPersonId ?? "",
    ckp: dept.ckp,
    statistic: dept.statistic,
    metricDefinitionId: dept.metricDefinitionId ?? "",
  });
  const [newFn, setNewFn] = useState("");
  const original: Record<string, string> = { name: dept.name, headPersonId: dept.headPersonId ?? "", ckp: dept.ckp, statistic: dept.statistic, metricDefinitionId: dept.metricDefinitionId ?? "" };
  const changed = Object.fromEntries(
    Object.entries(form)
      .filter(([k, v]) => v.trim() !== original[k]!.trim())
      .map(([k, v]) => [k, (k === "headPersonId" || k === "metricDefinitionId") && v === "" ? null : v.trim()]),
  );
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Sheet
      testId="org-department-panel"
      onClose={onClose}
      title={
        <>
          <span className="num mr-1.5 text-accent">{dept.number}</span>
          {dept.name || "без названия"}
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (Object.keys(changed).length) onSave(changed);
        }}
      >
        <div>
          <label className="label" htmlFor="org-p-name">
            Name
          </label>
          <input id="org-p-name" className="input" value={form.name} onChange={(e) => set("name")(e.target.value)} disabled={!editable} maxLength={160} />
        </div>
        <div>
          <label className="label" htmlFor="org-p-head">
            Head of the department
          </label>
          <PersonPicker
            id="org-p-head"
            label="Head of the department"
            value={form.headPersonId}
            onChange={set("headPersonId")}
            people={people}
            disabled={!editable}
            defaultRole={defaultOrgRole(dept.name || deptLabel(dept))}
            onCreate={onCreatePerson ? (data) => onCreatePerson("department", dept.id, data) : undefined}
          />
          <p className="mt-1 text-[11.5px] text-muted">People of this company (People page).</p>
        </div>
        <div>
          <label className="label" htmlFor="org-p-ckp">
            ЦКП
          </label>
          <textarea id="org-p-ckp" className="input" rows={3} value={form.ckp} onChange={(e) => set("ckp")(e.target.value)} disabled={!editable} maxLength={1000} />
        </div>
        <div>
          <label className="label" htmlFor="org-p-stat">
            Статистика
          </label>
          <textarea id="org-p-stat" className="input" rows={2} value={form.statistic} onChange={(e) => set("statistic")(e.target.value)} disabled={!editable} maxLength={500} />
        </div>
        <div>
          <label className="label" htmlFor="org-p-metric">
            Linked company number (optional)
          </label>
          <select id="org-p-metric" className="input" value={form.metricDefinitionId} onChange={(e) => set("metricDefinitionId")(e.target.value)} disabled={!editable}>
            <option value="">None</option>
            {metrics.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {linked && form.metricDefinitionId === (dept.metricDefinitionId ?? "") && (
            <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12.5px]" data-testid="org-linked-metric">
              <span className="font-medium">{linked.label}:</span>
              <span className="num">{linked.value ?? "—"}</span>
              {linked.period && <span className="text-muted">({linked.period})</span>}
              <span className={`tag ${TONE[linked.tone]}`}>{linked.freshness}</span>
            </p>
          )}
        </div>
        {editable && (
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary btn-sm" disabled={!Object.keys(changed).length}>
              Save
            </button>
            <button type="button" className="btn btn-sm" onClick={onArchive}>
              Archive department
            </button>
          </div>
        )}
      </form>

      <section className="mt-5">
        <h3 className="eyebrow mb-2">Tasks</h3>
        <p className="text-[13px]">
          <span className="num font-semibold">{dept.openTasks}</span> open
          {dept.overdueTasks > 0 && (
            <>
              {" "}
              · <span className="num font-semibold text-risk">{dept.overdueTasks}</span> overdue
            </>
          )}{" "}
          ·{" "}
          <Link href={`/companies/${companySlug}?tab=tasks`} className="text-accent hover:underline">
            Company tasks
          </Link>
        </p>
        <p className="mt-1 text-[11.5px] text-muted">Pick the department in a company task&apos;s form to count it here.</p>
      </section>

      <section className="mt-5">
        <h3 className="eyebrow mb-2">Functions ({dept.functions.length})</h3>
        <ul className="flex flex-col gap-2">
          {dept.functions.map((f) => (
            <li key={f.id} className="rounded-[8px] border border-line p-2 text-[13px]">
              <p className="mb-1.5">{f.text}</p>
              <PersonPicker
                id={`org-fn-${f.id}`}
                label={`Responsible for ${f.text}`}
                value={f.responsiblePersonId ?? ""}
                onChange={(v) => onSaveFunction(f.id, { responsiblePersonId: v || null })}
                people={people}
                disabled={!editable}
                defaultRole={defaultOrgRole(f.text)}
                onCreate={onCreatePerson ? (data) => onCreatePerson("function", f.id, data) : undefined}
              />
            </li>
          ))}
        </ul>
        {editable && (
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (newFn.trim()) onAddFunction(newFn.trim());
              setNewFn("");
            }}
          >
            <input className="input h-8 text-[13px]" aria-label="New function" placeholder="Новая функция" value={newFn} onChange={(e) => setNewFn(e.target.value)} maxLength={500} />
            <button type="submit" className="btn btn-sm">
              Add
            </button>
          </form>
        )}
      </section>
    </Sheet>
  );
}

/** Division panel: name, head title, Подчинение, ЦКП and the head person. */
export function DivisionPanel({
  division,
  editable,
  people,
  onClose,
  onSave,
  onCreatePerson,
}: {
  division: OrgDivisionView;
  editable: boolean;
  people: PersonOption[];
  onClose: () => void;
  onSave: (patch: Record<string, string | null>) => void;
  onCreatePerson?: CreatePersonFor;
}) {
  const original: Record<string, string> = { name: division.name, headTitle: division.headTitle, reportsTo: division.reportsTo, ckp: division.ckp, headPersonId: division.headPersonId ?? "" };
  const [form, setForm] = useState(original);
  const changed = Object.fromEntries(
    Object.entries(form)
      .filter(([k, v]) => v.trim() !== original[k]!.trim())
      .map(([k, v]) => [k, k === "headPersonId" && v === "" ? null : v.trim()]),
  );
  const field = (k: string, label: string, rows = 1) => (
    <div>
      <label className="label" htmlFor={`org-dv-${k}`}>
        {label}
      </label>
      {rows > 1 ? (
        <textarea id={`org-dv-${k}`} className="input" rows={rows} value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} disabled={!editable} />
      ) : (
        <input id={`org-dv-${k}`} className="input" value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} disabled={!editable} />
      )}
    </div>
  );
  return (
    <Sheet testId="org-division-panel" onClose={onClose} title={`Division ${deptLabel(division)}`}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (Object.keys(changed).length) onSave(changed);
        }}
      >
        {field("name", "Name")}
        {field("headTitle", "Руководитель (post title)")}
        <div>
          <label className="label" htmlFor="org-dv-head">
            Head of the division (person)
          </label>
          <PersonPicker
            id="org-dv-head"
            label="Head of the division"
            value={form.headPersonId!}
            onChange={(v) => setForm((f) => ({ ...f, headPersonId: v }))}
            people={people}
            disabled={!editable}
            defaultRole={defaultOrgRole(division.headTitle || division.name || deptLabel(division))}
            onCreate={onCreatePerson ? (data) => onCreatePerson("division", division.id, data) : undefined}
          />
        </div>
        {field("reportsTo", "Подчинение")}
        {field("ckp", "ЦКП", 3)}
        {editable && (
          <button type="submit" className="btn btn-primary btn-sm self-start" disabled={!Object.keys(changed).length}>
            Save
          </button>
        )}
      </form>
    </Sheet>
  );
}
