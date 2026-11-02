"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { saveActAction, type HoldingActionState } from "@/app/(app)/holding/actions";
import { ACT_STATUS_LABELS, ACT_STATUSES, CELL_STATE_LABELS, monthShort, type ActStatusValue, type CellState, type CellTone } from "@/lib/holding";
import { formatMoney } from "@/lib/money";
import type { ActCell, ActsGrid as Grid } from "@/server/services/holding";
import { ACCEPT, fileUrl, uploadHoldingFile } from "./upload";

const TONE_CLASS: Record<CellTone, string> = {
  ok: "bg-accent-soft text-accent border-transparent",
  warn: "bg-warn-soft text-warn border-warn-line",
  risk: "bg-risk-soft text-risk border-risk-line",
  grey: "bg-sunk text-muted border-transparent",
  upcoming: "bg-surface text-muted border-dashed border-line",
};

const SHORT: Record<CellState, string> = {
  signed: "Signed",
  received: "Received",
  requested: "Asked",
  missing: "Missing",
  not_needed: "n/a",
  before_start: "",
  after_end: "",
  not_due: "Not due",
  inactive: "",
};

function dayMonth(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${monthShort(iso)}`;
}

export function ActsGrid({ grid }: { grid: Grid }) {
  const [open, setOpen] = useState<{ flowLabel: string; cell: ActCell } | null>(null);
  const year = grid.today.slice(0, 4);
  if (!grid.rows.length) {
    return (
      <div className="card px-4 py-6 text-center text-[13px] text-muted">
        No active flows yet. Add one below (who does what for whom, and since when).
      </div>
    );
  }
  return (
    <>
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[900px] border-separate border-spacing-0 text-[12px]" data-testid="acts-grid">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-surface px-3 py-2 text-left font-medium text-muted">Flow</th>
              {grid.months.map((m) => (
                <th key={m.period} className={`px-1 py-2 text-center font-medium ${m.current ? "text-ink" : "text-muted"}`} scope="col">
                  {monthShort(m.period, year)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row) => {
              const label = `${row.flow.label} · ${row.flow.service}`;
              return (
                <tr key={row.flow.id} data-flow={row.flow.label}>
                  <th scope="row" className="sticky left-0 z-10 max-w-[240px] border-t border-line bg-surface px-3 py-1.5 text-left font-medium">
                    <span className="block truncate" title={label}>
                      {row.flow.label}
                    </span>
                    <span className="block truncate text-[11px] font-normal text-muted">
                      {row.flow.service}
                      {!row.flow.since && " · set the start date"}
                    </span>
                  </th>
                  {row.cells.map((c) => {
                    const clickable = c.state !== "before_start" && c.state !== "after_end" && c.state !== "inactive";
                    const title = `${label}, ${monthShort(c.period, "")} ${c.period.slice(0, 4)}: ${CELL_STATE_LABELS[c.state]}${
                      c.state === "not_due" ? ` (expected from ${dayMonth(c.dueFrom)})` : ""
                    }${c.requestedOn ? ` · asked ${dayMonth(c.requestedOn)}${c.requestedBy ? ` by ${c.requestedBy}` : ""}` : ""}${
                      c.amount != null ? ` · ${formatMoney(c.amount)}` : ""
                    }`;
                    return (
                      <td key={c.period} className="border-t border-line px-0.5 py-1">
                        <button
                          type="button"
                          disabled={!clickable}
                          onClick={() => setOpen({ flowLabel: label, cell: c })}
                          className={`flex h-9 w-full min-w-[54px] flex-col items-center justify-center rounded-[6px] border text-[11px] leading-tight ${TONE_CLASS[c.tone]} ${
                            clickable ? "cursor-pointer hover:brightness-95" : "cursor-default"
                          }`}
                          data-testid="act-cell"
                          data-cell-state={c.state}
                          data-period={c.period}
                          aria-label={title}
                          title={title}
                        >
                          <span className="font-medium">{SHORT[c.state]}</span>
                          {c.attachment && <span aria-hidden="true">📎</span>}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Legend grace={grid.graceDays} />
      {open && <CellPanel key={`${open.cell.flowId}|${open.cell.period}`} flowLabel={open.flowLabel} cell={open.cell} today={grid.today} onClose={() => setOpen(null)} />}
    </>
  );
}

function Legend({ grace }: { grace: number }) {
  const item = (tone: CellTone, text: string) => (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-3 w-3 rounded-[3px] border ${TONE_CLASS[tone]}`} aria-hidden="true" />
      {text}
    </span>
  );
  return (
    <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-muted">
      {item("ok", "Signed / received")}
      {item("warn", "Asked Elmurat")}
      {item("risk", "Missing")}
      {item("grey", "Not needed / before the flow started")}
      {item("upcoming", `Not due yet (a month is due ${grace} days after it ends)`)}
    </p>
  );
}

function CellPanel({ flowLabel, cell, today, onClose }: { flowLabel: string; cell: ActCell; today: string; onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [status, setStatus] = useState<ActStatusValue>(cell.status ?? "missing");
  const [amount, setAmount] = useState(cell.amount != null ? String(cell.amount) : "");
  const [actNumber, setActNumber] = useState(cell.actNumber ?? "");
  const [actDate, setActDate] = useState(cell.actDate ?? "");
  const [requestedOn, setRequestedOn] = useState(cell.requestedOn ?? today);
  const [note, setNote] = useState(cell.note ?? "");
  const [attachment, setAttachment] = useState(cell.attachment ? { id: cell.attachment.id, name: cell.attachment.name } : null);
  const [uploading, setUploading] = useState(false);
  const [state, setState] = useState<HoldingActionState>({});
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const month = `${monthShort(cell.period)} ${cell.period.slice(0, 4)}`;
  const err = (k: string) => state.fieldErrors?.[k]?.[0];

  const save = () =>
    start(async () => {
      const res = await saveActAction({
        flowId: cell.flowId,
        period: cell.period.slice(0, 7),
        status,
        amount: amount.trim() === "" ? null : amount,
        actNumber: actNumber.trim() || null,
        actDate: actDate || null,
        ...(status === "requested" ? { requestedOn: requestedOn || null } : {}),
        note: note.trim() || null,
        attachmentFileId: attachment?.id ?? null,
      });
      setState(res);
      if (res.ok) {
        router.refresh();
        onClose();
      }
    });

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Акт: ${flowLabel}, ${month}`}
        className="card-raised flex h-full w-full max-w-[400px] flex-col gap-3 overflow-y-auto rounded-none p-4 sm:rounded-l-[12px]"
        onClick={(e) => e.stopPropagation()}
        data-testid="act-panel"
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="eyebrow">Акт приёма-передачи · {month}</p>
            <h2 className="text-[15px] font-semibold">{flowLabel}</h2>
            <p className="text-[12px] text-muted">
              {CELL_STATE_LABELS[cell.state]}
              {cell.requestedOn && ` · asked ${dayMonth(cell.requestedOn)}${cell.requestedBy ? ` by ${cell.requestedBy}` : ""}`}
            </p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <fieldset>
          <legend className="label">Status</legend>
          <div className="grid grid-cols-2 gap-1.5">
            {ACT_STATUSES.map((s) => (
              <label
                key={s}
                className={`flex cursor-pointer items-center gap-2 rounded-[8px] border px-2.5 py-2 text-[13px] ${status === s ? "border-accent bg-accent-soft" : "border-line"}`}
              >
                <input type="radio" name="act-status" value={s} checked={status === s} onChange={() => setStatus(s)} ref={s === "missing" ? first : undefined} />
                {s === "requested" ? "Requested (asked Elmurat)" : ACT_STATUS_LABELS[s]}
              </label>
            ))}
          </div>
        </fieldset>

        {status === "requested" && (
          <div>
            <label className="label" htmlFor="act-requested-on">
              Asked Elmurat on
            </label>
            <input id="act-requested-on" type="date" className="input" value={requestedOn} max={today} onChange={(e) => setRequestedOn(e.target.value)} />
            {err("requestedOn") && <p className="mt-1 text-[12px] text-risk">{err("requestedOn")}</p>}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label" htmlFor="act-amount">
              Amount (KGS, optional)
            </label>
            <input id="act-amount" className="input num" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} />
            {err("amount") && <p className="mt-1 text-[12px] text-risk">{err("amount")}</p>}
          </div>
          <div>
            <label className="label" htmlFor="act-number">
              Act number
            </label>
            <input id="act-number" className="input" maxLength={60} value={actNumber} onChange={(e) => setActNumber(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="act-date">
              Act date
            </label>
            <input id="act-date" type="date" className="input" max={today} value={actDate} onChange={(e) => setActDate(e.target.value)} />
            {err("actDate") && <p className="mt-1 text-[12px] text-risk">{err("actDate")}</p>}
          </div>
        </div>
        <p className="-mt-1 text-[11.5px] text-muted">The amount counts as owed once the акт is received or signed.</p>

        <div>
          <label className="label" htmlFor="act-note">
            Note
          </label>
          <textarea id="act-note" className="input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>

        <div>
          <p className="label">Scan of the акт (optional, PDF/JPG/PNG, max 10 MB)</p>
          {attachment ? (
            <div className="flex items-center gap-2 text-[13px]">
              <a className="truncate text-accent underline" href={fileUrl(attachment.id)} target="_blank" rel="noreferrer">
                {attachment.name}
              </a>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAttachment(null)}>
                Remove
              </button>
            </div>
          ) : (
            <input
              type="file"
              accept={ACCEPT}
              aria-label="Attach a scan"
              className="text-[13px]"
              disabled={uploading}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                setUploading(true);
                const r = await uploadHoldingFile(f);
                setUploading(false);
                if ("error" in r) setState({ ok: false, error: r.error });
                else setAttachment(r);
                e.target.value = "";
              }}
            />
          )}
          {uploading && <p className="text-[12px] text-muted">Uploading…</p>}
        </div>

        {state.error && (
          <p className="text-[12px] text-risk" role="alert">
            {state.error}
          </p>
        )}
        <div className="mt-auto flex gap-2 pt-2">
          <button type="button" className="btn btn-primary" onClick={save} disabled={pending || uploading}>
            {pending ? "Saving…" : "Save"}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </aside>
    </div>
  );
}
