import type { UsageSummary } from "@/server/assistant/service";

const n = new Intl.NumberFormat("en-US");

/** Settings → AI assistant: setup state, this founder's usage today, the month's estimated cost. */
export function AssistantUsageCard({ usage }: { usage: UsageSummary }) {
  return (
    <div className="space-y-2 text-[13px]" data-testid="assistant-usage">
      {usage.quotaProblem && (
        <p role="alert" className="rounded-[10px] border border-line bg-sunk p-2 text-[12px] text-risk">
          OpenAI account is out of credit — add money at platform.openai.com/settings/organization/billing, then try again.
        </p>
      )}
      {!usage.configured ? (
        <p className="text-muted">AI not set up — add OPENAI_API_KEY in Vercel (see README, “AI assistant”). Quick commands (/tasks, /overdue) work without it.</p>
      ) : (
        <p className="text-muted">
          Model <span className="font-mono text-ink">{usage.model}</span> · open with Ctrl/⌘ J · limit {n.format(usage.dailyLimit)} requests per founder per day (AI_DAILY_LIMIT).
        </p>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
        <div>
          <dt className="text-[12px] text-muted">Your requests today</dt>
          <dd className="font-medium">
            {n.format(usage.today.requests)} / {n.format(usage.dailyLimit)}
          </dd>
        </div>
        <div>
          <dt className="text-[12px] text-muted">Tokens today in / out</dt>
          <dd className="font-medium">
            {n.format(usage.today.input)} / {n.format(usage.today.output)}
          </dd>
        </div>
        <div>
          <dt className="text-[12px] text-muted">Cached today</dt>
          <dd className="font-medium">{n.format(usage.today.cached)}</dd>
        </div>
        <div>
          <dt className="text-[12px] text-muted">This month (both founders)</dt>
          <dd className="font-medium">
            ≈ ${usage.month.costUsd.toFixed(2)} · {n.format(usage.month.requests)} requests
          </dd>
        </div>
      </dl>
      <p className="text-[11px] text-muted">
        Estimate at ${usage.price.input}/1M input, ${usage.price.cached}/1M cached, ${usage.price.output}/1M output (AI_PRICE_IN / AI_PRICE_CACHED / AI_PRICE_OUT). The OpenAI bill is the source of truth.
      </p>
    </div>
  );
}
