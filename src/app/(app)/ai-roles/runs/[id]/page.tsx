import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RunStatusTag } from "@/components/ai-roles/AiRolesBoard";
import { CreateTaskButton, RerunButton } from "@/components/ai-roles/RunActions";
import { CompanyDot, PageHeader, Section } from "@/components/ui";
import { monthLabel } from "@/lib/ai-roles";
import { SEVERITY_LABELS, SEVERITY_ORDER, type Severity } from "@/server/ai/finance-rules";
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
        actions={run.hire.status === "active" ? <RerunButton runId={run.id} label={analysed ? "Run again" : "Check numbers again"} /> : undefined}
      >
        <p className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-muted">
          <RunStatusTag status={run.status} /> <span data-testid="run-summary">{run.summary}</span>
          {run.analysedAt && <span>· analysed {new Date(run.analysedAt).toLocaleString("ru-RU", { timeZone: "Asia/Bishkek" })}</span>}
          <span>· {run.trigger === "manual" ? "run by hand" : "scheduled"}</span>
        </p>
      </PageHeader>

      {run.inputsChanged && (
        <div className="card mb-4 flex flex-wrap items-center gap-2 border-warn-line bg-warn-soft px-4 py-3 text-[13px]">
          <span className="tag tag-warn">Numbers changed</span>
          <span>Some numbers of {run.periodLabel} were corrected after this report. Run it again to update the findings (no new message is sent).</span>
        </div>
      )}

      {run.status === "waiting_for_data" && (
        <Section title="Waiting for these numbers" count={run.missing.length} tone="warn">
          <div className="card divide-y divide-line">
            {run.missing.map((m) => (
              <div key={m.metricId} className="flex items-center gap-2 px-4 py-2 text-[13px]">
                <span className="font-medium">{m.label}</span>
                <span className="text-muted">· {m.detail}</span>
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
        <div className="card mb-4 px-4 py-3 text-[13px]">
          <span className="tag tag-risk">Failed</span> <span className="text-muted">{run.error ?? "Unexpected error"} — it is retried on the next scheduler run.</span>
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
                <p className="whitespace-pre-wrap">{run.narrative}</p>
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
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[12px] text-muted">
                Monthly totals; a daily number counts only when every day of the month is in (— = incomplete or no value). Exact to the tyiyn.
              </p>
            </Section>
          )}
        </>
      )}
    </>
  );
}
