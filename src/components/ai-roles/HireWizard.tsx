"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { hireAction, tuneAction, type AiActionState } from "@/app/(app)/ai-roles/actions";
import { Icon } from "@/components/Icon";
import { defaultAcceptMonthlyTotals, ORG_STRUCTURE_EXPERT } from "@/lib/ai-roles";

export interface WizardCompany {
  id: string;
  name: string;
  slug: string;
  typeLabel: string;
  metrics: { key: string; label: string; granularity: "day" | "week" | "month"; unit: string }[];
  /** Default "waits for" keys of the role for this company type. */
  defaultKeys: string[];
  /** Hire id when the role is already hired here. */
  hiredId: string | null;
}

export interface WizardSettings {
  schedule: { kind: "monthly"; day: number };
  thresholds: { changePct: number; riskChangePct: number };
  requiredMetricKeys: string[];
  recipients: string[];
  askUserIds: string[];
  acceptMonthlyTotals?: boolean;
  maxDepartmentsPerHead?: number;
}

export interface WizardTarget {
  templateKey: string;
  roleName: string;
  /** Tune an existing hire (company fixed) instead of hiring. */
  hireId?: string;
  companyId?: string;
  settings?: WizardSettings;
  notes?: string | null;
}

const FINANCE_STEPS = ["Company", "Data it needs", "Schedule", "Who hears from it"] as const;
/** The Org Structure Expert needs no numbers and asks nobody: company → checks → who hears from it. */
const ORG_STEPS = ["Company", "Checks", "Who hears from it"] as const;
type StepName = (typeof FINANCE_STEPS)[number] | (typeof ORG_STEPS)[number];
const GRAN = { day: "daily", week: "weekly", month: "monthly" } as const;

/**
 * Hire / Tune wizard: company → which numbers it waits for → schedule and thresholds → who
 * receives reports and whom it asks (founders only) → Hire. "Tune once, then it runs."
 */
export function HireWizard({
  target,
  companies,
  founders,
  onClose,
}: {
  target: WizardTarget;
  companies: WizardCompany[];
  founders: { id: string; shortName: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const tuning = !!target.hireId;
  const org = target.templateKey === ORG_STRUCTURE_EXPERT;
  const STEPS: readonly StepName[] = org ? ORG_STEPS : FINANCE_STEPS;
  const [step, setStep] = useState(tuning ? 1 : 0);
  const stepName = STEPS[step];
  const [maxHeads, setMaxHeads] = useState(String(target.settings?.maxDepartmentsPerHead ?? 4));
  const [companyId, setCompanyId] = useState(target.companyId ?? "");
  const company = companies.find((c) => c.id === companyId) ?? null;
  const allFounders = founders.map((f) => f.id);
  const [keys, setKeys] = useState<string[]>(target.settings?.requiredMetricKeys ?? company?.defaultKeys ?? []);
  const [day, setDay] = useState(String(target.settings?.schedule.day ?? 10));
  const [changePct, setChangePct] = useState(String(target.settings?.thresholds.changePct ?? 20));
  const [riskPct, setRiskPct] = useState(String(target.settings?.thresholds.riskChangePct ?? 50));
  const [recipients, setRecipients] = useState<string[]>(target.settings?.recipients ?? allFounders);
  const [askIds, setAskIds] = useState<string[]>(target.settings?.askUserIds ?? allFounders);
  const [acceptMonthly, setAcceptMonthly] = useState(target.settings?.acceptMonthlyTotals ?? defaultAcceptMonthlyTotals(target.templateKey));
  const [notes, setNotes] = useState(target.notes ?? "");
  const [state, setState] = useState<AiActionState>({});
  const [pending, start] = useTransition();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pickCompany = (id: string) => {
    setCompanyId(id);
    const c = companies.find((x) => x.id === id);
    setKeys(c?.defaultKeys.length ? c.defaultKeys : (c?.metrics.filter((m) => m.granularity === "month").map((m) => m.key) ?? []));
  };
  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const problem = useMemo(() => {
    if (stepName === "Company" && !company) return "Choose a company";
    if (stepName === "Company" && company?.hiredId) return `Already hired for ${company.name} — close this and use Tune`;
    if (stepName === "Company" && !org && company && company.metrics.length === 0) return `${company.name} has no numbers yet`;
    if (stepName === "Checks") {
      const n = Number(maxHeads);
      if (!Number.isInteger(n) || n < 1 || n > 21) return "Departments per head: 1 to 21";
    }
    if (org && stepName === "Who hears from it" && !recipients.length) return "Choose at least one founder";
    if (stepName === "Schedule") {
      const d = Number(day);
      if (!Number.isInteger(d) || d < 1 || d > 28) return "Day of the month: 1 to 28";
      if (!(Number(changePct) >= 1) || !(Number(riskPct) >= Number(changePct))) return "The risk threshold must be at least the warning threshold";
    }
    if (!org && stepName === "Who hears from it" && (!recipients.length || !askIds.length)) return "Choose at least one founder for each";
    return null;
  }, [stepName, org, company, day, changePct, riskPct, recipients, askIds, maxHeads]);

  const submit = () =>
    start(async () => {
      const settings = org
        ? { requiredMetricKeys: [], recipients, askUserIds: recipients, maxDepartmentsPerHead: Number(maxHeads) }
        : {
            schedule: { kind: "monthly" as const, day: Number(day) },
            thresholds: { changePct: Number(changePct), riskChangePct: Number(riskPct) },
            requiredMetricKeys: keys,
            recipients,
            askUserIds: askIds,
            acceptMonthlyTotals: acceptMonthly,
          };
      const res = tuning
        ? await tuneAction(target.hireId!, { settings, notes })
        : await hireAction({ templateKey: target.templateKey, companyId, settings, notes });
      setState(res);
      if (res.ok) {
        router.refresh();
        onClose();
      }
    });

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${tuning ? "Tune" : "Hire"} ${target.roleName}`}
        className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92dvh] w-full max-w-[560px] flex-col rounded-t-[14px] border border-line bg-surface shadow-card md:inset-y-10 md:bottom-auto md:rounded-[14px]"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <p className="eyebrow">{tuning ? "Tune" : "Hire"} · step {step + 1} of {STEPS.length}</p>
            <h2 className="text-[16px] font-semibold">
              {target.roleName}
              {company ? ` · ${company.name}` : ""}
            </h2>
          </div>
          <button type="button" className="btn btn-ghost px-2" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <ol className="flex gap-1 border-b border-line px-4 py-2 text-[12px]" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={i === step ? "step" : undefined} className={`rounded-full px-2 py-0.5 ${i === step ? "bg-accent-soft font-semibold text-accent" : "text-muted"}`}>
              {s}
            </li>
          ))}
        </ol>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {stepName === "Company" && (
            <fieldset>
              <legend className="label">Which company does it work for?</legend>
              <div className="flex flex-col gap-1.5">
                {companies.map((c) => (
                  <label key={c.id} className={`card flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px] ${c.id === companyId ? "border-accent" : ""}`}>
                    <input type="radio" name="company" value={c.id} checked={c.id === companyId} onChange={() => pickCompany(c.id)} disabled={tuning} />
                    <span className="font-medium">{c.name}</span>
                    <span className="text-muted">· {c.typeLabel}</span>
                    {c.hiredId && <span className="tag tag-info ml-auto">Hired</span>}
                    {!c.hiredId && !org && c.metrics.length === 0 && <span className="tag ml-auto">No numbers yet</span>}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {stepName === "Checks" && (
            <div className="flex flex-col gap-3 text-[13px]">
              <p className="text-muted">
                It checks the org chart of {company?.name ?? "the company"}: divisions and departments without a head, departments without ЦКП or a
                statistic, linked numbers that are not up to date, departments with 5+ overdue tasks, functions without a responsible person (info).
                The findings are always on the Org structure page; once a week (Mondays) it adds one line to the morning summary when something
                needs attention. Brainstorming and advice come after the AI provider is chosen.
              </p>
              <label>
                <span className="label">Flag a person heading more than … departments</span>
                <input className="input w-24" inputMode="numeric" value={maxHeads} onChange={(e) => setMaxHeads(e.target.value)} aria-label="Departments per head" />
              </label>
            </div>
          )}

          {stepName === "Data it needs" && company && (
            <fieldset>
              <legend className="label">Numbers it waits for before it analyses the month</legend>
              <p className="mb-2 text-[12px] text-muted">
                It asks for these on schedule and chases what is missing. Other numbers of {company.name} are used when present.
                Daily numbers count only when every day of the month is in.
              </p>
              <div className="flex flex-col gap-1">
                {company.metrics.map((m) => (
                  <label key={m.key} className="flex items-center gap-2 text-[13px]">
                    <input type="checkbox" checked={keys.includes(m.key)} onChange={() => toggle(keys, setKeys, m.key)} />
                    <span>{m.label}</span>
                    <span className="text-muted">
                      · {GRAN[m.granularity]}, {m.unit}
                    </span>
                  </label>
                ))}
              </div>
              {company.metrics.some((m) => m.granularity === "day" && keys.includes(m.key)) && (
                <label className="mt-3 flex items-start gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={acceptMonthly}
                    onChange={(e) => setAcceptMonthly(e.target.checked)}
                    className="mt-0.5"
                    aria-label="Accept monthly totals for daily numbers"
                  />
                  <span>
                    <span className="font-medium">Accept monthly totals for daily numbers</span>
                    <span className="block text-muted">
                      When some days are missing, a month total (or month average for % numbers) entered on the Numbers grid or the report is enough.
                      Complete days always win. Off: every day of the month is needed.
                    </span>
                  </span>
                </label>
              )}
            </fieldset>
          )}

          {stepName === "Schedule" && (
            <div className="flex flex-col gap-3">
              <label className="text-[13px]">
                <span className="label">Runs monthly on day (for the month that just finished)</span>
                <input className="input w-24" inputMode="numeric" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Day of the month" />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-[13px]">
                  <span className="label">Warn when a number moves by (%)</span>
                  <input className="input" inputMode="numeric" value={changePct} onChange={(e) => setChangePct(e.target.value)} aria-label="Warning threshold %" />
                </label>
                <label className="text-[13px]">
                  <span className="label">Risk when it moves by (%)</span>
                  <input className="input" inputMode="numeric" value={riskPct} onChange={(e) => setRiskPct(e.target.value)} aria-label="Risk threshold %" />
                </label>
              </div>
              <p className="text-[12px] text-muted">Compared with the month before and with the 3-month average.</p>
            </div>
          )}

          {stepName === "Who hears from it" && (
            <div className="flex flex-col gap-4">
              <fieldset>
                <legend className="label">{org ? "Who gets its Monday line" : "Who gets the “report ready” message"}</legend>
                {founders.map((f) => (
                  <label key={f.id} className="mr-4 inline-flex items-center gap-1.5 text-[13px]">
                    <input type="checkbox" checked={recipients.includes(f.id)} onChange={() => toggle(recipients, setRecipients, f.id)} aria-label={`Reports to ${f.shortName}`} />
                    {f.shortName}
                  </label>
                ))}
              </fieldset>
              {!org && (
              <fieldset>
                <legend className="label">Whom it asks for missing numbers</legend>
                {founders.map((f) => (
                  <label key={f.id} className="mr-4 inline-flex items-center gap-1.5 text-[13px]">
                    <input type="checkbox" checked={askIds.includes(f.id)} onChange={() => toggle(askIds, setAskIds, f.id)} aria-label={`Asks ${f.shortName}`} />
                    {f.shortName}
                  </label>
                ))}
                <p className="mt-1 text-[12px] text-muted">Founders only — it never messages anyone else. Requests go inside the morning summary.</p>
              </fieldset>
              )}
              <label className="text-[13px]">
                <span className="label">Notes (optional)</span>
                <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </label>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-line px-4 py-3">
          {(problem || state.error) && (
            <p className="min-w-0 flex-1 text-[12px] text-risk" role="status">
              {state.error ?? problem}
            </p>
          )}
          <div className="ml-auto flex gap-2">
            {step > (tuning ? 1 : 0) && (
              <button type="button" className="btn" onClick={() => setStep(step - 1)} disabled={pending}>
                Back
              </button>
            )}
            {step < STEPS.length - 1 ? (
              <button type="button" className="btn btn-primary" onClick={() => setStep(step + 1)} disabled={!!problem}>
                Next
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={submit} disabled={!!problem || pending}>
                {tuning ? "Save" : `Hire ${target.roleName}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
