"use client";

import { useState, useTransition } from "react";
import { createLinkCodeAction, unlinkTelegramAction, type LinkCodeState } from "@/app/(app)/settings/actions";

export interface LinkInfo {
  username: string | null;
  firstName: string | null;
  linkedAt: string;
}

function hm(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso));
}

export function TelegramLinkCard({
  link,
  botUsername,
  botConfigured,
  timeZone,
}: {
  link: LinkInfo | null;
  botUsername: string | null;
  botConfigured: boolean;
  timeZone: string;
}) {
  const [code, setCode] = useState<LinkCodeState>({});
  const [pending, start] = useTransition();
  const botName = botUsername ? `@${botUsername}` : "your bot";

  if (link) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px]">
          <span className="tag tag-ok mr-2">Linked</span>
          {link.firstName ?? "Telegram"}
          {link.username ? ` (@${link.username})` : ""} since {link.linkedAt}
        </p>
        <form action={unlinkTelegramAction}>
          <button type="submit" className="btn btn-sm">
            Unlink
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px]">
        <span className="tag tag-warn mr-2">Not linked</span>
        Link your own Telegram to get your summaries and reminders there.
      </p>
      {!botConfigured && (
        <p className="text-[12px] text-muted">
          The bot token is not set on this server yet, so messages go to the in-app dev inbox. Linking still works and
          takes effect once the token is added.
        </p>
      )}
      <div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={pending}
          onClick={() => start(async () => setCode(await createLinkCodeAction()))}
        >
          {code.code ? "Generate a new code" : "Generate link code"}
        </button>
      </div>
      {code.code && (
        <div className="rounded-[8px] border border-line bg-sunk p-3 text-[13px]" role="status">
          <p>
            Send this to {botName} in Telegram:{" "}
            <code data-testid="link-command" className="num rounded bg-surface px-1.5 py-0.5 font-semibold">
              /start {code.code}
            </code>
          </p>
          <p className="mt-1 text-[12px] text-muted">
            Works once, until {code.expiresAt ? hm(code.expiresAt, timeZone) : "soon"}. Then reload this page.
          </p>
        </div>
      )}
    </div>
  );
}
