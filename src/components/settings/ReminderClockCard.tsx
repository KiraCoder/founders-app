"use client";

import { useState, useTransition } from "react";
import { reminderClockStatusAction, startReminderClockAction } from "@/app/(app)/settings/actions";
import type { ReminderClockConfig, ReminderClockResult } from "@/server/notifications/reminder-clock";

function when(iso: string | null, timeZone: string) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso));
}

/** Settings → Reminder clock: pg_cron in Supabase calls the tick every 10 minutes (founders only). */
export function ReminderClockCard({ config, timeZone }: { config: ReminderClockConfig; timeZone: string }) {
  const [result, setResult] = useState<ReminderClockResult | null>(null);
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ReminderClockResult>) =>
    start(async () => {
      setResult(await fn());
    });
  const cfg = result?.config ?? config;
  const status = result && "status" in result ? result.status : undefined;

  return (
    <div className="flex flex-col gap-3 text-[13px]" data-testid="reminder-clock">
      <p className="text-muted">
        Reminders and the morning summary go out when the app is called every few minutes. Vercel&apos;s free plan only does that
        once a day, so this button asks the Supabase database to call the app every 10 minutes (pg_cron + pg_net; the address and
        CRON_SECRET are kept in Supabase Vault). Pressing it again is harmless.
      </p>
      {cfg.tickUrl && (
        <p>
          Calls: <span className="num break-all">POST {cfg.tickUrl}</span>
        </p>
      )}
      {cfg.missing.length > 0 && (
        <p role="alert" className="text-risk" data-testid="reminder-clock-missing">
          Missing in Vercel → Settings → Environment Variables: {cfg.missing.join(", ")}. Add them and redeploy.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary btn-sm" disabled={pending || cfg.missing.length > 0} onClick={() => run(startReminderClockAction)}>
          {pending ? "Working…" : "Start reminder clock"}
        </button>
        <button type="button" className="btn btn-sm" disabled={pending} onClick={() => run(reminderClockStatusAction)}>
          Check status
        </button>
      </div>
      {result && (
        <div role="status" className={result.ok ? "" : "text-risk"} data-testid="reminder-clock-result">
          <p className="font-medium">{result.message}</p>
          {status && (
            <div className="mt-1 text-[12px] text-ink">
              <p>
                Job: {status.jobExists ? `founders-tick, ${status.schedule}${status.active === false ? " (paused)" : ""}` : "not scheduled"}
              </p>
              {status.jobExists && (
                <>
                  <p className="mt-1">Last runs:</p>
                  {status.runs.length === 0 ? (
                    <p className="text-muted">none yet</p>
                  ) : (
                    <ul className="space-y-0.5">
                      {status.runs.map((r, i) => (
                        <li key={i}>
                          <span className="num">{when(r.startedAt, timeZone)}</span> · {r.status}
                          {r.message ? ` · ${r.message}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                  {status.responses.length > 0 && (
                    <>
                      <p className="mt-1">Last answers from the app:</p>
                      <ul className="space-y-0.5">
                        {status.responses.map((r, i) => (
                          <li key={i}>
                            <span className="num">{when(r.at, timeZone)}</span> · {r.statusCode ?? "no answer"}
                            {r.error ? ` · ${r.error}` : ""}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
