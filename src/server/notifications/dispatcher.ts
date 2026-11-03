import "server-only";
import { and, asc, count, eq, gt, gte, inArray, isNull, lt, lte, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { todayInTimeZone, addDays, isWithinWindow, windowEndAfter, zonedTimeToUtc } from "@/lib/dates";
import type { Db } from "@/server/db/connect";
import { notificationsOutbox, reminderSnoozes, type OutboxItem } from "@/server/db/schema";
import { makeContext, type ServiceContext } from "@/server/services/context";
import { composeMorningRequests } from "@/server/ai/orchestrator";
import { buildReportReadyMessage, markRequestsShown, REPORT_KIND, reportParkedLine } from "@/server/services/ai-roles";
import { holdingSummarySection, markAskItemsShown } from "@/server/services/holding-asks";
import { staleMetricsFor } from "@/server/services/metrics";
import { getTask, getTodaySummary, type TaskView } from "@/server/services/tasks";
import { mintActionTokens } from "./action-tokens";
import { createChannelRegistry, type ChannelRegistry } from "./channels";
import { getFounder, listFounders } from "./founders";
import { getLinkForUser } from "./linking";
import { buildEveningCheck, buildMorningSummary, buildTaskMessage, parkedLine, type ParkedItem } from "./messages";
import { loadPreferences, type Preferences } from "./preferences";
import { fitTelegram } from "./render-telegram";
import { aiRequestRef, holdingRef, isSummaryKind, parkedRef, SUMMARY_KINDS, type NeutralMessage, type NotificationKind } from "./types";

export const MAX_ATTEMPTS = 5;
/** Retry delays after the 1st, 2nd, 3rd, 4th failure. */
export const BACKOFF_MINUTES = [1, 5, 15, 60];
/**
 * A claimed ("sending") item is invisible to other runs. Only when its claim is older than
 * this (wall clock) is the run that claimed it presumed dead; the item is then taken again
 * and that counts as an attempt. Generous on purpose: a Telegram call times out after 10 s.
 */
export const STALE_CLAIM_MS = 10 * 60_000;
/**
 * Pushes about tasks with priority "urgent" have their own small daily cap (they do not use
 * the normal budget). Beyond it they are parked like everything else.
 */
export const URGENT_TASK_PUSHES_PER_DAY = 2;

export interface DispatchReport {
  sent: number;
  held: number;
  parked: number;
  cancelled: number;
  retrying: number;
  failed: number;
  /** Held because Telegram is configured but the founder has not linked a chat. */
  notLinked: number;
}

export interface DispatchOptions {
  registry?: ChannelRegistry;
  limit?: number;
  timeZone?: string;
  /** Only these founders (the dev tick dispatches for the signed-in founder only). */
  userIds?: readonly string[];
  /** Wall clock for claims. Defaults to the real clock; tests inject one. */
  clock?: () => Date;
}

const PRIORITY_RANK = sql<number>`case ${notificationsOutbox.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`;
const NOT_TASK_PUSH_KINDS = [...SUMMARY_KINDS, "urgent"];

export function backoffMs(attempts: number): number {
  const i = Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1;
  return BACKOFF_MINUTES[i]! * 60_000;
}

/** May pass quiet hours when the founder turned on "urgent at night". */
export function isUrgentItem(item: Pick<OutboxItem, "kind" | "priority">): boolean {
  return item.kind === "urgent" || item.priority === "urgent";
}

/**
 * Which daily allowance an item uses:
 * - "summary": morning summary / evening check, one each per day;
 * - "urgent": an explicit `urgent` notification, outside any budget;
 * - "urgent_task": a push about a task with priority urgent, URGENT_TASK_PUSHES_PER_DAY;
 * - "normal": everything else, the founder's "max other pushes per day".
 */
export type BudgetClass = "summary" | "urgent" | "urgent_task" | "normal";

export function budgetClass(item: Pick<OutboxItem, "kind" | "priority">): BudgetClass {
  if (isSummaryKind(item.kind)) return "summary";
  if (item.kind === "urgent") return "urgent";
  return item.priority === "urgent" ? "urgent_task" : "normal";
}

/** Local-day bounds [start, end) for budget counting. */
function dayBounds(now: Date, tz: string): { start: Date; end: Date } {
  const today = todayInTimeZone(now, tz);
  return { start: zonedTimeToUtc(today, "00:00", tz), end: zonedTimeToUtc(addDays(today, 1), "00:00", tz) };
}

/**
 * Pushes already used today by this item's founder that match `filter`: sent today, or
 * being sent right now by another run (so overlapping runs cannot both spend the last slot).
 */
async function usedToday(db: Db, item: OutboxItem, now: Date, tz: string, filter: SQL): Promise<number> {
  const { start, end } = dayBounds(now, tz);
  const [row] = await db
    .select({ n: count() })
    .from(notificationsOutbox)
    .where(
      and(
        eq(notificationsOutbox.userId, item.userId),
        ne(notificationsOutbox.id, item.id),
        filter,
        or(
          and(eq(notificationsOutbox.status, "sent"), gte(notificationsOutbox.sentAt, start), lt(notificationsOutbox.sentAt, end)),
          eq(notificationsOutbox.status, "sending"),
        ),
      ),
    );
  return row?.n ?? 0;
}

function budgetFilter(cls: Exclude<BudgetClass, "urgent">, item: OutboxItem): SQL {
  if (cls === "summary") return eq(notificationsOutbox.kind, item.kind);
  return and(
    notInArray(notificationsOutbox.kind, NOT_TASK_PUSH_KINDS),
    cls === "urgent_task" ? eq(notificationsOutbox.priority, "urgent") : ne(notificationsOutbox.priority, "urgent"),
  )!;
}

/** A non-urgent push due this close before the morning summary is folded into it. */
export const FOLD_BEFORE_SUMMARY_MINUTES = 60;

/**
 * Should this non-urgent push wait for today's morning summary instead of arriving on its
 * own just before it? Yes when today's summary has not gone out yet and now is within
 * FOLD_BEFORE_SUMMARY_MINUTES before it, or anywhere between the end of quiet hours and the
 * summary (everything held overnight lands in the summary). Also in the same run as the
 * summary: once it is due and still waiting (a tick a little late), for up to the same window
 * after its time.
 */
async function shouldFoldIntoSummary(db: Db, item: OutboxItem, now: Date, tz: string, prefs: Preferences): Promise<boolean> {
  if (budgetClass(item) !== "normal") return false;
  const today = todayInTimeZone(now, tz);
  const summaryAt = zonedTimeToUtc(today, prefs.morningSummaryTime, tz).getTime();
  const window = FOLD_BEFORE_SUMMARY_MINUTES * 60_000;
  let foldFrom = summaryAt - window;
  const quietEnd = zonedTimeToUtc(today, prefs.quietEnd, tz).getTime();
  if (quietEnd <= summaryAt) foldFrom = Math.min(foldFrom, quietEnd);
  const t = now.getTime();
  if (t < foldFrom || t >= summaryAt + window) return false;
  const [summary] = await db
    .select({ status: notificationsOutbox.status })
    .from(notificationsOutbox)
    .where(and(eq(notificationsOutbox.userId, item.userId), eq(notificationsOutbox.dedupeKey, `morning:${today}`)));
  if (t < summaryAt) return !summary || ["pending", "sending", "not_linked"].includes(summary.status);
  // Due now: fold only if it is still waiting and goes out in this run (it is claimable).
  return !!summary && (summary.status === "pending" || summary.status === "sending");
}

/**
 * Parked items not yet listed in a summary, re-checked and re-rendered from the tasks'
 * CURRENT state. Items whose task is closed, gone, or no longer due/overdue (deadline
 * moved) are dropped; one line per task (or report), carrying the refs of every row it covers.
 */
async function collectParked(ctx: ServiceContext): Promise<{ drop: string[]; items: ParkedItem[] }> {
  const rows = await ctx.db
    .select()
    .from(notificationsOutbox)
    .where(
      and(
        eq(notificationsOutbox.userId, ctx.user.id),
        eq(notificationsOutbox.status, "parked"),
        isNull(notificationsOutbox.bundledIntoId),
      ),
    )
    .orderBy(asc(notificationsOutbox.parkedAt));
  const today = todayInTimeZone(ctx.now, ctx.timeZone);
  const drop: string[] = [];
  const byKey = new Map<string, ParkedItem>();
  const add = (k: string, rowId: string, make: () => ParkedItem) => {
    const item = byKey.get(k) ?? make();
    item.refs = [...(item.refs ?? []), parkedRef(rowId)];
    byKey.set(k, item);
  };
  for (const r of rows) {
    if (r.kind === REPORT_KIND) {
      // A parked "report ready" push: one line, if the report still exists.
      const runId = (r.payload as { runId?: string }).runId;
      const line = runId ? await reportParkedLine(ctx, runId) : null;
      if (!line) {
        drop.push(r.id);
        continue;
      }
      add(`run:${runId}`, r.id, () => ({ text: line }));
      continue;
    }
    const task = r.taskId ? await getTask(ctx, r.taskId).catch(() => null) : null;
    const open = task && task.status !== "done" && task.status !== "cancelled";
    const relevant = open && (r.kind === "task_reminder" || task.isOverdue || task.dueDate === today);
    if (!task || !relevant) {
      drop.push(r.id);
      continue;
    }
    add(`task:${task.id}`, r.id, () => ({ text: parkedLine(task, today), taskId: task.id }));
  }
  return { drop, items: [...byKey.values()] };
}

type Built =
  | { message: NeutralMessage; dropParked?: string[]; holdingItemIds?: string[]; aiRequestIds?: string[] }
  | { skip: string; dropParked?: string[] };

async function buildFor(ctx: ServiceContext, item: OutboxItem): Promise<Built> {
  const kind = item.kind as NotificationKind;
  if (kind === "morning_summary" || kind === "evening_check") {
    const summary = await getTodaySummary(ctx);
    const parked = await collectParked(ctx);
    // Numbers waiting: a short section inside the morning summary only (no separate pushes).
    const waiting = kind === "morning_summary" ? await staleMetricsFor(ctx).catch((err: unknown) => {
            console.error("[dispatcher] numbers waiting failed", err);
            return [];
          }) : [];
    // Holding: the grouped "ask Elmurat" item(s), inside the morning summary only.
    const holding =
      kind === "morning_summary"
        ? await holdingSummarySection(ctx).catch((err: unknown) => {
            console.error("[dispatcher] holding section failed", err);
            return null;
          })
        : null;
    // Orchestrator: AI role data requests, de-duplicated against "Numbers waiting" and Holding.
    const composed =
      kind === "morning_summary"
        ? await composeMorningRequests(ctx, { waiting, holding }).catch((err: unknown) => {
            console.error("[dispatcher] AI role requests failed", err);
            return { waiting, holding, aiLines: [], aiRequestIds: [] };
          })
        : null;
    const message =
      kind === "morning_summary"
        ? buildMorningSummary(summary, parked.items, ctx.user.shortName, composed!.waiting, composed!.holding, composed!.aiLines)
        : buildEveningCheck(summary, parked.items);
    return message
      ? { message, dropParked: parked.drop, holdingItemIds: holding?.itemIds, aiRequestIds: composed?.aiRequestIds }
      : { skip: "nothing_to_send", dropParked: parked.drop };
  }
  if (kind === REPORT_KIND) {
    const runId = (item.payload as { runId?: string }).runId;
    const message = runId ? await buildReportReadyMessage(ctx, runId) : null;
    return message ? { message } : { skip: "report_gone" };
  }
  if (!item.taskId) return { skip: "no_task" };
  // getTask enforces visibility as the recipient: another founder's private task is "not found".
  const task: TaskView | null = await getTask(ctx, item.taskId).catch(() => null);
  if (!task) return { skip: "task_gone" };
  if (task.status === "done" || task.status === "cancelled") return { skip: "task_closed" };
  const today = todayInTimeZone(ctx.now, ctx.timeZone);
  if (kind === "overdue_chase" && !task.isOverdue) return { skip: "no_longer_overdue" };
  if (kind === "task_due_today" && task.dueDate !== today) return { skip: "deadline_moved" };
  if (kind !== "task_reminder") {
    const [snooze] = await ctx.db
      .select({ id: reminderSnoozes.id })
      .from(reminderSnoozes)
      .where(
        and(
          eq(reminderSnoozes.userId, ctx.user.id),
          eq(reminderSnoozes.taskId, task.id),
          gt(reminderSnoozes.snoozedUntil, ctx.now),
        ),
      );
    if (snooze) return { skip: "snoozed" };
  }
  return { message: buildTaskMessage(kind, task, today) };
}

/**
 * Atomically claims the next due item: status "sending" + claimed_at (wall clock) in one
 * UPDATE over a `FOR UPDATE SKIP LOCKED` pick, so two overlapping runs can never take the
 * same row (on Postgres; PGlite runs one statement at a time, which is just as safe).
 * A "sending" row whose claim is older than STALE_CLAIM_MS is taken again, as one attempt.
 */
async function claimNext(db: Db, now: Date, wall: Date, userIds?: readonly string[]): Promise<OutboxItem | null> {
  const o = notificationsOutbox;
  const staleBefore = new Date(wall.getTime() - STALE_CLAIM_MS);
  const claimable = or(
    and(eq(o.status, "pending"), lte(o.scheduledFor, now), or(isNull(o.nextAttemptAt), lte(o.nextAttemptAt, now))),
    and(eq(o.status, "sending"), lt(o.claimedAt, staleBefore)),
  )!;
  const userFilter = userIds ? inArray(o.userId, [...userIds]) : undefined;
  const pick = db
    .select({ id: o.id })
    .from(o)
    .where(and(claimable, userFilter))
    .orderBy(asc(PRIORITY_RANK), asc(o.scheduledFor), asc(o.createdAt))
    .limit(1)
    .for("update", { skipLocked: true });
  const [row] = await db
    .update(o)
    .set({
      status: "sending",
      claimedAt: wall,
      // SET sees the old row: a stale claim (crashed run) counts as one attempt.
      attempts: sql`${o.attempts} + case when ${o.status} = 'sending' then 1 else 0 end`,
      lastError: sql`case when ${o.status} = 'sending' then 'stale_claim' else ${o.lastError} end`,
    })
    // "= (scalar subquery)" runs the pick once (InitPlan). "IN (subquery)" may be planned as
    // a join that claims more than one row.
    .where(and(eq(o.id, sql`(${pick})`), claimable))
    .returning();
  return row ?? null;
}

/** Items held as "not_linked" go back to the queue once their founder is reachable. */
async function releaseReachable(db: Db, registry: ChannelRegistry, userIds?: readonly string[]): Promise<void> {
  for (const founder of await listFounders(db)) {
    if (userIds && !userIds.includes(founder.id)) continue;
    const chatId = (await getLinkForUser(db, founder.id))?.chatId ?? null;
    if (!registry.resolve({ userId: founder.id, telegramChatId: chatId })) continue;
    await db
      .update(notificationsOutbox)
      .set({ status: "pending", nextAttemptAt: null, lastError: null })
      .where(and(eq(notificationsOutbox.userId, founder.id), eq(notificationsOutbox.status, "not_linked")));
  }
}

/**
 * Sends every due outbox item, respecting each founder's preferences:
 * - at most one push per task per local day, whatever its kind;
 * - quiet hours hold items (urgent ones too, unless "urgent at night" is on);
 * - summaries have their own daily slots; other pushes share a daily budget (urgent-priority
 *   tasks have their own cap of URGENT_TASK_PUSHES_PER_DAY) and the overflow is PARKED and
 *   listed in the next summary instead of being sent;
 * - with Telegram configured, a founder without a linked chat gets nothing: items are held
 *   as "not_linked" and flow once they link (if still valid);
 * - channel errors retry with backoff up to MAX_ATTEMPTS; an unexpected error affects only
 *   its own item.
 */
export async function dispatch(db: Db, now: Date, opts: DispatchOptions = {}): Promise<DispatchReport> {
  const registry = opts.registry ?? createChannelRegistry();
  const tz = opts.timeZone ?? (process.env.APP_TIMEZONE || "Asia/Bishkek");
  const clock = opts.clock ?? (() => new Date());
  const limit = opts.limit ?? 200;
  const report: DispatchReport = { sent: 0, held: 0, parked: 0, cancelled: 0, retrying: 0, failed: 0, notLinked: 0 };
  const prefsCache = new Map<string, Preferences>();

  await releaseReachable(db, registry, opts.userIds);

  for (let n = 0; n < limit; n++) {
    const item = await claimNext(db, now, clock(), opts.userIds);
    if (!item) break;
    const finish = (set: Partial<typeof notificationsOutbox.$inferInsert>) =>
      db
        .update(notificationsOutbox)
        .set({ claimedAt: null, ...set })
        .where(and(eq(notificationsOutbox.id, item.id), eq(notificationsOutbox.status, "sending")));
    try {
      await processItem(db, item, now, tz, registry, prefsCache, finish, report);
    } catch (err) {
      // One broken item must not stop the run for everyone else.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[notifications] item ${item.id} failed: ${message}`);
      const attempts = item.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      await finish({
        status: failed ? "failed" : "pending",
        attempts,
        lastError: `internal: ${message}`.slice(0, 300),
        nextAttemptAt: failed ? null : new Date(now.getTime() + backoffMs(attempts)),
      }).catch((e: unknown) => console.error("[notifications] could not record failure", e));
      if (failed) report.failed++;
      else report.retrying++;
    }
  }
  return report;
}

async function processItem(
  db: Db,
  item: OutboxItem,
  now: Date,
  tz: string,
  registry: ChannelRegistry,
  prefsCache: Map<string, Preferences>,
  finish: (set: Partial<typeof notificationsOutbox.$inferInsert>) => Promise<unknown>,
  report: DispatchReport,
): Promise<void> {
  const cancel = async (reason: string) => {
    await finish({ status: "cancelled", lastError: reason, nextAttemptAt: null });
    report.cancelled++;
  };

  if (item.attempts >= MAX_ATTEMPTS) {
    await finish({ status: "failed", nextAttemptAt: null });
    report.failed++;
    return;
  }
  const user = await getFounder(db, item.userId);
  if (!user) return cancel("not_a_founder");
  if (item.expiresAt && item.expiresAt.getTime() <= now.getTime()) return cancel("expired");

  // Re-read the link for every item: an unlink (or relink) takes effect immediately.
  const chatId = (await getLinkForUser(db, user.id))?.chatId ?? null;
  const recipient = { userId: user.id, telegramChatId: chatId };
  const channel = registry.resolve(recipient);
  if (!channel) {
    // Not delivered, so no budget used and no parked items bundled.
    await finish({ status: "not_linked", lastError: "not_linked", nextAttemptAt: null });
    report.notLinked++;
    return;
  }

  let prefs = prefsCache.get(user.id);
  if (!prefs) {
    prefs = await loadPreferences(db, user.id);
    prefsCache.set(user.id, prefs);
  }

  // Quiet hours: hold until they end.
  if (isWithinWindow(now, prefs.quietStart, prefs.quietEnd, tz) && !(isUrgentItem(item) && prefs.urgentAtNight)) {
    await finish({ status: "pending", nextAttemptAt: windowEndAfter(now, prefs.quietStart, prefs.quietEnd, tz) });
    report.held++;
    return;
  }

  // Just before the morning summary (or held overnight until it): no separate push, the
  // summary lists it (as a parked line, no budget used).
  if (await shouldFoldIntoSummary(db, item, now, tz, prefs)) {
    await finish({ status: "parked", parkedAt: now, nextAttemptAt: null, lastError: "folded_into_summary" });
    report.parked++;
    return;
  }

  // One push per task per local day, whatever the kind (backs up the planner's shared key).
  if (item.taskId && !isSummaryKind(item.kind)) {
    if ((await usedToday(db, item, now, tz, eq(notificationsOutbox.taskId, item.taskId))) > 0) {
      return cancel("already_pushed_today");
    }
  }

  // Budget.
  const cls = budgetClass(item);
  if (cls === "summary") {
    if ((await usedToday(db, item, now, tz, budgetFilter(cls, item))) >= 1) return cancel("already_sent_today");
  } else if (cls !== "urgent") {
    const cap = cls === "urgent_task" ? URGENT_TASK_PUSHES_PER_DAY : prefs.maxOtherPerDay;
    if ((await usedToday(db, item, now, tz, budgetFilter(cls, item))) >= cap) {
      await finish({
        status: "parked",
        parkedAt: now,
        nextAttemptAt: null,
        lastError: cls === "urgent_task" ? "urgent_cap_full" : "daily_budget_full",
      });
      report.parked++;
      return;
    }
  }

  const ctx = { ...makeContext(db, user, now), timeZone: tz };
  const built = await buildFor(ctx, item);
  if (built.dropParked?.length) {
    await db
      .update(notificationsOutbox)
      .set({ status: "cancelled", lastError: "no_longer_relevant" })
      .where(and(inArray(notificationsOutbox.id, built.dropParked), eq(notificationsOutbox.status, "parked")));
  }
  if ("skip" in built) return cancel(built.skip);

  // Fit Telegram's length limit by whole lines; only what made it into the text counts as
  // shown (holding asks, AI requests) or bundled (parked items). The rest waits for the next summary.
  const { message, keptRefs } = fitTelegram(built.message);
  const callbacks = message.actions?.length
    ? await mintActionTokens(db, { userId: user.id, outboxId: item.id, actions: message.actions, now })
    : undefined;
  const result = await channel.send(recipient, message, callbacks);
  const attempts = item.attempts + 1;

  if (result.ok) {
    await finish({
      status: "sent",
      sentAt: now,
      channel: channel.name,
      providerMessageId: result.providerMessageId ?? null,
      message,
      attempts,
      lastError: null,
      nextAttemptAt: null,
    });
    const shownAsks = (built.holdingItemIds ?? []).filter((id) => keptRefs.has(holdingRef(id)));
    const shownRequests = (built.aiRequestIds ?? []).filter((id) => keptRefs.has(aiRequestRef(id)));
    const bundle = [...keptRefs].filter((r) => r.startsWith("p:")).map((r) => r.slice(2));
    if (shownAsks.length) await markAskItemsShown(db, shownAsks, item.id, now);
    if (shownRequests.length) await markRequestsShown(db, shownRequests, todayInTimeZone(now, tz), item.id);
    if (bundle.length) {
      await db
        .update(notificationsOutbox)
        .set({ bundledIntoId: item.id })
        .where(
          and(
            inArray(notificationsOutbox.id, bundle),
            eq(notificationsOutbox.userId, user.id),
            eq(notificationsOutbox.status, "parked"),
            isNull(notificationsOutbox.bundledIntoId),
          ),
        );
    }
    report.sent++;
  } else if (result.permanent || attempts >= MAX_ATTEMPTS) {
    await finish({ status: "failed", attempts, lastError: result.error ?? "error", channel: channel.name, nextAttemptAt: null });
    report.failed++;
  } else {
    await finish({
      status: "pending",
      attempts,
      lastError: result.error ?? "error",
      channel: channel.name,
      nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)),
    });
    report.retrying++;
  }
}
