"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { archiveFlowAction, createFlowAction, saveActAction, updateFlowAction, type HoldingActionState } from "@/app/(app)/holding/actions";
import { ACT_STATUS_LABELS, monthLong, type ActStatusValue } from "@/lib/holding";
import { formatMoney } from "@/lib/money";
import type { ArchivedFlowAct, FlowView } from "@/server/services/holding";
import { CompanyDot, Tag } from "@/components/ui";

type Company = { id: string; name: string };

/** Who does what for whom since when: add / edit / archive (never deleted). */
export function FlowsSection({ flows, companies, archivedActs = [] }: { flows: FlowView[]; companies: Company[]; archivedActs?: ArchivedFlowAct[] }) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [actsOpen, setActsOpen] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const router = useRouter();
  const [pending, start] = useTransition();
  const visible = flows.filter((f) => showArchived || !f.archived);
  const archivedCount = flows.filter((f) => f.archived).length;
  return (
    <div className="flex flex-col gap-2">
      <ul className="card divide-y divide-line" data-testid="flows-list">
        {visible.map((f) =>
          editing === f.id ? (
            <li key={f.id} className="p-3">
              <FlowForm flow={f} companies={companies} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <li key={f.id} className={`flex flex-wrap items-center gap-2 px-4 py-2.5 text-[13px] ${f.archived ? "opacity-60" : ""}`}>
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <CompanyDot color={f.from.color} />
                <span className="font-medium">{f.from.name}</span>
                <span className="text-muted">→</span>
                <CompanyDot color={f.to.color} />
                <span className="font-medium">{f.to.name}</span>
                <span className="truncate text-muted">· {f.service}</span>
              </span>
              <span className="text-[12px] text-muted">
                {f.since ? `since ${monthLong(f.since.slice(0, 7) + "-01")}` : f.status === "active" ? "" : "no start date"}
                {f.until ? ` · until ${f.until}` : ""}
              </span>
              {f.status === "active" && !f.since && !f.archived && <Tag tone="warn">Set the start date</Tag>}
              {f.archived ? <Tag>Archived</Tag> : <Tag tone={f.status === "active" ? "ok" : "info"}>{f.status === "active" ? "Active" : "Planned"}</Tag>}
              {f.archived && archivedActs.some((a) => a.flowId === f.id) && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setActsOpen((v) => (v === f.id ? null : f.id))}
                  aria-expanded={actsOpen === f.id}
                >
                  {actsOpen === f.id ? "Hide акты" : `Correct акты (${archivedActs.filter((a) => a.flowId === f.id).length})`}
                </button>
              )}
              {f.archived ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      await archiveFlowAction(f.id, true);
                      router.refresh();
                    })
                  }
                >
                  Restore
                </button>
              ) : (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(f.id)} aria-label={`Edit ${f.fullLabel}`}>
                  Edit
                </button>
              )}
              {actsOpen === f.id && <ArchivedActs acts={archivedActs.filter((a) => a.flowId === f.id)} />}
            </li>
          ),
        )}
      </ul>
      {editing === "new" ? (
        <div className="card p-3">
          <FlowForm flow={null} companies={companies} onDone={() => setEditing(null)} />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-sm" onClick={() => setEditing("new")}>
            Add flow
          </button>
          {archivedCount > 0 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function FlowForm({ flow, companies, onDone }: { flow: FlowView | null; companies: Company[]; onDone: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [state, setState] = useState<HoldingActionState>({});
  const err = (k: string) => state.fieldErrors?.[k]?.[0];
  const submit = (fd: FormData) =>
    start(async () => {
      const common = {
        service: String(fd.get("service") ?? ""),
        description: String(fd.get("description") ?? ""),
        since: String(fd.get("since") ?? ""),
        until: String(fd.get("until") ?? ""),
        status: String(fd.get("status") ?? "active") as "active" | "planned",
      };
      const res = flow
        ? await updateFlowAction(flow.id, { ...common, since: common.since || null, until: common.until || null })
        : await createFlowAction({ ...common, fromCompanyId: String(fd.get("fromCompanyId") ?? ""), toCompanyId: String(fd.get("toCompanyId") ?? "") });
      setState(res);
      if (res.ok) {
        router.refresh();
        onDone();
      }
    });
  return (
    <form action={submit} className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label={flow ? `Edit ${flow.fullLabel}` : "Add flow"}>
      {flow ? (
        <p className="text-[13px] font-medium sm:col-span-2">{flow.label}</p>
      ) : (
        <>
          <div>
            <label className="label" htmlFor="fl-from">
              From (provides the service)
            </label>
            <select id="fl-from" name="fromCompanyId" className="input" required defaultValue="">
              <option value="" disabled>
                Choose…
              </option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {err("fromCompanyId") && <p className="mt-1 text-[12px] text-risk">{err("fromCompanyId")}</p>}
          </div>
          <div>
            <label className="label" htmlFor="fl-to">
              To (receives it)
            </label>
            <select id="fl-to" name="toCompanyId" className="input" required defaultValue="">
              <option value="" disabled>
                Choose…
              </option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {err("toCompanyId") && <p className="mt-1 text-[12px] text-risk">{err("toCompanyId")}</p>}
          </div>
        </>
      )}
      <div>
        <label className="label" htmlFor="fl-service">
          Service (short, e.g. пошив)
        </label>
        <input id="fl-service" name="service" className="input" required maxLength={60} defaultValue={flow?.service ?? ""} />
        {err("service") && <p className="mt-1 text-[12px] text-risk">{err("service")}</p>}
      </div>
      <div>
        <label className="label" htmlFor="fl-status">
          Status
        </label>
        <select id="fl-status" name="status" className="input" defaultValue={flow?.status ?? "active"}>
          <option value="active">Active (акты expected monthly)</option>
          <option value="planned">Planned (no акты yet)</option>
        </select>
      </div>
      <div>
        <label className="label" htmlFor="fl-since">
          Since (first month with an акт)
        </label>
        <input id="fl-since" name="since" type="date" className="input" defaultValue={flow?.since ?? ""} />
        {err("since") && <p className="mt-1 text-[12px] text-risk">{err("since")}</p>}
      </div>
      <div>
        <label className="label" htmlFor="fl-until">
          Until (optional)
        </label>
        <input id="fl-until" name="until" type="date" className="input" defaultValue={flow?.until ?? ""} />
        {err("until") && <p className="mt-1 text-[12px] text-risk">{err("until")}</p>}
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="fl-desc">
          Description
        </label>
        <input id="fl-desc" name="description" className="input" maxLength={500} defaultValue={flow?.description ?? ""} />
      </div>
      {state.error && (
        <p className="text-[12px] text-risk sm:col-span-2" role="alert">
          {state.error}
        </p>
      )}
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn btn-sm" onClick={onDone}>
          Cancel
        </button>
        {flow && (
          <button
            type="button"
            className="btn btn-ghost btn-sm ml-auto"
            disabled={pending}
            onClick={() =>
              start(async () => {
                if (!window.confirm("Archive this flow? It leaves the grid; its акты and договоры are kept.")) return;
                const res = await archiveFlowAction(flow.id);
                setState(res);
                if (res.ok) {
                  router.refresh();
                  onDone();
                }
              })
            }
          >
            Archive
          </button>
        )}
      </div>
    </form>
  );
}

const CORRECTABLE: ActStatusValue[] = ["received", "signed", "not_needed", "missing"];

/**
 * An archived flow's recorded акты: they still count in the debts, so their status, amount
 * and act date stay correctable (everything else needs the flow restored).
 */
function ArchivedActs({ acts }: { acts: ArchivedFlowAct[] }) {
  return (
    <div className="mt-2 w-full basis-full rounded-[8px] bg-sunk p-2" data-testid="archived-acts">
      <p className="mb-1.5 text-[12px] text-muted">This flow is archived, but its акты still count in the debts. Correct a wrong status or amount here.</p>
      <ul className="flex flex-col gap-1.5">
        {acts.map((a) => (
          <ArchivedActRow key={a.period} act={a} />
        ))}
      </ul>
    </div>
  );
}

function ArchivedActRow({ act }: { act: ArchivedFlowAct }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [status, setStatus] = useState<ActStatusValue>(act.status);
  const [amount, setAmount] = useState(act.amount != null ? String(act.amount) : "");
  const [state, setState] = useState<HoldingActionState>({});
  const id = `aa-${act.flowId}-${act.period}`;
  return (
    <li className="flex flex-wrap items-center gap-2 text-[12.5px]">
      <span className="w-[86px] font-medium">{monthLong(act.period)}</span>
      <label className="sr-only" htmlFor={`${id}-status`}>
        Status for {monthLong(act.period)}
      </label>
      <select id={`${id}-status`} className="input h-8 w-auto py-0" value={status} onChange={(e) => setStatus(e.target.value as ActStatusValue)}>
        {[...new Set([act.status, ...CORRECTABLE])].map((s) => (
          <option key={s} value={s}>
            {ACT_STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      <label className="sr-only" htmlFor={`${id}-amount`}>
        Amount for {monthLong(act.period)}
      </label>
      <input id={`${id}-amount`} className="input h-8 w-[140px] py-0" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount, KGS" />
      <button
        type="button"
        className="btn btn-sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await saveActAction({ flowId: act.flowId, period: act.period.slice(0, 7), status, amount: amount.trim() === "" ? null : amount });
            setState(res);
            if (res.ok) router.refresh();
          })
        }
      >
        {pending ? "Saving…" : "Save"}
      </button>
      {act.amount != null && <span className="text-muted">was {formatMoney(act.amount)}</span>}
      {state.error && (
        <span className="text-risk" role="alert">
          {state.error}
        </span>
      )}
      {state.ok && <span className="text-accent">Saved.</span>}
    </li>
  );
}
