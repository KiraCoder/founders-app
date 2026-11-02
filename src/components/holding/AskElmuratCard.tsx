"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { askedElmuratAction, type HoldingActionState } from "@/app/(app)/holding/actions";
import { groupsText, monthShort } from "@/lib/holding";
import type { AskCard } from "@/server/services/holding-asks";

/**
 * "Ask Elmurat": what is missing, what he still owes after a week, a ready message in
 * Russian to copy, and the "I asked Elmurat" button. The app never messages Elmurat.
 */
export function AskElmuratCard({ card, today }: { card: AskCard; today: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [state, setState] = useState<HoldingActionState>({});
  const [copied, setCopied] = useState(false);
  if (!card.missing.count && !card.waiting.count) {
    return (
      <div className="card flex items-center gap-2 px-4 py-3 text-[13px]" data-testid="ask-card">
        <span className="tag tag-ok">All set</span>
        <span className="text-muted">No акты to ask Elmurat for right now.</span>
      </div>
    );
  }
  const asked = (again: boolean) =>
    start(async () => {
      const res = await askedElmuratAction({ cells: again ? card.waiting.cells : card.missing.cells, again });
      setState(res);
      if (res.ok) router.refresh();
    });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(card.message);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="card flex flex-col gap-3 p-4" data-testid="ask-card">
      <div className="flex flex-col gap-2">
        {card.missing.count > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="tag tag-risk">{card.missing.count} missing</span>
            <p className="min-w-0 flex-1 text-[13px]">Ask Elmurat for: {groupsText(card.missing.groups, today, 10)}</p>
            <button type="button" className="btn btn-primary btn-sm" disabled={pending} onClick={() => asked(false)}>
              I asked Elmurat
            </button>
          </div>
        )}
        {card.waiting.count > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="tag tag-warn">{card.waiting.count} waiting</span>
            <p className="min-w-0 flex-1 text-[13px]">
              Asked{card.waiting.askedOn ? ` on ${Number(card.waiting.askedOn.slice(8, 10))} ${monthShort(card.waiting.askedOn)}` : ""}, still not
              received: {groupsText(card.waiting.groups, today, 10)}
            </p>
            <button type="button" className="btn btn-sm" disabled={pending} onClick={() => asked(true)}>
              I asked again
            </button>
          </div>
        )}
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <label className="label mb-0" htmlFor="elmurat-message">
            Message for Elmurat — copy it and send it yourself (the app never sends it)
          </label>
          <button type="button" className="btn btn-sm" onClick={copy}>
            {copied ? "Copied ✓" : "Copy"}
          </button>
        </div>
        <textarea id="elmurat-message" className="input text-[13px]" readOnly rows={Math.min(8, card.message.split("\n").length)} value={card.message} />
      </div>
      {(state.message || state.error) && (
        <p className={`text-[12px] ${state.error ? "text-risk" : "text-muted"}`} role="status">
          {state.error ?? state.message}
        </p>
      )}
    </div>
  );
}
