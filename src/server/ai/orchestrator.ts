import "server-only";
import { monthsLabel } from "@/lib/ai-roles";
import type { Db } from "@/server/db/connect";
import type { MessageLine } from "@/server/notifications/types";
import type { WaitingNumber } from "@/server/notifications/messages";
import { appUrl, collectAiRequests, numbersHref, planAiRoles, type AiPlanReport, type AiRequestItem, type EngineOptions } from "@/server/services/ai-roles";
import type { ServiceContext } from "@/server/services/context";
import { DEBT_METRIC_KEY } from "@/server/services/holding";
import type { HoldingSection } from "@/server/services/holding-asks";

/**
 * The orchestrator: decides what each founder is asked, when, and by whom — so the same
 * question is never asked twice and nothing is asked again before its time ("park items
 * until the right time"). It does not send anything itself; it runs inside the scheduler
 * tick and inside the morning summary.
 *
 * Per tick (`orchestrateTick`): every hired AI role plans its runs and data requests
 * (services/ai-roles.ts: runs due by the schedule, re-checks of waiting runs, one request per
 * founder per hire, superseded rounds).
 *
 * Per morning summary (`composeMorningRequests`), the requests of all sources are collected
 * and de-duplicated. Sources: AI role data requests, "Numbers waiting" (late numbers), and
 * Holding ("ask Elmurat" for акты). THE RULE:
 *
 * 1. A number is asked for by ONE source only. When an AI role has an active request that
 *    covers a number, that number is removed from "Numbers waiting" and appears only on the
 *    role's line ("Financial Analyst needs October 2026 numbers for Kiwi Go: …"). This holds
 *    on the days the role's line is NOT shown too (after 7 days it chases weekly): the number
 *    is parked until the role's next chase day instead of being asked by "Numbers waiting".
 * 2. One line per hire per founder per day at most, at most 3 role lines per summary.
 * 3. Holding акты are asked by the Holding section (it has the "I asked Elmurat" button and
 *    the person who can act). The intercompany-debt number is derived from those акты, so a
 *    role waiting for it does not ask separately while a Holding ask line is in the summary:
 *    the number is dropped from the role's line and the Holding section gets one muted line
 *    saying the role is waiting for those акты too.
 * 4. Only the two founders are ever asked; people records (Elmurat, Edil) never get anything.
 */

/** At most this many AI role lines in one morning summary. */
export const MAX_REQUEST_LINES = 3;

export async function orchestrateTick(db: Db, now: Date, opts: EngineOptions = {}): Promise<AiPlanReport> {
  return planAiRoles(db, now, opts);
}

export interface ComposedRequests {
  /** "Numbers waiting" minus the numbers an AI role asks for. */
  waiting: WaitingNumber[];
  /** Holding section (unchanged, plus at most one attribution line). */
  holding: HoldingSection | null;
  /** AI role lines (heading included) or empty. */
  aiLines: MessageLine[];
  /** Requests shown today (marked once the summary is delivered). */
  aiRequestIds: string[];
}

function roleLine(item: AiRequestItem, missing: AiRequestItem["missing"]): string {
  const labels = missing.map((m) => m.label);
  const shown = labels.slice(0, 3).join(", ") + (labels.length > 3 ? ` +${labels.length - 3} more` : "");
  const g = missing[0]?.granularity ?? "month";
  return `${item.roleName} needs ${monthsLabel(item.months)} numbers for ${item.companyName}: ${shown} — enter them: ${appUrl(numbersHref(item.companySlug, g))}`;
}

/**
 * Pure composition (tested directly): applies the rule above to already-collected inputs.
 */
export function composeRequests(
  items: readonly AiRequestItem[],
  waiting: readonly (WaitingNumber & { metricId?: string })[],
  holding: HoldingSection | null,
): ComposedRequests {
  const covered = new Set(items.flatMap((i) => i.missing.map((m) => m.metricId)));
  const holdingAsks = !!holding?.lines.length;
  const lines: string[] = [];
  const shownIds: string[] = [];
  const waitingOnActs: string[] = [];
  for (const item of items) {
    const own = holdingAsks ? item.missing.filter((m) => m.key !== DEBT_METRIC_KEY) : item.missing;
    if (own.length < item.missing.length) waitingOnActs.push(`${item.roleName} (${item.companyName})`);
    if (!item.dueToday || !own.length) continue;
    lines.push(roleLine(item, own));
    shownIds.push(item.requestId);
  }
  const visible = lines.slice(0, MAX_REQUEST_LINES);
  const aiLines: MessageLine[] = visible.length
    ? [
        { text: "AI roles · numbers needed", style: "heading" },
        ...visible.map((text) => ({ text, style: "item" as const })),
        ...(lines.length > visible.length ? [{ text: `+${lines.length - visible.length} more on the AI roles page`, style: "muted" as const }] : []),
      ]
    : [];
  let composedHolding = holding;
  if (holding && holdingAsks && waitingOnActs.length) {
    composedHolding = {
      ...holding,
      lines: [...holding.lines, { text: `The ${waitingOnActs.join(", ")} is waiting for these акты too (intercompany debt).`, style: "muted" }],
    };
  }
  return {
    waiting: waiting.filter((w) => !(w.metricId && covered.has(w.metricId))),
    holding: composedHolding,
    aiLines,
    aiRequestIds: shownIds.slice(0, MAX_REQUEST_LINES),
  };
}

/** Collects the AI role requests for this founder and composes the morning-summary requests. */
export async function composeMorningRequests(
  ctx: ServiceContext,
  input: { waiting: readonly (WaitingNumber & { metricId?: string })[]; holding: HoldingSection | null },
): Promise<ComposedRequests> {
  const items = ctx.user.role === "founder" ? await collectAiRequests(ctx) : [];
  return composeRequests(items, input.waiting, input.holding);
}
