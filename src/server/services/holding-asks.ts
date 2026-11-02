import "server-only";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { isoWeekday, todayInTimeZone, type IsoDate } from "@/lib/dates";
import {
  askLine,
  countMonths,
  elmuratMessage,
  graceDays,
  reminderLine,
  REMINDER_AFTER_DAYS,
  type AskGroup,
} from "@/lib/holding";
import type { Db } from "@/server/db/connect";
import { holdingAskItems, type HoldingAskItem } from "@/server/db/schema";
import { listFounders } from "@/server/notifications/founders";
import type { MessageAction, MessageLine } from "@/server/notifications/types";
import { assertHoldingAccess, assertValidId } from "./access";
import { today, type ServiceContext } from "./context";
import { ServiceError } from "./errors";
import { allGridCells, groupCells, loadActsGrid, markCellsAsked, staleRequested, type ActCell, type ActsGrid } from "./holding";

/**
 * Pushing the founders to ask Elmurat (the accountant) for missing акты. Elmurat himself
 * never gets anything from the app: these items go only to the two founders, inside their
 * morning summary (no separate push, so no budget is used and nothing can pile up):
 *
 * - once a month, from the day after the grace period (default the 11th), ONE grouped
 *   "Ask Elmurat for N missing акты: …" item per founder (round = YYYY-MM);
 * - on Mondays, ONE reminder line per founder for акты asked for ≥ 7 days ago and still
 *   not received (round = that Monday, so at most weekly);
 * - both founders get it (holding matters are shared); when one taps "I asked Elmurat"
 *   (Telegram or in the app) the cells become "requested" and the other founder's pending
 *   item for the same months is cancelled.
 *
 * Items are shown once (in the next morning summary that goes out) and the unique index
 * (user, kind, round) makes planning idempotent: a tick every 5 minutes changes nothing.
 */

export type Cell = { flowId: string; period: IsoDate };

/** Day of the month the monthly ask is planned: the first day after the grace period. */
export function askDayOfMonth(grace = graceDays()): number {
  return grace + 1;
}

const key = (c: Cell) => `${c.flowId}|${c.period}`;

export interface HoldingPlanReport {
  created: number;
}

/** Planner hook (called from planTick for the founders being planned). */
export async function planHoldingAsks(
  db: Db,
  now: Date,
  timeZone: string,
  opts: { userIds?: readonly string[] } = {},
): Promise<HoldingPlanReport> {
  const todayIso = todayInTimeZone(now, timeZone);
  const founders = (await listFounders(db)).filter((f) => !opts.userIds || opts.userIds.includes(f.id));
  if (!founders.length) return { created: 0 };
  const grace = graceDays();
  const due: { kind: "ask" | "reminder"; roundKey: string }[] = [];
  if (Number(todayIso.slice(8, 10)) >= askDayOfMonth(grace)) due.push({ kind: "ask", roundKey: todayIso.slice(0, 7) });
  if (isoWeekday(todayIso) === 1) due.push({ kind: "reminder", roundKey: todayIso });
  if (!due.length) return { created: 0 };
  // Cheap exit for the many ticks after a round was planned: no grid needed.
  const existing = await db
    .select({ userId: holdingAskItems.userId, kind: holdingAskItems.kind, roundKey: holdingAskItems.roundKey })
    .from(holdingAskItems)
    .where(inArray(holdingAskItems.roundKey, due.map((d) => d.roundKey)));
  const have = new Set(existing.map((e) => `${e.userId}|${e.kind}|${e.roundKey}`));
  if (due.every((d) => founders.every((f) => have.has(`${f.id}|${d.kind}|${d.roundKey}`)))) return { created: 0 };
  const grid = await loadActsGrid(db, todayIso, { grace });
  const rounds: { kind: "ask" | "reminder"; roundKey: string; cells: Cell[] }[] = [];
  if (due.some((d) => d.kind === "ask")) {
    const { cells } = groupCells(grid, (c) => c.state === "missing");
    if (cells.length) rounds.push({ kind: "ask", roundKey: todayIso.slice(0, 7), cells });
  }
  if (due.some((d) => d.kind === "reminder")) {
    const { cells } = groupCells(grid, staleRequested(grid, REMINDER_AFTER_DAYS));
    if (cells.length) rounds.push({ kind: "reminder", roundKey: todayIso, cells });
  }
  let created = 0;
  for (const r of rounds) {
    for (const f of founders) {
      const rows = await db
        .insert(holdingAskItems)
        .values({ userId: f.id, kind: r.kind, roundKey: r.roundKey, cells: r.cells, createdAt: now })
        .onConflictDoNothing({ target: [holdingAskItems.userId, holdingAskItems.kind, holdingAskItems.roundKey] })
        .returning({ id: holdingAskItems.id });
      created += rows.length;
      // Anti-spam: the new round already covers every month still open (it is built from
      // the whole grid), so this founder's older undelivered items of the same kind (summary
      // not sent: not linked, failed send, quiet hours) are superseded, never stacked up.
      if (rows[0]) await supersedeOlder(db, f.id, r.kind, rows[0].id, now);
    }
  }
  return { created };
}

/** Cancels a founder's other pending items of `kind` (reason "superseded"); `keepId` stays. */
async function supersedeOlder(db: Db, userId: string, kind: "ask" | "reminder", keepId: string, now: Date): Promise<number> {
  const rows = await db
    .update(holdingAskItems)
    .set({ status: "cancelled", reason: "superseded", resolvedAt: now })
    .where(
      and(
        eq(holdingAskItems.userId, userId),
        eq(holdingAskItems.kind, kind),
        eq(holdingAskItems.status, "pending"),
        ne(holdingAskItems.id, keepId),
      ),
    )
    .returning({ id: holdingAskItems.id });
  return rows.length;
}

/** The item's cells that still need it: missing (ask) or asked ≥ 7 days ago and not received (reminder). */
function relevantCells(item: Pick<HoldingAskItem, "kind" | "cells">, grid: ActsGrid): ActCell[] {
  const byKey = new Map(allGridCells(grid).map((c) => [key(c), c]));
  const stale = staleRequested(grid, REMINDER_AFTER_DAYS);
  return item.cells
    .map((c) => byKey.get(key(c)))
    .filter((c): c is ActCell => !!c && (item.kind === "ask" ? c.state === "missing" : stale(c)));
}

function groupsFor(cells: readonly ActCell[], grid: ActsGrid): AskGroup[] {
  const wanted = new Set(cells.map(key));
  return groupCells(grid, (c) => wanted.has(key(c))).groups;
}

/**
 * Pending items are re-checked against the current акты: an item none of whose months
 * still need asking is cancelled (e.g. the other founder already asked), otherwise its
 * months are narrowed to those still open.
 */
export async function reconcileAskItems(db: Db, grid: ActsGrid, opts: { userId?: string; reason?: string; now: Date }): Promise<void> {
  const rows = await db
    .select()
    .from(holdingAskItems)
    .where(and(eq(holdingAskItems.status, "pending"), opts.userId ? eq(holdingAskItems.userId, opts.userId) : undefined));
  for (const item of rows) {
    const still = relevantCells(item, grid);
    if (!still.length) {
      await db
        .update(holdingAskItems)
        .set({ status: "cancelled", reason: opts.reason ?? "no_longer_relevant", resolvedAt: opts.now })
        .where(and(eq(holdingAskItems.id, item.id), eq(holdingAskItems.status, "pending")));
    } else if (still.length !== item.cells.length) {
      await db
        .update(holdingAskItems)
        .set({ cells: still.map((c) => ({ flowId: c.flowId, period: c.period })) })
        .where(and(eq(holdingAskItems.id, item.id), eq(holdingAskItems.status, "pending")));
    }
  }
}

export interface HoldingSection {
  lines: MessageLine[];
  actions: MessageAction[];
  itemIds: string[];
}

export const ASK_BUTTON_LABEL = "I asked Elmurat";
export const ASK_AGAIN_BUTTON_LABEL = "I asked again";

/**
 * The "Holding · акты" section of a founder's morning summary: at most ONE line (and one
 * button) per kind — the ask and the "still waiting" reminder. The planner already
 * supersedes older rounds; as a backstop, if several items of one kind are still pending
 * their open months are merged (de-duplicated) into the newest item and the older ones are
 * cancelled as "superseded", so the button covers every month on the line. A month that is
 * both missing and on a reminder can't happen (a cell is either missing or requested).
 * Null when there is nothing to ask.
 */
export async function holdingSummarySection(ctx: ServiceContext): Promise<HoldingSection | null> {
  const pending = await ctx.db
    .select()
    .from(holdingAskItems)
    .where(and(eq(holdingAskItems.userId, ctx.user.id), eq(holdingAskItems.status, "pending")))
    .orderBy(asc(holdingAskItems.kind), asc(holdingAskItems.createdAt));
  if (!pending.length) return null;
  const todayIso = today(ctx);
  const grid = await loadActsGrid(ctx.db, todayIso);
  await reconcileAskItems(ctx.db, grid, { userId: ctx.user.id, now: ctx.now });
  const lines: MessageLine[] = [];
  const actions: MessageAction[] = [];
  const itemIds: string[] = [];
  for (const kind of ["ask", "reminder"] as const) {
    const ofKind = pending.filter((i) => i.kind === kind);
    if (!ofKind.length) continue;
    const newest = ofKind[ofKind.length - 1]!;
    const seen = new Set<string>();
    const cells: ActCell[] = [];
    for (const item of ofKind) {
      for (const c of relevantCells(item, grid)) {
        if (seen.has(key(c))) continue;
        seen.add(key(c));
        cells.push(c);
      }
    }
    if (ofKind.length > 1) {
      if (cells.length) {
        await ctx.db
          .update(holdingAskItems)
          .set({ cells: cells.map((c) => ({ flowId: c.flowId, period: c.period })) })
          .where(and(eq(holdingAskItems.id, newest.id), eq(holdingAskItems.status, "pending")));
      }
      await supersedeOlder(ctx.db, ctx.user.id, kind, newest.id, ctx.now);
    }
    if (!cells.length) continue;
    const groups = groupsFor(cells, grid);
    if (kind === "ask") {
      lines.push({ text: askLine(groups, todayIso), style: "item" });
      actions.push({ label: ASK_BUTTON_LABEL, action: "holding_asked", askId: newest.id });
    } else {
      const askedOn = cells.map((c) => c.requestedOn!).sort()[0] ?? null;
      lines.push({ text: reminderLine(groups, todayIso, askedOn), style: "item" });
      actions.push({ label: ASK_AGAIN_BUTTON_LABEL, action: "holding_asked", askId: newest.id });
    }
    itemIds.push(newest.id);
  }
  if (!lines.length) return null;
  return {
    lines: [
      { text: "Holding · акты", style: "heading" },
      ...lines,
      { text: "The message for Elmurat is ready to copy on the Holding page. Tap the button once you have asked.", style: "muted" },
    ],
    actions,
    itemIds,
  };
}

/** After the summary went out: those items were shown (never shown again). */
export async function markAskItemsShown(db: Db, ids: readonly string[], outboxId: string, now: Date): Promise<void> {
  if (!ids.length) return;
  await db
    .update(holdingAskItems)
    .set({ status: "shown", shownAt: now, outboxId })
    .where(and(inArray(holdingAskItems.id, [...ids]), eq(holdingAskItems.status, "pending")));
}

/** After a founder asked: their own items about those months are done, the other founder's pending ones cancelled. */
async function afterAsked(ctx: ServiceContext, changed: readonly Cell[], extraItemId?: string): Promise<void> {
  const changedKeys = new Set(changed.map(key));
  const mine = await ctx.db
    .select()
    .from(holdingAskItems)
    .where(and(eq(holdingAskItems.userId, ctx.user.id), inArray(holdingAskItems.status, ["pending", "shown"])));
  for (const item of mine) {
    if (item.id !== extraItemId && !item.cells.some((c) => changedKeys.has(key(c)))) continue;
    await ctx.db
      .update(holdingAskItems)
      .set({ status: "done", resolvedAt: ctx.now, resolvedBy: ctx.user.id, reason: "asked" })
      .where(eq(holdingAskItems.id, item.id));
  }
  const grid = await loadActsGrid(ctx.db, today(ctx));
  await reconcileAskItems(ctx.db, grid, { reason: `asked_by:${ctx.user.shortName}`, now: ctx.now });
}

function monthsWord(n: number): string {
  return n === 1 ? "1 акт" : `${n} акты`;
}

/**
 * The "I asked Elmurat" button (Telegram), as the founder who tapped it. Works once per
 * item; when the other founder already asked, nothing changes and it says so.
 */
export async function applyHoldingAskAction(ctx: ServiceContext, askId: string): Promise<string> {
  assertHoldingAccess(ctx);
  assertValidId(askId, "Item");
  const [item] = await ctx.db
    .select()
    .from(holdingAskItems)
    .where(and(eq(holdingAskItems.id, askId), eq(holdingAskItems.userId, ctx.user.id)));
  if (!item) throw new ServiceError("not_found", "Item not found");
  const grid = await loadActsGrid(ctx.db, today(ctx));
  const byKey = new Map(allGridCells(grid).map((c) => [key(c), c]));
  const cells = item.cells.map((c) => byKey.get(key(c))).filter((c): c is ActCell => !!c);
  const open = cells.filter((c) => (item.kind === "ask" ? c.state === "missing" : c.state === "requested"));
  if (!open.length) {
    await afterAsked(ctx, [], item.id);
    const other = cells.find((c) => c.state === "requested" && c.requestedBy);
    return other?.requestedBy && other.requestedOn
      ? `Already done: ${other.requestedBy} marked these as asked on ${other.requestedOn}.`
      : "Nothing to do: these акты are no longer missing.";
  }
  const changed = await markCellsAsked(ctx, open, item.kind === "ask" ? "missing" : "again");
  await afterAsked(ctx, changed, item.id);
  return `Marked ${monthsWord(changed.length)} as asked today. The message for Elmurat is on the Holding page.`;
}

/** The in-app "I asked Elmurat" button (Holding page). */
export async function markAskedInApp(ctx: ServiceContext, cells: readonly Cell[], mode: "missing" | "again"): Promise<number> {
  assertHoldingAccess(ctx);
  const changed = await markCellsAsked(ctx, cells, mode);
  await afterAsked(ctx, changed);
  return changed.length;
}

export interface AskCard {
  missing: { groups: AskGroup[]; cells: Cell[]; count: number };
  waiting: { groups: AskGroup[]; cells: Cell[]; count: number; askedOn: IsoDate | null };
  /** Copyable Russian message for Elmurat (the app never sends it). */
  message: string;
}

/** The Holding page card: what to ask Elmurat for now, and the message to copy. */
export function askCardFromGrid(grid: ActsGrid): AskCard {
  const missing = groupCells(grid, (c) => c.state === "missing");
  const stale = staleRequested(grid, REMINDER_AFTER_DAYS);
  const waiting = groupCells(grid, stale);
  const askedOn =
    allGridCells(grid)
      .filter(stale)
      .map((c) => c.requestedOn!)
      .sort()[0] ?? null;
  // One message covering both: what is missing and what he still owes after a week.
  const all = new Map<string, AskGroup>();
  for (const g of [...missing.groups, ...waiting.groups]) {
    const k = `${g.label}|${g.service}`;
    const prev = all.get(k);
    all.set(k, prev ? { ...prev, months: [...new Set([...prev.months, ...g.months])].sort() } : g);
  }
  return {
    missing: { ...missing, count: countMonths(missing.groups) },
    waiting: { ...waiting, count: countMonths(waiting.groups), askedOn },
    message: elmuratMessage([...all.values()]),
  };
}
