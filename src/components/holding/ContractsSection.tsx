"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { archiveContractAction, saveContractAction, type HoldingActionState } from "@/app/(app)/holding/actions";
import { CONTRACT_STATUS_LABELS, CONTRACT_STATUSES, contractWarningText } from "@/lib/holding";
import type { ContractView, FlowView } from "@/server/services/holding";
import { Tag } from "@/components/ui";
import { ACCEPT, fileUrl, uploadHoldingFile } from "./upload";

/** Intercompany договоры: list with expiry warnings, add / edit / archive, optional scan. */
export function ContractsSection({ contracts, flows }: { contracts: ContractView[]; flows: FlowView[] }) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  return (
    <div className="flex flex-col gap-2">
      {contracts.length === 0 && editing !== "new" && (
        <div className="card px-4 py-4 text-center text-[13px] text-muted">No договоры yet.</div>
      )}
      {contracts.length > 0 && (
        <ul className="card divide-y divide-line" data-testid="contracts-list">
          {contracts.map((c) =>
            editing === c.id ? (
              <li key={c.id} className="p-3">
                <ContractForm contract={c} flows={flows} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <li key={c.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-[13px]">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">Договор {c.number}</span>
                  <span className="text-muted"> · {c.flow.fullLabel}</span>
                  <span className="block text-[12px] text-muted">
                    {c.signedOn ? `signed ${c.signedOn}` : "not signed yet"}
                    {c.validUntil ? ` · valid until ${c.validUntil}` : " · no end date"}
                    {c.amountTerms ? ` · ${c.amountTerms}` : ""}
                  </span>
                </span>
                {c.warning && <Tag tone={c.warning.kind === "overdue" ? "risk" : "warn"}>{contractWarningText(c.warning)}</Tag>}
                <Tag tone={c.status === "signed" ? "ok" : c.status === "draft" ? "info" : "neutral"}>{CONTRACT_STATUS_LABELS[c.status]}</Tag>
                {c.attachment && (
                  <a className="text-[12px] text-accent underline" href={fileUrl(c.attachment.id)} target="_blank" rel="noreferrer">
                    📎 {c.attachment.name}
                  </a>
                )}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(c.id)}>
                  Edit
                </button>
              </li>
            ),
          )}
        </ul>
      )}
      {editing === "new" ? (
        <div className="card p-3">
          <ContractForm contract={null} flows={flows} onDone={() => setEditing(null)} />
        </div>
      ) : (
        <div>
          <button type="button" className="btn btn-sm" onClick={() => setEditing("new")} disabled={!flows.length}>
            Add договор
          </button>
        </div>
      )}
    </div>
  );
}

function ContractForm({ contract, flows, onDone }: { contract: ContractView | null; flows: FlowView[]; onDone: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [state, setState] = useState<HoldingActionState>({});
  const [attachment, setAttachment] = useState(contract?.attachment ? { id: contract.attachment.id, name: contract.attachment.name } : null);
  const [uploading, setUploading] = useState(false);
  const err = (k: string) => state.fieldErrors?.[k]?.[0];
  const submit = (fd: FormData) =>
    start(async () => {
      const common = {
        number: String(fd.get("number") ?? ""),
        signedOn: String(fd.get("signedOn") ?? ""),
        validUntil: String(fd.get("validUntil") ?? ""),
        status: String(fd.get("status") ?? "draft") as ContractView["status"],
        amountTerms: String(fd.get("amountTerms") ?? ""),
        attachmentFileId: attachment?.id ?? null,
      };
      const res = await saveContractAction(contract?.id ?? null, contract ? common : { ...common, flowId: String(fd.get("flowId") ?? "") });
      setState(res);
      if (res.ok) {
        router.refresh();
        onDone();
      }
    });
  return (
    <form action={submit} className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label={contract ? `Edit договор ${contract.number}` : "Add договор"}>
      {!contract && (
        <div className="sm:col-span-2">
          <label className="label" htmlFor="ct-flow">
            Flow
          </label>
          <select id="ct-flow" name="flowId" className="input" required defaultValue="">
            <option value="" disabled>
              Choose…
            </option>
            {flows.map((f) => (
              <option key={f.id} value={f.id}>
                {f.fullLabel}
              </option>
            ))}
          </select>
        </div>
      )}
      <div>
        <label className="label" htmlFor="ct-number">
          Number
        </label>
        <input id="ct-number" name="number" className="input" required maxLength={60} defaultValue={contract?.number ?? ""} placeholder="№ 12/2026" />
        {err("number") && <p className="mt-1 text-[12px] text-risk">{err("number")}</p>}
      </div>
      <div>
        <label className="label" htmlFor="ct-status">
          Status
        </label>
        <select id="ct-status" name="status" className="input" defaultValue={contract?.status ?? "draft"}>
          {CONTRACT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {CONTRACT_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="ct-signed">
          Signed on
        </label>
        <input id="ct-signed" name="signedOn" type="date" className="input" defaultValue={contract?.signedOn ?? ""} />
      </div>
      <div>
        <label className="label" htmlFor="ct-until">
          Valid until
        </label>
        <input id="ct-until" name="validUntil" type="date" className="input" defaultValue={contract?.validUntil ?? ""} />
        {err("validUntil") && <p className="mt-1 text-[12px] text-risk">{err("validUntil")}</p>}
      </div>
      <div className="sm:col-span-2">
        <label className="label" htmlFor="ct-terms">
          Amount terms
        </label>
        <input id="ct-terms" name="amountTerms" className="input" maxLength={500} defaultValue={contract?.amountTerms ?? ""} placeholder="e.g. 120 000 KGS per month" />
      </div>
      <div className="sm:col-span-2">
        <p className="label">Scan (optional, PDF/JPG/PNG, max 10 MB)</p>
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
            aria-label="Attach the contract scan"
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
      </div>
      {state.error && (
        <p className="text-[12px] text-risk sm:col-span-2" role="alert">
          {state.error}
        </p>
      )}
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <button type="submit" className="btn btn-primary btn-sm" disabled={pending || uploading}>
          {pending ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn btn-sm" onClick={onDone}>
          Cancel
        </button>
        {contract && (
          <button
            type="button"
            className="btn btn-ghost btn-sm ml-auto"
            disabled={pending}
            onClick={() =>
              start(async () => {
                if (!window.confirm("Archive this договор? It is kept in the records.")) return;
                const res = await archiveContractAction(contract.id);
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
