import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RunStatusTag } from "@/components/ai-roles/AiRolesBoard";
import { CreateTaskButton, MonthTotalForm, RerunButton } from "@/components/ai-roles/RunActions";
import { CompanyDot, PageHeader, Section } from "@/components/ui";
import { monthLabel, monthName } from "@/lib/ai-roles";
import { SEVERITY_LABELS, SEVERITY_ORDER, type Severity } from "@/server/ai/finance-rules";
import { formatDisplayDateTime } from "@/lib/dates";
import { formatDec, dec } from "@/lib/decimal";
import { getPageContext } from "@/server/context";
import { getRun, type RunView } from "@/server/services/ai-roles";
import { ServiceError } from "@/server/services/errors";

type Props = { params: Promise<{ id: string }> };

async function load(id: string): Promise<RunView> {
  const ctx = await getPageContext();
  try {
    return await getRun(ctx, id);
  } catch (err) {
    if (err instanceof ServiceError && (err.code === "not_found" || err.code === "forbidden")) notFound();
    throw err;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  try {
    const run = await getRun(await getPageContext(), id);
    return { title: `${run.hire.roleName} · ${run.hire.companyName} · ${run.periodLabel}` };
  } catch {
    return { title: "AI report" };
  }
}

const TONE: Record<Severity, string> = { risk: "tag-risk", warn: "tag-warn", info: "tag-info" };
const SECTION_TITLE: Record<Severity, string> = { risk: "Risks", warn: "Warnings", info: "Info" };

export default async function RunPage({ params }: Props) {
  const { id } = await params;
  const run = await load(id);
  const timeZone = (await getPageContext()).timeZone;
  const analysed = run.status === "reported" || run.status === "analysed";
  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/ai-roles" className="hover:underline">
            AI roles
          </Link>
        }
        title={
          <span className="flex items-center gap-2.5">
            <CompanyDot color={run.hire.companyColor} size={12} /> {run.hire.roleName} · {run.hire.companyName} · {run.periodLabel}
          </span>
        }
        actions={
          run.hire.status === "active" ? (
            <RerunButton runId={run.id} label={analysed ? "Run again" : run.status === "failed" ? "Retry" : "Check numbers again"} />
          ) : undefined
        }
      >
        <p className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-muted">
          <RunStatusTag status={run.status} /> <span data-testid="run-summary">{run.summary}</span>
          {run.analysedAt && <span>· analysed {formatDisplayDateTime(run.analysedAt, timeZone)}</span>}
          <span>· {run.trigger === "manual" ? "run by hand" : "scheduled"}</span>
        </p>
      </PageHeader>

      {run.inputsChanged && (
        <div className="card mb-4 flex flex-wrap items-center gap-2 border-warn-line bg-warn-soft px-4 py-3 text-[13px]">
          <span className="tag tag-warn" data-testid="numbers-changed">Numbers changed</span>
          <span>Some numbers of {run.periodLabel} were corrected after this report. Run it again to update the findings (no new message is sent).</span>
        </div>
      )}

      {run.settingsChanged && (
        <div className="card mb-4 flex flex-wrap items-center gap-2 border-line bg-info-soft px-4 py-3 text-[13px]" data-testid="settings-changed">
          <span className="tag tag-info">Settings changed</span>
          <span>
            The role was tuned after this report (numbers it waits for or thresholds). The numbers are the same — run it again to see the findings with the new
            settings (no new message is sent).
          </span>
        </div>
      )}

      {run.status === "waiting_for_data" && (
        <Section title="Waiting for these numbers" count={run.missing.length} tone="warn">
          <div className="card divide-y divide-line">
            {run.missing.map((m) => (
              <div key={m.metricId} className="flex flex-wrap items-center gap-2 px-4 py-2 text-[13px]">
                <span className="font-medium">{m.label}</span>
                <span className="text-muted">· {m.detail}</span>
                {run.monthTotalEntry[m.metricId] && run.hire.status === "active" && (
                  <span className="ml-auto">
                    <MonthTotalForm
                      runId={run.id}
                      metricId={m.metricId}
                      label={m.label}
                      kind={run.monthTotalEntry[m.metricId]!}
                      monthName={monthName(run.period)}
                    />
                  </span>
                )}
                {run.missingFromHolding.includes(m.metricId) && (
                  <span className="text-muted">
                    · computed from the{" "}
                    <Link href="/holding" className="text-accent hover:underline">
                      Holding акты
                    </Link>{" "}
                    — no need to enter it
                  </span>
                )}
              </div>
            ))}
          </div>
          <p className="mt-2 flex gap-3 text-[13px]">
            <Link href={run.numbersHref} className="text-accent hover:underline">
              Enter them in the Numbers grid
            </Link>
            <Link href={`/companies/${run.hire.companySlug}/numbers/import`} className="text-accent hover:underline">
              or upload a file
            </Link>
          </p>
        </Section>
      )}

      {run.status === "failed" && (
        <div className="card mb-4 flex flex-wrap items-center gap-2 px-4 py-3 text-[13px]" data-testid="run-failed">
          <span className="tag tag-risk">{run.gaveUp ? "Failed — Retry" : "Failed"}</span>
          <span className="text-muted">
            {run.error ?? "Unexpected error"} —{" "}
            {run.gaveUp
              ? `it failed ${run.attempts} times, so it is no longer retried automatically. Fix the cause (usually a number) and click Retry.`
              : `tried ${run.attempts} time${run.attempts === 1 ? "" : "s"}; retried automatically${run.nextAttemptAt ? ` after ${formatDisplayDateTime(run.nextAttemptAt, timeZone)}` : ""}.`}
          </span>
          {run.hire.status === "active" && <RerunButton runId={run.id} label="Retry" />}
        </div>
      )}

      {analysed && run.error && (
        <div className="card mb-4 flex flex-wrap items-center gap-2 border-warn-line bg-warn-soft px-4 py-3 text-[13px]" data-testid="rerun-failed">
          <span className="tag tag-warn">Update failed</span>
          <span>
            Re-analysing this month failed ({run.error}). This is the last good report{run.status === "analysed" ? "; it is retried automatically" : ""}.
          </span>
        </div>
      )}

      {analysed && (
        <>
          {run.findings.length === 0 && <div className="card mb-6 px-4 py-6 text-center text-[13px] text-muted">No findings: the month looks normal.</div>}
          {SEVERITY_ORDER.map((sev) => {
            const list = run.findings.filter((f) => f.severity === sev);
            if (!list.length) return null;
            return (
              <Section key={sev} title={SECTION_TITLE[sev]} count={list.length} tone={sev === "info" ? "info" : sev}>
                <div className="card divide-y divide-line" data-testid={`findings-${sev}`}>
                  {list.map((f) => (
                    <div key={f.id} className="flex flex-col gap-1.5 px-4 py-3" data-testid="finding">
                      <div className="flex flex-wrap items-start gap-2">
                        <span className={`tag ${TONE[f.severity]}`}>{SEVERITY_LABELS[f.severity]}</span>
                        <p className="min-w-0 flex-1 text-[13px]">{f.sentence}</p>
                        {f.severity === "risk" && <CreateTaskButton runId={run.id} findingId={f.id} taskId={f.taskId ?? null} />}
                      </div>
                      {f.numbers.length > 0 && (
                        <p className="text-[12px] text-muted">
                          {f.numbers.map((n) => (
                            <span key={n.label} className="mr-3 inline-block">
                              {n.label}: <span className="num text-ink">{n.value}</span>
                            </span>
                          ))}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </Section>
            );
          })}

          <Section title="AI summary">
            <div className="card px-4 py-3 text-[13px]" data-testid="ai-summary">
              {run.narrativeStatus === "narrative_done" && run.narrative ? (
                <>
                  <p className="whitespace-pre-wrap">{run.narrative}</p>
                  {run.narrativeOmitted > 0 && (
                    <p className="mt-2 text-[12px] text-muted">
                      {run.narrativeOmitted} finding{run.narrativeOmitted === 1 ? " is" : "s are"} about pay and {run.narrativeOmitted === 1 ? "was" : "were"} left out: pay data is never sent to the AI provider.
                    </p>
                  )}
                </>
              ) : run.narrativeStatus === "narrative_skipped:salary" ? (
                <p className="text-muted">No AI summary for this report: it would have included pay data, which is never sent to the AI provider. The findings above are complete without it.</p>
              ) : run.narrativeStatus === "narrative_failed" ? (
                <p className="text-muted">The AI summary could not be written this time. The findings above are complete without it.</p>
              ) : (
                <p className="text-muted">
                  <span className="tag tag-info mr-2">Not connected</span>
                  AI summary appears after the AI provider is chosen. The findings above are rule-based and complete.
                </p>
              )}
            </div>
          </Section>

          {run.inputs && (
            <Section title="Numbers used">
              <div className="card overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-left text-muted">
                      <th className="px-3 py-2 font-medium">Number</th>
                      {run.inputs.months.map((m) => (
                        <th key={m} className="px-3 py-2 text-right font-medium">
                          {monthLabel(m)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {run.inputs.metrics.map((m) => (
                      <tr key={m.metricId} className="border-b border-line last:border-0">
                        <td className="px-3 py-2">{m.label}</td>
                        {m.values.map((v, i) => (
                          <td key={i} className="num px-3 py-2 text-right">
                            {v === null ? <span className="text-muted">—</span> : formatDec(dec(v), m.unit)}
                            {v !== null && m.fromMonthTotal?.[i] && (
                              <span className="block text-[11px] font-normal text-muted" data-testid="month-total-mark">
                                {m.monthTotalMark ?? "(month total entered)"}
                              </span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[12px] text-muted">
                One value per month: a daily or weekly number is shown as its month total, average or end-of-month value (as labelled), and counts only when every
                day of the month is in (— = incomplete or no value)
                {run.hire.settings.acceptMonthlyTotals ? ", or — for a daily number with missing days — when a month total was entered (marked)" : ""}. Exact to
                the tyiyn.
              </p>
            </Section>
          )}
        </>
      )}
    </>
  );
}
