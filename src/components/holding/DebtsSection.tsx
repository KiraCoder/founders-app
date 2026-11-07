"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addLedgerEntryAction, archiveLedgerEntryAction, type HoldingActionState } from "@/app/(app)/holding/actions";
import { formatMoney } from "@/lib/money";
import type { DebtsView, LedgerEntryView } from "@/server/services/holding";
import { DateInput } from "@/components/DateInput";

type Company = { id: string; name: string };

/** Net debt per company pair + the ledger (opening balances and payments). */
export function DebtsSection({ debts, entries, companies, today }: { debts: DebtsView; entries: LedgerEntryView[]; companies: Company[]; today: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [state, setState] = useState<HoldingActionState>({});
  const err = (k: string) => state.fieldErrors?.[k]?.[0];

  const submit = (fd: FormData) =>
    start(async () => {
      const res = await addLedgerEntryAction({
        kind: (fd.get("kind") as "payment" | "opening") ?? "payment",
        debtorCompanyId: String(fd.get("debtorCompanyId") ?? ""),
        creditorCompanyId: String(fd.get("creditorCompanyId") ?? ""),
        entryDate: String(fd.get("entryDate") ?? ""),
        amount: String(fd.get("amount") ?? ""),
        note: String(fd.get("note") ?? ""),
      });
      setState(res);
      if (res.ok) {
        setAdding(false);
        router.refresh();
      }
    });

  return (
    <div className="flex flex-col gap-3">
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[420px] text-left text-[13px]" data-testid="debts-table">
          <thead className="text-[12px] text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Who owes whom (both directions netted)</th>
              <th className="px-4 py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {debts.pairs.length === 0 && (
              <tr>
                <td colSpan={2} className="border-t border-line px-4 py-4 text-center text-muted">
                  {debts.hasData ? "Nobody owes anything." : "No debts yet: add акт amounts in the grid, opening balances or payments."}
                </td>
              </tr>
            )}
            {debts.pairs.map((p) => (
              <tr key={`${p.debtor.id}|${p.creditor.id}`}>
                <td className="border-t border-line px-4 py-2">
                  <b className="font-medium">{p.debtor.name}</b> owes <b className="font-medium">{p.creditor.name}</b>
                </td>
                <td className="num border-t border-line px-4 py-2 text-right font-medium">{formatMoney(p.amount)}</td>
              </tr>
            ))}
          </tbody>
          {debts.pairs.length > 0 && (
            <tfoot>
              <tr>
                <td className="border-t border-line px-4 py-2 font-semibold">Total</td>
                <td className="num border-t border-line px-4 py-2 text-right font-semibold" data-testid="debts-total">
                  {formatMoney(debts.total)}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-sm" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
          {adding ? "Close" : "Add payment or opening balance"}
        </button>
        {state.ok && state.nonce && !adding && <span className="text-[12px] text-muted">Saved.</span>}
      </div>
      {adding && (
        <form action={submit} className="card grid grid-cols-1 gap-2 p-3 sm:grid-cols-2" aria-label="Add ledger entry">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="le-kind">
              Kind
            </label>
            <select id="le-kind" name="kind" className="input" defaultValue="payment">
              <option value="payment">Payment (the debtor paid)</option>
              <option value="opening">Opening balance (owed before the app)</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="le-debtor">
              Company that owes / paid
            </label>
            <select id="le-debtor" name="debtorCompanyId" className="input" required defaultValue="">
              <option value="" disabled>
                Choose…
              </option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {err("debtorCompanyId") && <p className="mt-1 text-[12px] text-risk">{err("debtorCompanyId")}</p>}
          </div>
          <div>
            <label className="label" htmlFor="le-creditor">
              Company that is owed / was paid
            </label>
            <select id="le-creditor" name="creditorCompanyId" className="input" required defaultValue="">
              <option value="" disabled>
                Choose…
              </option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {err("creditorCompanyId") && <p className="mt-1 text-[12px] text-risk">{err("creditorCompanyId")}</p>}
          </div>
          <div>
            <label className="label" htmlFor="le-date">
              Date
            </label>
            <DateInput id="le-date" name="entryDate" required max={today} defaultValue={today} />
            {err("entryDate") && <p className="mt-1 text-[12px] text-risk">{err("entryDate")}</p>}
          </div>
          <div>
            <label className="label" htmlFor="le-amount">
              Amount (KGS)
            </label>
            <input id="le-amount" name="amount" className="input num" inputMode="decimal" required autoComplete="off" />
            {err("amount") && <p className="mt-1 text-[12px] text-risk">{err("amount")}</p>}
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="le-note">
              Note
            </label>
            <input id="le-note" name="note" className="input" maxLength={500} />
          </div>
          {state.error && (
            <p className="text-[12px] text-risk sm:col-span-2" role="alert">
              {state.error}
            </p>
          )}
          <div className="sm:col-span-2">
            <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>
              {pending ? "Saving…" : "Add entry"}
            </button>
          </div>
        </form>
      )}

      {entries.length > 0 && (
        <details className="card px-4 py-2 text-[13px]">
          <summary className="cursor-pointer py-1 text-muted">Payments and opening balances ({entries.length})</summary>
          <ul className="divide-y divide-line">
            {entries.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="num text-muted">{e.entryDate}</span>
                <span className="tag">{e.kind === "payment" ? "Payment" : "Opening balance"}</span>
                <span className="min-w-0 flex-1">
                  {e.debtor.name} {e.kind === "payment" ? "paid" : "owed"} {e.creditor.name}
                  {e.note && <span className="text-muted"> · {e.note}</span>}
                </span>
                <span className="num font-medium">{formatMoney(e.amount)}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      if (!window.confirm("Cancel this entry? It stays in the records but stops counting.")) return;
                      setState(await archiveLedgerEntryAction(e.id));
                      router.refresh();
                    })
                  }
                >
                  Cancel entry
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
