"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createExtensionKeyAction, revokeExtensionKeyAction } from "@/app/(app)/settings/actions";
import { Tag } from "@/components/ui";

export interface ExtensionKeyItem {
  id: string;
  name: string;
  prefix: string;
  created: string;
  lastUsed: string | null;
  revoked: string | null;
}

export interface IngestLogItem {
  id: string;
  at: string;
  keyName: string;
  ownerName: string | null;
  adapterId: string | null;
  status: string;
  points: number;
  accepted: number;
  rejected: number;
  conflicts: number;
  firstReasons: string[];
}

/**
 * Settings → Browser extension (founders): personal keys for the Chrome extension (shown once,
 * stored as a hash), revoke, and the latest ingest calls of both founders' keys.
 */
export function ExtensionKeysCard({ keys, log, endpoint }: { keys: ExtensionKeyItem[]; log: IngestLogItem[]; endpoint: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const create = () =>
    start(async () => {
      const r = await createExtensionKeyAction(name);
      setError(r.error ?? null);
      if (r.ok && r.key) {
        setCreated(r.key);
        setCopied(false);
        setName("");
        router.refresh();
      }
    });
  const revoke = (id: string) =>
    start(async () => {
      const r = await revokeExtensionKeyAction(id);
      setError(r.error ?? null);
      if (r.ok) router.refresh();
    });

  return (
    <div className="flex flex-col gap-4 text-[13px]" data-testid="extension-card">
      <p className="text-muted">
        Personal keys for the founders&apos; Chrome extension. It sends numbers it reads from web pages to <code className="num">{endpoint}</code>; they are
        written like any other number (source “browser extension”) and never replace a number you typed or uploaded. A key acts as you; revoke it if a
        laptop is lost.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label>
          <span className="label">Key name</span>
          <input className="input w-56" value={name} onChange={(e) => setName(e.target.value)} placeholder="Laptop Chrome" aria-label="Key name" maxLength={60} />
        </label>
        <button type="button" className="btn btn-primary" disabled={pending || !name.trim()} onClick={create}>
          Create key
        </button>
      </div>
      {error && (
        <p className="text-[12px] text-risk" role="status">
          {error}
        </p>
      )}
      {created && (
        <div className="rounded-[10px] border border-warn-line bg-warn-soft p-3" data-testid="new-extension-key">
          <p className="mb-1 font-medium">Copy this key now — it is shown only once.</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="num break-all rounded bg-surface px-2 py-1 text-[12px]" data-testid="new-extension-key-value">
              {created}
            </code>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                void navigator.clipboard?.writeText(created).then(() => setCopied(true), () => setCopied(false));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
          <p className="mt-1 text-[12px] text-muted">Paste it into the extension&apos;s settings. Only a fingerprint of it is stored here.</p>
        </div>
      )}

      <div>
        <h3 className="label">Your keys</h3>
        {keys.length === 0 ? (
          <p className="text-muted">No keys yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-[8px] border border-line">
            {keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-testid="extension-key">
                <span className="font-medium">{k.name}</span>
                <code className="num text-[12px] text-muted">{k.prefix}…</code>
                <span className="text-[12px] text-muted">created {k.created}</span>
                <span className="text-[12px] text-muted">{k.lastUsed ? `last used ${k.lastUsed}` : "never used"}</span>
                <span className="ml-auto">
                  {k.revoked ? (
                    <Tag>Revoked {k.revoked}</Tag>
                  ) : (
                    <button type="button" className="btn btn-sm" disabled={pending} onClick={() => revoke(k.id)} aria-label={`Revoke ${k.name}`}>
                      Revoke
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="label">Latest calls (both founders)</h3>
        {log.length === 0 ? (
          <p className="text-muted">The extension has not sent anything yet.</p>
        ) : (
          <ul className="space-y-1 text-[12px]" data-testid="ingest-log">
            {log.map((l) => (
              <li key={l.id} className="flex flex-wrap gap-x-2">
                <span className="num text-muted">{l.at}</span>
                <span className="font-medium">{l.keyName}</span>
                <span className="text-muted">({l.ownerName ?? "?"})</span>
                <span>{l.adapterId ?? "—"}</span>
                {l.status === "ok" ? (
                  <span>
                    {l.accepted} accepted · {l.rejected} rejected{l.conflicts ? ` (${l.conflicts} kept your number)` : ""}
                  </span>
                ) : (
                  <span className="text-risk">refused</span>
                )}
                {l.firstReasons.length > 0 && <span className="text-muted">— {l.firstReasons.join("; ")}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
