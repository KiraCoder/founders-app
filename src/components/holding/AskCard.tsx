"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { askedAction, setAskOverrideAction, type HoldingActionState } from "@/app/(app)/holding/actions";
import { groupsText, monthShort, whoName } from "@/lib/holding";
import type { AskCard as AskCardData, AskCardFlow, AskCardPerson } from "@/server/services/holding-asks";

/**
 * "Ask for акты": one block per person to ask (each flow's "who to ask", e.g. Elmurat, or
 * nobody named → generic wording) with what is missing, what they still owe after a week,
 * a ready message in Russian to copy and the "I asked …" buttons. Below, a founder can
 * change who to ask for this month's round. The app never messages these people.
 */
export function AskCard({ card, today }: { card: AskCardData; today: string }) {
  const [state, setState] = useState<HoldingActionState>({});
  if (!card.missing.count && !card.waiting.count) {
    return (
      <div className="card flex items-center gap-2 px-4 py-3 text-[13px]" data-testid="ask-card">
        <span className="tag tag-ok">All set</span>
        <span className="text-muted">No акты to ask for right now.</span>
      </div>
    );
  }
  return (
    <div className="card flex flex-col divide-y divide-line" data-testid="ask-card">
      {card.people.map((p) => (
        <PersonBlock key={p.person?.id ?? "nobody"} block={p} today={today} onResult={setState} />
      ))}
      {card.flows.length > 0 && <WhoToAsk flows={card.flows} onResult={setState} />}
      {(state.message || state.error) && (
        <p className={`px-4 py-2 text-[12px] ${state.error ? "text-risk" : "text-muted"}`} role="status">
          {state.error ?? state.message}
        </p>
      )}
    </div>
  );
}

function PersonBlock({ block, today, onResult }: { block: AskCardPerson; today: string; onResult: (s: HoldingActionState) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [copied, setCopied] = useState(false);
  const who = whoName(block.person);
  const id = `ask-message-${block.person?.id ?? "nobody"}`;
  const asked = (again: boolean) =>
    start(async () => {
      const res = await askedAction({ cells: again ? block.waiting.cells : block.missing.cells, again });
      onResult(res);
      if (res.ok) router.refresh();
    });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(block.message);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <section className="flex flex-col gap-3 p-4" data-testid="ask-person" aria-label={`Ask ${who}`}>
      <div className="flex flex-col gap-2">
        {block.missing.count > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="tag tag-risk">{block.missing.count} missing</span>
            <p className="min-w-0 flex-1 text-[13px]">
              Ask <span className="font-medium">{who}</span> for: {groupsText(block.missing.groups, today, 10)}
            </p>
            <button type="button" className="btn btn-primary btn-sm" disabled={pending} onClick={() => asked(false)}>
              I asked {who}
            </button>
          </div>
        )}
        {block.waiting.count > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="tag tag-warn">{block.waiting.count} waiting</span>
            <p className="min-w-0 flex-1 text-[13px]">
              Asked <span className="font-medium">{who}</span>
              {block.waiting.askedOn ? ` on ${Number(block.waiting.askedOn.slice(8, 10))} ${monthShort(block.waiting.askedOn)}` : ""}, still not
              received: {groupsText(block.waiting.groups, today, 10)}
            </p>
            <button type="button" className="btn btn-sm" disabled={pending} onClick={() => asked(true)}>
              I asked again
            </button>
          </div>
        )}
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <label className="label mb-0" htmlFor={id}>
            Message for {who} — copy it and send it yourself (the app never sends it)
          </label>
          <button type="button" className="btn btn-sm" onClick={copy}>
            {copied ? "Copied ✓" : "Copy"}
          </button>
        </div>
        <textarea id={id} className="input text-[13px]" readOnly rows={Math.min(8, block.message.split("\n").length)} value={block.message} />
      </div>
    </section>
  );
}

/** Per flow: who to ask for this month's акты (overrides the flow's person for this round only). */
function WhoToAsk({ flows, onResult }: { flows: AskCardFlow[]; onResult: (s: HoldingActionState) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const overridden = flows.filter((f) => f.overridden).length;
  return (
    <details className="px-4 py-3 text-[13px]" data-testid="who-to-ask">
      <summary className="cursor-pointer text-muted">
        Who to ask this month{overridden ? ` · ${overridden} changed` : ""}
      </summary>
      <p className="mt-2 text-[12px] text-muted">
        Each flow has its own person (Flows → Edit). Pick someone else here for this month&apos;s asks only — e.g. when they are away.
      </p>
      <ul className="mt-2 flex flex-col gap-2">
        {flows.map((f) => {
          const selectId = `who-${f.flowId}`;
          return (
            <li key={f.flowId} className="flex flex-wrap items-center gap-2">
              <label htmlFor={selectId} className="min-w-0 flex-1">
                {f.label}
              </label>
              <select
                id={selectId}
                className="input h-8 w-auto py-0"
                disabled={pending}
                value={f.overridden ? (f.person?.id ?? "") : ""}
                onChange={(e) =>
                  start(async () => {
                    const res = await setAskOverrideAction({ flowId: f.flowId, personId: e.target.value || null });
                    onResult(res);
                    if (res.ok) router.refresh();
                  })
                }
              >
                <option value="">{f.flowPerson ? `${f.flowPerson.name} (the flow's person)` : "Nobody named (generic message)"}</option>
                {f.options
                  .filter((o) => o.id !== f.flowPerson?.id)
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name} — this month only
                    </option>
                  ))}
              </select>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
