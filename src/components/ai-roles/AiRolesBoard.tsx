"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { hireAction, runNowAction, tuneAction, type AiActionState } from "@/app/(app)/ai-roles/actions";
import { CompanyDot } from "@/components/ui";
import type { RoleEngine } from "@/lib/ai-role-config";
import { HireWizard, type WizardCompany, type WizardSettings, type WizardTarget } from "./HireWizard";
import { RoleEditor, type CopySource, type EditorMetric, type EditorTarget } from "./RoleEditor";

export interface BoardTemplate {
  key: string;
  name: string;
  description: string;
  status: "available" | "coming_soon";
  responsibilities: string[];
  reportSections: string[];
  scheduleLabel: string;
  /** The role editor (template level / custom role definition). */
  editor: EditorTarget;
  custom: boolean;
  /** Custom roles: the company it works for, and its hire there (if hired). */
  companyId?: string;
  companyName?: string;
  hiredId?: string | null;
  /** The founders renamed / rewrote it (or it has saved check defaults). */
  edited?: boolean;
}

export interface BoardHire {
  id: string;
  templateKey: string;
  roleName: string;
  companyId: string;
  companyName: string;
  companySlug: string;
  companyColor: string;
  status: "active" | "paused";
  scheduleLabel: string;
  settings: WizardSettings;
  notes: string | null;
  recipientNames: string[];
  askNames: string[];
  requiredLabels: string[];
  latestRun: { id: string; periodLabel: string; status: string; summary: string } | null;
  /** "org_rules" for the Org Structure Expert (no monthly runs; findings live on the org board). */
  engine?: RoleEngine;
  orgSummary?: string;
  /** This hire's own settings in the role editor. */
  editor: EditorTarget;
  custom?: boolean;
}

const RUN_TONE: Record<string, string> = {
  waiting_for_data: "tag-warn",
  ready: "tag-info",
  analysed: "tag-info",
  reported: "tag-ok",
  failed: "tag-risk",
};
export const RUN_STATUS_LABEL: Record<string, string> = {
  waiting_for_data: "Waiting for data",
  ready: "Ready",
  analysed: "Analysed",
  reported: "Reported",
  failed: "Failed",
};

export function RunStatusTag({ status }: { status: string }) {
  return <span className={`tag ${RUN_TONE[status] ?? ""}`}>{RUN_STATUS_LABEL[status] ?? status}</span>;
}

function HireCard({ hire, onTune, onEdit }: { hire: BoardHire; onTune: () => void; onEdit: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [state, setState] = useState<AiActionState>({});
  const act = (fn: () => Promise<AiActionState>) =>
    start(async () => {
      const res = await fn();
      setState(res);
      if (res.ok && res.href) router.push(res.href);
      else if (res.ok) router.refresh();
    });
  return (
    <div className="card flex flex-col gap-2 p-4" data-testid="hire-card" data-company={hire.companySlug} data-role={hire.templateKey}>
      <div className="flex flex-wrap items-center gap-2">
        <CompanyDot color={hire.companyColor} size={10} />
        <span className="font-semibold">{hire.roleName}</span>
        <span className="text-muted">· {hire.companyName}</span>
        {hire.custom && <span className="tag">Your role</span>}
        <span className={`tag ${hire.status === "active" ? "tag-ok" : ""} ml-auto`}>{hire.status === "active" ? "Active" : "Paused"}</span>
      </div>
      {hire.engine === "org_rules" ? (
        <p className="text-[12px] text-muted">
          {hire.scheduleLabel} (one line in the morning summary) · reports to {hire.recipientNames.join(" and ")} · flags a head of more than{" "}
          {hire.settings.maxDepartmentsPerHead ?? 4} departments
        </p>
      ) : (
        <p className="text-[12px] text-muted">
          {hire.scheduleLabel} · waits for {hire.requiredLabels.join(", ") || "nothing"} · reports to {hire.recipientNames.join(" and ")} · asks{" "}
          {hire.askNames.join(" and ")}
        </p>
      )}
      {hire.notes && <p className="text-[12px]">{hire.notes}</p>}
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        {hire.engine === "org_rules" ? (
          <Link href={`/org?company=${hire.companySlug}`} className="text-accent hover:underline">
            {hire.orgSummary} · open the org board
          </Link>
        ) : hire.latestRun ? (
          <Link href={`/ai-roles/runs/${hire.latestRun.id}`} className="flex items-center gap-2 text-accent hover:underline">
            Latest: {hire.latestRun.periodLabel} <RunStatusTag status={hire.latestRun.status} />
            <span className="text-muted">{hire.latestRun.summary}</span>
          </Link>
        ) : (
          <span className="text-muted">No report yet — it runs {hire.scheduleLabel.toLowerCase()}.</span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {!hire.custom && (
          <button type="button" className="btn btn-sm" onClick={onTune} disabled={pending}>
            Tune
          </button>
        )}
        <button type="button" className="btn btn-sm" onClick={onEdit} disabled={pending}>
          Edit settings
        </button>
        <button type="button" className="btn btn-sm" disabled={pending} onClick={() => act(() => tuneAction(hire.id, { status: hire.status === "active" ? "paused" : "active" }))}>
          {hire.status === "active" ? "Pause" : "Resume"}
        </button>
        {hire.status === "active" && hire.engine !== "org_rules" && (
          <button type="button" className="btn btn-sm btn-primary" disabled={pending} onClick={() => act(() => runNowAction(hire.id))}>
            Run now (last month)
          </button>
        )}
      </div>
      {(state.error || state.message) && (
        <p className={`text-[12px] ${state.error ? "text-risk" : "text-muted"}`} role="status">
          {state.error ?? state.message}
        </p>
      )}
    </div>
  );
}

/** /ai-roles: hired roles (tune, pause, run now, latest report) and the role catalogue with the Hire wizard. */
function CustomRoleCard({ role, onEdit }: { role: BoardTemplate; onEdit: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [state, setState] = useState<AiActionState>({});
  return (
    <div className="card flex flex-col gap-2 p-4" data-testid="custom-role" data-role={role.key}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[15px] font-semibold">{role.name}</span>
        <span className="text-muted">· {role.companyName}</span>
        <span className={`tag ml-auto ${role.hiredId ? "tag-ok" : ""}`}>{role.hiredId ? "Hired" : "Not hired"}</span>
      </div>
      {role.description && <p className="text-[13px] text-muted">{role.description}</p>}
      <p className="text-[12px] text-muted">
        Watches {role.editor.watched?.length ?? 0} number{role.editor.watched?.length === 1 ? "" : "s"} · {role.scheduleLabel.toLowerCase()}
      </p>
      <div className="mt-auto flex flex-wrap gap-2">
        <button type="button" className="btn btn-sm" onClick={onEdit} disabled={pending}>
          Edit role
        </button>
        {!role.hiredId && (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await hireAction({ templateKey: role.key, companyId: role.companyId! });
                setState(res);
                if (res.ok) router.refresh();
              })
            }
          >
            Hire for {role.companyName}
          </button>
        )}
      </div>
      {(state.error || state.message) && (
        <p className={`text-[12px] ${state.error ? "text-risk" : "text-muted"}`} role="status">
          {state.error ?? state.message}
        </p>
      )}
    </div>
  );
}

const NEW_ROLE: EditorTarget = {
  mode: "create",
  title: "New role",
  engine: "custom",
  custom: true,
  identity: { name: "", description: "", responsibilities: [], instructions: "" },
  inherited: { name: "e.g. Revenue watcher", description: "What it is for", responsibilities: [], instructions: "" },
  schedule: { kind: "monthly", day: 10 },
  recipients: [],
  checks: {},
  versions: [],
};

export function AiRolesBoard({
  templates,
  hires,
  companies,
  founders,
  initial,
  editorCompanies,
  metricsByCompany,
  copySources,
  defaultChecksCustom,
}: {
  templates: BoardTemplate[];
  hires: BoardHire[];
  /** Per template key: companies for the wizard. */
  companies: Record<string, WizardCompany[]>;
  founders: { id: string; shortName: string }[];
  initial: WizardTarget | null;
  editorCompanies: { id: string; name: string }[];
  metricsByCompany: Record<string, EditorMetric[]>;
  copySources: CopySource[];
  defaultChecksCustom: EditorTarget["checks"];
}) {
  const [target, setTarget] = useState<WizardTarget | null>(initial);
  const [editing, setEditing] = useState<EditorTarget | null>(null);
  const builtIn = templates.filter((t) => !t.custom);
  const custom = templates.filter((t) => t.custom);
  return (
    <>
      <section className="mb-6">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="eyebrow">Hired</h2>
          <span className="tag">
            <span className="num">{hires.length}</span>
          </span>
        </div>
        {hires.length === 0 ? (
          <div className="card px-4 py-6 text-center text-[13px] text-muted">No AI roles hired yet. Hire the Financial Analyst below.</div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {hires.map((h) => (
              <HireCard
                key={h.id}
                hire={h}
                onTune={() => setTarget({ templateKey: h.templateKey, roleName: h.roleName, hireId: h.id, companyId: h.companyId, settings: h.settings, notes: h.notes })}
                onEdit={() => setEditing(h.editor)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="mb-6" data-testid="your-roles">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="eyebrow">Your roles</h2>
          <span className="text-[12px] text-muted">Made by you: pick a company, the numbers it watches and the checks it runs.</span>
          <button
            type="button"
            className="btn btn-sm btn-primary ml-auto"
            onClick={() => setEditing({ ...NEW_ROLE, recipients: founders.map((f) => f.id), checks: structuredClone(defaultChecksCustom) })}
          >
            Create your own role
          </button>
        </div>
        {custom.length === 0 ? (
          <div className="card px-4 py-6 text-center text-[13px] text-muted">No roles of your own yet — create one from scratch or as a copy of the Financial Analyst.</div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {custom.map((r) => (
              <CustomRoleCard key={r.key} role={r} onEdit={() => setEditing(r.editor)} />
            ))}
          </div>
        )}
      </section>

      <section className="mb-6">
        <h2 className="eyebrow mb-2">Roles you can hire</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {builtIn.map((t) => (
            <div key={t.key} className="card flex flex-col gap-2 p-4" data-testid="role-template" data-role={t.key}>
              <div className="flex items-center gap-2">
                <span className="text-[15px] font-semibold">{t.name}</span>
                {t.edited && <span className="tag">Edited</span>}
                {t.status === "coming_soon" ? <span className="tag tag-info ml-auto">Coming soon</span> : <span className="tag tag-ok ml-auto">Available</span>}
              </div>
              <p className="text-[13px] text-muted">{t.description}</p>
              {t.status === "available" && (
                <>
                  <ul className="list-disc pl-5 text-[13px]">
                    {t.responsibilities.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                  <p className="text-[12px] text-muted">
                    Default: {t.scheduleLabel.toLowerCase()} · report: {t.reportSections.join(", ")}
                  </p>
                </>
              )}
              <div className="mt-auto flex flex-wrap gap-2">
                <button
                  type="button"
                  className={`btn btn-sm ${t.status === "available" ? "btn-primary" : ""}`}
                  disabled={t.status !== "available"}
                  onClick={() => setTarget({ templateKey: t.key, roleName: t.name })}
                >
                  {t.status === "available" ? `Hire ${t.name}` : "Not hireable yet"}
                </button>
                {t.status === "available" && (
                  <button type="button" className="btn btn-sm" onClick={() => setEditing(t.editor)}>
                    Edit role
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {editing && (
        <RoleEditor
          key={`${editing.mode}:${editing.roleKey ?? ""}:${editing.hireId ?? ""}`}
          target={editing}
          founders={founders}
          companies={editorCompanies}
          metricsByCompany={metricsByCompany}
          copySources={copySources}
          onClose={() => setEditing(null)}
        />
      )}
      {target && (
        <HireWizard key={`${target.templateKey}:${target.hireId ?? target.companyId ?? ""}`} target={target} companies={companies[target.templateKey] ?? []} founders={founders} onClose={() => setTarget(null)} />
      )}
    </>
  );
}
