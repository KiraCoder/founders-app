import Link from "next/link";
import { Section, Tag, type Tone } from "@/components/ui";
import { formatDisplayDate, isBefore, type IsoDate } from "@/lib/dates";
import { dec, formatDec } from "@/lib/decimal";
import {
  boardByStage,
  canManageClientProjects,
  clientProjectTotals,
  isActiveStage,
  listClientProjects,
  PIPELINE_STAGES,
  STAGE_LABELS,
  STATUS_LABELS,
  type ClientProjectStatus,
  type ClientProjectView,
} from "@/server/services/client-projects";
import type { ServiceContext } from "@/server/services/context";
import { CLIENT_PROJECT_STAGES, CLIENT_PROJECT_STATUSES } from "@/server/db/schema";
import { ArchiveClientProjectButton, ClientProjectForm } from "./ClientProjectForm";

const STATUS_TONE: Record<ClientProjectStatus, Tone> = { on_track: "ok", at_risk: "warn", late: "risk" };
const STAGES = CLIENT_PROJECT_STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s] }));
const STATUSES = CLIENT_PROJECT_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }));

const fee = (p: ClientProjectView) => (p.slaMonthlyFee === null ? "—" : formatDec(dec(p.slaMonthlyFee), p.slaCurrency));

function StatusTag({ status }: { status: ClientProjectStatus }) {
  return <Tag tone={STATUS_TONE[status]}>{STATUS_LABELS[status]}</Tag>;
}

/** Jobutify: client projects by stage, list with status / due / SLA fee / next invoice, totals. */
export async function ItServicesDashboard({
  ctx,
  company,
  today,
  showArchived,
}: {
  ctx: ServiceContext;
  company: { id: string; slug: string; name: string };
  today: IsoDate;
  showArchived: boolean;
}) {
  if (!canManageClientProjects(ctx)) {
    return <div className="card mb-6 px-4 py-6 text-center text-[13px] text-muted">Only the founders can see client projects.</div>;
  }
  const all = await listClientProjects(ctx, company.id, { includeArchived: showArchived });
  const live = all.filter((p) => !p.archived);
  const totals = clientProjectTotals(live);
  const columns = boardByStage(live);
  const pipeline = columns.filter((c) => PIPELINE_STAGES.includes(c.stage));
  const parked = columns.filter((c) => !PIPELINE_STAGES.includes(c.stage) && c.items.length > 0);
  const archivedHref = `/companies/${company.slug}${showArchived ? "" : "?archived=1"}`;

  return (
    <div data-testid="dashboard-it-services">
      <Section title="Client projects">
        <div className="grid gap-3 sm:grid-cols-3" data-testid="client-totals">
          <div className="card border-t-4 border-t-(color:--kind-accent) p-4">
            <p className="eyebrow">Active projects</p>
            <p className="num mt-1 text-[22px] font-semibold" data-testid="total-active">
              {totals.active}
            </p>
          </div>
          <div className="card border-t-4 border-t-(color:--kind-accent) p-4">
            <p className="eyebrow">Monthly SLA revenue</p>
            {totals.monthlySla.length === 0 ? (
              <p className="num mt-1 text-[22px] font-semibold text-muted">—</p>
            ) : (
              <ul className="mt-1" data-testid="total-sla">
                {totals.monthlySla.map((t) => (
                  <li key={t.currency} className="num text-[20px] font-semibold leading-7">
                    {formatDec(dec(t.amount), t.currency)}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] text-muted">Projects in Live · SLA</p>
          </div>
          <div className={`card border-t-4 p-4 ${totals.atRisk + totals.late > 0 ? "border-t-warn" : "border-t-(color:--kind-accent)"}`}>
            <p className="eyebrow">At risk</p>
            <p className={`num mt-1 text-[22px] font-semibold ${totals.atRisk + totals.late > 0 ? "text-warn" : ""}`} data-testid="total-at-risk">
              {totals.atRisk}
            </p>
            {totals.late > 0 && <p className="text-[11px] text-risk">{totals.late} late</p>}
          </div>
        </div>
      </Section>

      <Section title="Board">
        <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-2" data-testid="client-board">
          {pipeline.map((col) => (
            <div key={col.stage} className="w-[220px] shrink-0 rounded-[12px] bg-sunk p-2" data-stage={col.stage}>
              <p className="mb-2 flex items-center justify-between px-1 text-[12px] font-semibold">
                <span className="text-(color:--kind-accent)">{col.label}</span>
                <span className="num text-muted">{col.items.length}</span>
              </p>
              <ul className="flex flex-col gap-2">
                {col.items.map((p) => (
                  <li key={p.id} className="card p-2.5 text-[13px]">
                    <p className="font-medium leading-5">{p.clientName}</p>
                    <p className="text-[12px] text-muted">{p.title}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <StatusTag status={p.status} />
                      {p.dueDate && (
                        <span className={`text-[11px] ${isBefore(p.dueDate, today) && isActiveStage(p.stage) ? "text-risk" : "text-muted"}`}>
                          due {formatDisplayDate(p.dueDate)}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
                {col.items.length === 0 && <li className="px-1 py-2 text-[12px] text-muted">—</li>}
              </ul>
            </div>
          ))}
        </div>
        {parked.length > 0 && (
          <p className="mt-2 flex flex-wrap gap-2 text-[12px] text-muted">
            {parked.map((c) => (
              <span key={c.stage} className="tag">
                {c.label}: <span className="num">{c.items.length}</span>
              </span>
            ))}
          </p>
        )}
      </Section>

      <Section
        title="All client projects"
        count={live.length}
        action={
          <Link href={archivedHref} className="text-[12px] text-accent hover:underline">
            {showArchived ? "Hide archived" : "Show archived"}
          </Link>
        }
      >
        <div className="mb-3">
          <ClientProjectForm companyId={company.id} stages={STAGES} statuses={STATUSES} />
        </div>
        {all.length === 0 ? (
          <div className="card px-4 py-6 text-center text-[13px] text-muted">No client projects yet.</div>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-[13px]" data-testid="client-list">
              <thead className="text-[11px] uppercase tracking-wide text-muted">
                <tr className="border-b border-line">
                  <th className="px-3 py-2 font-medium">Client · project</th>
                  <th className="px-3 py-2 font-medium">Stage</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Due</th>
                  <th className="px-3 py-2 text-right font-medium">SLA fee / month</th>
                  <th className="px-3 py-2 font-medium">Next invoice</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {all.map((p) => (
                  <tr key={p.id} className={p.archived ? "opacity-60" : ""}>
                    <td className="px-3 py-2">
                      <span className="font-medium">{p.clientName}</span> <span className="text-muted">· {p.title}</span>
                      {p.archived && (
                        <>
                          {" "}
                          <Tag>Archived</Tag>
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2">{STAGE_LABELS[p.stage]}</td>
                    <td className="px-3 py-2">
                      <StatusTag status={p.status} />
                    </td>
                    <td className={`num px-3 py-2 ${p.dueDate && isBefore(p.dueDate, today) && isActiveStage(p.stage) ? "text-risk" : ""}`}>
                      {formatDisplayDate(p.dueDate) || "—"}
                    </td>
                    <td className="num px-3 py-2 text-right">{fee(p)}</td>
                    <td className="num px-3 py-2">{formatDisplayDate(p.nextInvoiceDate) || "—"}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-start justify-end gap-1">
                        {!p.archived && <ClientProjectForm companyId={company.id} initial={p} stages={STAGES} statuses={STATUSES} />}
                        <ArchiveClientProjectButton companyId={company.id} id={p.id} archived={p.archived} label={`${p.clientName} · ${p.title}`} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
