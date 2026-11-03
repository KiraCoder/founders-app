"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { runNowAction, tuneAction, type AiActionState } from "@/app/(app)/ai-roles/actions";
import { CompanyDot } from "@/components/ui";
import { HireWizard, type WizardCompany, type WizardSettings, type WizardTarget } from "./HireWizard";

export interface BoardTemplate {
  key: string;
  name: string;
  description: string;
  status: "available" | "coming_soon";
  responsibilities: string[];
  reportSections: string[];
  scheduleLabel: string;
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
  engine?: "finance" | "org_rules";
  orgSummary?: string;
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

function HireCard({ hire, onTune }: { hire: BoardHire; onTune: () => void }) {
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
    <div className="card flex flex-col gap-2 p-4" data-testid="hire-card" data-company={hire.companySlug}>
      <div className="flex flex-wrap items-center gap-2">
        <CompanyDot color={hire.companyColor} size={10} />
        <span className="font-semibold">{hire.roleName}</span>
        <span className="text-muted">· {hire.companyName}</span>
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
        <button type="button" className="btn btn-sm" onClick={onTune} disabled={pending}>
          Tune
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
export function AiRolesBoard({
  templates,
  hires,
  companies,
  founders,
  initial,
}: {
  templates: BoardTemplate[];
  hires: BoardHire[];
  /** Per template key: companies for the wizard. */
  companies: Record<string, WizardCompany[]>;
  founders: { id: string; shortName: string }[];
  initial: WizardTarget | null;
}) {
  const [target, setTarget] = useState<WizardTarget | null>(initial);
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
              />
            ))}
          </div>
        )}
      </section>

      <section className="mb-6">
        <h2 className="eyebrow mb-2">Roles you can hire</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {templates.map((t) => (
            <div key={t.key} className="card flex flex-col gap-2 p-4" data-testid="role-template" data-role={t.key}>
              <div className="flex items-center gap-2">
                <span className="text-[15px] font-semibold">{t.name}</span>
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
              <div className="mt-auto">
                <button
                  type="button"
                  className={`btn btn-sm ${t.status === "available" ? "btn-primary" : ""}`}
                  disabled={t.status !== "available"}
                  onClick={() => setTarget({ templateKey: t.key, roleName: t.name })}
                >
                  {t.status === "available" ? `Hire ${t.name}` : "Not hireable yet"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {target && (
        <HireWizard key={`${target.templateKey}:${target.hireId ?? target.companyId ?? ""}`} target={target} companies={companies[target.templateKey] ?? []} founders={founders} onClose={() => setTarget(null)} />
      )}
    </>
  );
}
