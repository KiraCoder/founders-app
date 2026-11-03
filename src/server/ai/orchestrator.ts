import "server-only";
import { monthName, monthStart, monthsLabel } from "@/lib/ai-roles";
import { monthTotalKind } from "@/server/ai/month-values";
import type { IsoDate } from "@/lib/dates";
import type { Db } from "@/server/db/connect";
import { aiRequestRef, type MessageLine } from "@/server/notifications/types";
import type { WaitingNumber } from "@/server/notifications/messages";
import { appUrl, collectAiRequests, numbersHref, planAiRoles, type AiPlanReport, type AiRequestItem, type EngineOptions } from "@/server/services/ai-roles";
import type { ServiceContext } from "@/server/services/context";
import { DEBT_METRIC_KEY } from "@/server/services/holding";
import type { HoldingSection } from "@/server/services/holding-asks";
import { orgExpertSummaryLines } from "@/server/services/org-expert";

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
 *    covers a number FOR A MONTH, that number is removed from "Numbers waiting" while it is
 *    waiting for a period of that month (a daily number late for November days stays in
 *    "Numbers waiting" while the role asks for October), and appears only on the role's line ("Financial Analyst needs October 2026 numbers for Kiwi Go: …"). This holds
 *    on the days the role's line is NOT shown too (after 7 days it chases weekly): the number
 *    is parked until the role's next chase day instead of being asked by "Numbers waiting".
 * 2. One line per hire per founder per day at most, at most 3 role lines per summary.
 * 3. Holding акты are asked by the Holding section (it has the "I asked Elmurat" button and
 *    the person who can act). Numbers the Holding computes from those акты (intercompany
 *    debt, any `derived` number) are NEVER on a role's line — not even on days the Holding
 *    has nothing to ask (e.g. after "I asked Elmurat"): entering one by hand would only block
 *    the later derived update. When a Holding ask line is in the summary, the Holding section
 *    gets one muted line saying the role is waiting for those акты too.
 * 4. Only the two founders are ever asked; people records (Elmurat, Edil) never get anything.
 * 5. A number a role asks for that is expected from a data source that is not connected yet
 *    is asked as "enter by hand or upload until the data source is connected" and is left out
 *    of the Monday "N numbers wait for data sources" line while the request is active.
 * 6. The Org Structure Expert adds at most ONE line, on Mondays, only when warnings exist
 *    (org-expert.ts). Its stale-number findings stay on the board: "Numbers waiting" asks.
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
  // Numbers expected from a data source that is not connected yet: say how to get them in
  // meanwhile (the Monday "wait for data sources" line leaves them out, see composeRequests).
  const fromSource = missing.filter((m) => m.awaitingSource).length;
  const monthly = monthTotalsWording(item, missing);
  const how = monthly
    ? `${monthly}${fromSource ? " until the data source is connected" : ""}`
    : fromSource === 0
      ? "enter them"
      : fromSource === missing.length
        ? "enter by hand or upload until the data source is connected"
        : "enter them (the data-source ones by hand or upload until it is connected)";
  return `${item.roleName} needs ${monthsLabel(item.months)} numbers for ${item.companyName}: ${shown} — ${how}: ${appUrl(numbersHref(item.companySlug, g))}`;
}

/**
 * A role that accepts monthly totals asks for one number per month instead of every day:
 * "enter the October total (or every day)" — "average" for %-style (avg) numbers, "total or
 * average" when both are missing; several months: "the September and October 2026 totals".
 * Null when the role does not accept them or no daily number is missing.
 */
export function monthTotalsWording(item: Pick<AiRequestItem, "acceptMonthlyTotals" | "months">, missing: AiRequestItem["missing"]): string | null {
  if (!item.acceptMonthlyTotals) return null;
  const daily = missing.filter((m) => m.granularity === "day");
  if (!daily.length) return null;
  const kinds = new Set(missing.map((m) => (m.granularity === "day" ? monthTotalKind(m.aggregation ?? "sum") : "total")));
  const kind = [...kinds].sort((a, b) => (a === "total" ? -1 : b === "total" ? 1 : a.localeCompare(b))).join(" or ");
  const months = [...new Set(item.months)];
  if (months.length === 1) return `enter the ${monthName(months[0]!)} ${kind} (or every day)`;
  const plural = kind.split(" or ").map((k) => (k === "end-of-month value" ? "end-of-month values" : `${k}s`)).join(" or ");
  return `enter the ${monthsLabel(months)} ${plural} (or every day)`;
}

/**
 * Pure composition (tested directly): applies the rule above to already-collected inputs.
 */
export function composeRequests(
  items: readonly AiRequestItem[],
  waiting: readonly (WaitingNumber & { metricId?: string; waitingFor?: IsoDate })[],
  holding: HoldingSection | null,
): ComposedRequests {
  // metricId → months the roles ask for it.
  const covered = new Map<string, Set<IsoDate>>();
  for (const i of items) {
    for (const m of [...i.missing, ...i.waitingOnHolding]) {
      const set = covered.get(m.metricId) ?? new Set<IsoDate>();
      for (const p of m.months ?? i.months) set.add(p);
      covered.set(m.metricId, set);
    }
  }
  const isCovered = (w: { metricId?: string; waitingFor?: IsoDate; awaitingSource?: string | null }) => {
    const months = w.metricId ? covered.get(w.metricId) : undefined;
    if (!months) return false;
    // A number waiting for a data source that a role asks for (by hand / upload meanwhile)
    // is left out of the Monday "N numbers wait for data sources" line altogether.
    if (w.awaitingSource) return true;
    return !w.waitingFor || months.has(monthStart(w.waitingFor));
  };
  const holdingAsks = !!holding?.lines.length;
  const lines: { text: string; requestId: string }[] = [];
  const waitingOnActs: string[] = [];
  for (const item of items) {
    // Defence in depth: a holding-fed number is never asked by a role, however it got here.
    const own = item.missing.filter((m) => m.key !== DEBT_METRIC_KEY);
    if (holdingAsks && (item.waitingOnHolding.length || own.length < item.missing.length)) waitingOnActs.push(`${item.roleName} (${item.companyName})`);
    if (!item.dueToday || !own.length) continue;
    lines.push({ text: roleLine(item, own), requestId: item.requestId });
  }
  const visible = lines.slice(0, MAX_REQUEST_LINES);
  const aiLines: MessageLine[] = visible.length
    ? [
        { text: "AI roles · numbers needed", style: "heading" },
        ...visible.map((l) => ({ text: l.text, style: "item" as const, refs: [aiRequestRef(l.requestId)] })),
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
    waiting: waiting.filter((w) => !isCovered(w)),
    holding: composedHolding,
    aiLines,
    aiRequestIds: visible.map((l) => l.requestId),
  };
}

/** Collects the AI role requests for this founder and composes the morning-summary requests. */
export async function composeMorningRequests(
  ctx: ServiceContext,
  input: { waiting: readonly (WaitingNumber & { metricId?: string; waitingFor?: IsoDate })[]; holding: HoldingSection | null },
): Promise<ComposedRequests> {
  const items = ctx.user.role === "founder" ? await collectAiRequests(ctx) : [];
  const composed = composeRequests(items, input.waiting, input.holding);
  // The Org Structure Expert: at most ONE line, Mondays only (see org-expert.ts). A failure
  // never costs the founder the rest of the summary.
  const org = await orgExpertSummaryLines(ctx).catch((err: unknown) => {
    console.error("[orchestrator] org expert line failed", err);
    return [];
  });
  if (org.length) {
    composed.aiLines = composed.aiLines.length ? [...composed.aiLines, ...org] : [{ text: "AI roles", style: "heading" }, ...org];
  }
  return composed;
}
