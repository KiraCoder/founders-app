"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { revokeConnectedAppAction } from "@/app/(app)/settings/connected-apps-actions";
import { CopyButton } from "@/components/CopyButton";

export interface ConnectedAppItem {
  grantId: string;
  clientName: string;
  connectedAt: string;
  lastUsed: string | null;
}

/**
 * Settings → Connected apps (founders): apps such as Claude that were allowed to act as you
 * through the "Founder Cockpit" connector (OAuth). Disconnect revokes the app's tokens at once.
 */
export function ConnectedAppsCard({ apps, mcpUrl }: { apps: ConnectedAppItem[]; mcpUrl: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const revoke = (grantId: string) =>
    start(async () => {
      const r = await revokeConnectedAppAction(grantId);
      setError(r.error ?? null);
      if (r.ok) router.refresh();
    });

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        Connect Founder Cockpit to Claude (claude.ai → Settings → Connectors → Add custom connector) with this URL, then say
        “save this plan to the Founder Cockpit for Kiwi Go”. The app acts as you.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="num rounded-[6px] bg-surface px-2 py-1 text-[12px]">{mcpUrl}</code>
        <CopyButton text={mcpUrl} />
      </div>
      {apps.length === 0 ? (
        <p className="text-[13px] text-muted">No apps connected.</p>
      ) : (
        <ul className="divide-y divide-line rounded-[8px] border border-line">
          {apps.map((a) => (
            <li key={a.grantId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <div>
                <p className="text-[13px] font-medium">{a.clientName}</p>
                <p className="text-[12px] text-muted">
                  Connected {a.connectedAt}
                  {a.lastUsed ? ` · last used ${a.lastUsed}` : " · not used yet"}
                </p>
              </div>
              <button type="button" className="btn btn-sm btn-danger" disabled={pending} onClick={() => revoke(a.grantId)}>
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-risk">
          {error}
        </p>
      )}
    </div>
  );
}
