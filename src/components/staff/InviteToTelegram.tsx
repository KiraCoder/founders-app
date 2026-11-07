"use client";

import { useState, useTransition } from "react";
import { invitePersonAction, type InviteState } from "@/app/(app)/staff-actions";
import { CopyButton } from "@/components/CopyButton";

/**
 * "Invite to Telegram" (founders only): a one-time code (15 minutes, single use) and the deep link
 * https://t.me/<bot>?start=<code>. The founder sends the link to the person (WhatsApp etc.); the
 * app never contacts anyone who has not started the bot.
 */
export function InviteToTelegram({ personId, personName, compact = false }: { personId: string; personName: string; compact?: boolean }) {
  const [state, setState] = useState<InviteState>({});
  const [pending, start] = useTransition();
  const until = state.expiresAt
    ? new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(state.expiresAt))
    : null;
  return (
    <div className="flex flex-col gap-2">
      <div>
        <button
          type="button"
          className={`btn ${compact ? "btn-sm" : ""}`}
          disabled={pending}
          aria-label={`Invite ${personName} to Telegram`}
          onClick={() => start(async () => setState(await invitePersonAction(personId)))}
        >
          {state.code ? "New invite link" : "Invite to Telegram"}
        </button>
      </div>
      {state.error && (
        <p role="alert" className="text-[12px] text-risk">
          {state.error}
        </p>
      )}
      {state.deepLink && (
        <div className="rounded-[8px] border border-line bg-sunk p-3 text-[13px]" role="status">
          <p>Send this link to {personName} (WhatsApp, SMS…). They open it and press Start:</p>
          <p className="mt-1 flex flex-wrap items-center gap-1">
            <code data-testid="invite-link" className="num break-all rounded bg-surface px-1.5 py-0.5 font-semibold">
              {state.deepLink}
            </code>
            <CopyButton text={state.deepLink} title="Copy invite link" copiedLabel="Copied" />
          </p>
          <p className="mt-1 text-[12px] text-muted">
            Or they send <code data-testid="invite-command">/start {state.code}</code> to @{state.botUsername}. Works once, until{" "}
            {until}. Messages start only after you switch on “Bot may message” in Settings → Team on Telegram.
          </p>
        </div>
      )}
    </div>
  );
}

/** Pick anyone (not an app user) and make an invite link for them. */
export function InvitePicker({ people }: { people: { id: string; name: string }[] }) {
  const [id, setId] = useState("");
  const picked = people.find((p) => p.id === id);
  return (
    <div className="flex flex-col gap-2">
      <label className="flex max-w-[360px] flex-col gap-1">
        <span className="label">Invite someone</span>
        <select className="input" value={id} onChange={(e) => setId(e.target.value)} aria-label="Person to invite">
          <option value="">Pick a person…</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {picked && <InviteToTelegram key={picked.id} personId={picked.id} personName={picked.name} />}
    </div>
  );
}
