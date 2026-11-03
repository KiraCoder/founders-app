"use client";

import { useState, useTransition } from "react";
import { connectTelegramAction, telegramStatusAction } from "@/app/(app)/settings/actions";
import type { TelegramSetupConfig, TelegramSetupResult } from "@/server/notifications/telegram-setup";

const SOURCE_LABEL: Record<string, string> = {
  APP_URL: "from APP_URL",
  VERCEL_PROJECT_PRODUCTION_URL: "Vercel's production address (APP_URL is not set)",
  VERCEL_URL: "this deployment's Vercel address (APP_URL is not set)",
};

function when(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso));
}

/** Settings → Telegram bot: one button that connects the bot to this app (founders only). */
export function TelegramBotSetupCard({ config, timeZone }: { config: TelegramSetupConfig; timeZone: string }) {
  const [result, setResult] = useState<TelegramSetupResult | null>(null);
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<TelegramSetupResult>) =>
    start(async () => {
      setResult(await fn());
    });
  const cfg = result?.config ?? config;
  const status = result && "status" in result ? result.status : undefined;

  return (
    <div className="flex flex-col gap-3 text-[13px]" data-testid="telegram-setup">
      <p className="text-muted">
        Once, after the first deploy: tells Telegram to deliver the bot&apos;s messages to this app and sets the bot&apos;s menu
        (/today, /tasks, /help). Pressing it again is harmless.
      </p>
      {cfg.webhookUrl ? (
        <p>
          Webhook address: <span className="num break-all">{cfg.webhookUrl}</span>
          {cfg.appUrlSource && <span className="text-muted"> · {SOURCE_LABEL[cfg.appUrlSource]}</span>}
        </p>
      ) : null}
      {cfg.missing.length > 0 && (
        <p role="alert" className="text-risk" data-testid="telegram-setup-missing">
          Missing in Vercel → Settings → Environment Variables: {cfg.missing.join(", ")}. Add them and redeploy.
        </p>
      )}
      {cfg.problems.map((p) => (
        <p key={p} role="alert" className="text-risk">
          {p}
        </p>
      ))}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={pending || cfg.missing.length > 0 || cfg.problems.length > 0}
          onClick={() => run(connectTelegramAction)}
        >
          {pending ? "Working…" : "Connect Telegram"}
        </button>
        <button type="button" className="btn btn-sm" disabled={pending || cfg.missing.includes("TELEGRAM_BOT_TOKEN")} onClick={() => run(telegramStatusAction)}>
          Check status
        </button>
      </div>
      {result && (
        <div role="status" className={result.ok ? "" : "text-risk"} data-testid="telegram-setup-result">
          <p className="font-medium">{result.message}</p>
          {status && (
            <ul className="mt-1 space-y-0.5 text-[12px] text-ink">
              <li>
                URL set: {status.url ? <span className="num break-all">{status.url}</span> : "no"}
                {status.url && !status.matchesThisApp && " (not this app)"}
              </li>
              <li>Pending updates: {status.pendingUpdateCount}</li>
              <li>
                Last error:{" "}
                {status.lastErrorMessage ? `${status.lastErrorMessage}${status.lastErrorAt ? ` (${when(status.lastErrorAt, timeZone)})` : ""}` : "none"}
              </li>
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
