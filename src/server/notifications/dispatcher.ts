import "server-only";
import { and, asc, count, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { todayInTimeZone, addDays, isWithinWindow, windowEndAfter, zonedTimeToUtc } from "@/lib/dates";
import type { Db } from "@/server/db/connect";
import { notificationsOutbox, reminderSnoozes, type OutboxItem } from "@/server/db/schema";
import { makeContext, type ServiceContext } from "@/server/services/context";
import { composeMorningRequests } from "@/server/ai/orchestrator";
import { buildReportReadyMessage, markRequestsShown, REPORT_KIND, reportParkedLine } from "@/server/services/ai-roles";
import { holdingSummarySection, markAskItemsShown } from "@/server/services/holding-asks";
import { staleMetricsFor } from "@/server/services/metrics";
import { lockTransaction } from "@/server/services/locks";
import { getTask, getTodaySummary, type TaskView } from "@/server/services/tasks";
import { mintActionTokens } from "./action-tokens";
import { createChannelRegistry, type ChannelRegistry } from "./channels";
import { getFounder, listFounders } from "./founders";
import { getLinkForUser } from "./linking";
import { buildEveningCheck, buildGroupedChase, buildMorningSummary, buildTaskMessage, parkedLine, type ParkedItem } from "./messages";
import { loadPreferences, type Preferences } from "./preferences";
import { fitTelegram } from "./render-telegram";
import { processPersonItem } from "./staff-dispatcher";
import { loadStaffDefaults } from "@/server/services/staff";
import { taskDeadlineRequests } from "@/server/db/schema";
import {
  aiRequestRef,
  holdingRef,
  isSummaryKind,
  parkedRef,
  SUMMARY_KINDS,
  taskRef,
  type NeutralMessage,
  type NotificationChannel,
  type NotificationKind,
  type Recipient,
} from "./types";

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
  /** Also send staff (person) rows. Default true. The founders' dev tick passes false. */
  staff?: boolean;
  /** Only staff (person) rows (the dev-only "Simulate staff tick"). */
  onlyStaff?: boolean;
}

const PRIORITY_RANK = sql<number>`case ${notificationsOutbox.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`;
const NOT_TASK_PUSH_KINDS = [...SUMMARY_KINDS, "urgent"];

/** An outbox row addressed to a founder (user_id set). Person rows go through staff-dispatcher.ts. */
export type FounderItem = OutboxItem & { userId: string };

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
async function usedToday(db: Db, item: FounderItem, now: Date, tz: string, filter: SQL): Promise<number> {
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

/**
 * "One push per task per day": the pushes that count as this task's touch today. A `staff_update`
 * (a team member's answer / help / deadline request / escalation about the task) does NOT count: it
 * is news from the team, not a reminder, so it never cancels the founder's own due-today nudge or
 * chase. It still uses the daily budget like any push.
 */
function taskTouchFilter(taskId: string): SQL {
  return and(eq(notificationsOutbox.taskId, taskId), ne(notificationsOutbox.kind, "staff_update"))!;
}

function budgetFilter(cls: Exclude<BudgetClass, "urgent">, item: FounderItem): SQL {
  if (cls === "summary") return eq(notificationsOutbox.kind, item.kind);
  return and(
    notInArray(notificationsOutbox.kind, NOT_TASK_PUSH_KINDS),
    // Tasks listed inside a grouped overdue push (sent rows bundled into it) do not count:
    // the grouped push itself is the one push.
    isNull(notificationsOutbox.bundledIntoId),
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
async function shouldFoldIntoSummary(db: Db, item: FounderItem, now: Date, tz: string, prefs: Preferences): Promise<boolean> {
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
    if (r.kind === "staff_update") {
      // A line about the team (done, a reply, an escalation): shown as it was written, no task
      // id (so it is never merged into a task line of the same message).
      const p = r.payload as { summaryLine?: string; requestId?: string | null };
      const line = p.summaryLine;
      if (!line) {
        drop.push(r.id);
        continue;
      }
      // A deadline request already approved / declined (e.g. on the task page): nothing to ask.
      if (p.requestId) {
        const [req] = await ctx.db
          .select({ status: taskDeadlineRequests.status })
          .from(taskDeadlineRequests)
          .where(eq(taskDeadlineRequests.id, p.requestId));
        if (!req || req.status !== "pending") {
          drop.push(r.id);
          continue;
        }
      }
      add(`staff:${r.id}`, r.id, () => ({ text: line }));
      continue;
    }
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
  if (kind === "staff_update") {
    const p = item.payload as { message?: NeutralMessage; requestId?: string | null };
    if (!p.message) return { skip: "nothing_to_send" };
    if (p.requestId) {
      const [req] = await ctx.db
        .select({ status: taskDeadlineRequests.status })
        .from(taskDeadlineRequests)
        .where(eq(taskDeadlineRequests.id, p.requestId));
      if (!req || req.status !== "pending") return { skip: "request_decided" };
    }
    return { message: p.message };
  }
  if (kind === REPORT_KIND) {
    const runId = (item.payload as { runId?: string }).runId;
    const message = runId ? await buildReportReadyMessage(ctx, runId) : null;
    return message ? { message } : { skip: "report_gone" };
  }
  const loaded = await loadTaskForPush(ctx, item);
  if ("skip" in loaded) return loaded;
  return { message: buildTaskMessage(kind, loaded.task, todayInTimeZone(ctx.now, ctx.timeZone)) };
}

/** The task a task push is about, as the recipient, or why the push no longer makes sense. */
async function loadTaskForPush(ctx: ServiceContext, item: OutboxItem): Promise<{ task: TaskView } | { skip: string }> {
  const kind = item.kind as NotificationKind;
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
  return { task };
}

/**
 * Atomically claims the next due item: status "sending" + claimed_at (wall clock) in one
 * UPDATE over a `FOR UPDATE SKIP LOCKED` pick, so two overlapping runs can never take the
 * same row (on Postgres; PGlite runs one statement at a time, which is just as safe).
 * A "sending" row whose claim is older than STALE_CLAIM_MS is taken again, as one attempt.
 */
async function claimNext(
  db: Db,
  now: Date,
  wall: Date,
  userIds?: readonly string[],
  staff = true,
): Promise<OutboxItem | null> {
  const o = notificationsOutbox;
  const staleBefore = new Date(wall.getTime() - STALE_CLAIM_MS);
  const claimable = or(
    and(eq(o.status, "pending"), lte(o.scheduledFor, now), or(isNull(o.nextAttemptAt), lte(o.nextAttemptAt, now))),
    and(eq(o.status, "sending"), lt(o.claimedAt, staleBefore)),
  )!;
  const userFilter = userIds
    ? staff
      ? userIds.length
        ? or(inArray(o.userId, [...userIds]), isNotNull(o.personId))
        : isNotNull(o.personId)
      : userIds.length
        ? inArray(o.userId, [...userIds])
        : sql`false`
    : staff
      ? undefined
      : isNotNull(o.userId);
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
  let staffDefaults: Awaited<ReturnType<typeof loadStaffDefaults>> | undefined;

  if (!opts.onlyStaff) await releaseReachable(db, registry, opts.userIds);

  for (let n = 0; n < limit; n++) {
    const item = await claimNext(db, now, clock(), opts.onlyStaff ? [] : opts.userIds, opts.staff !== false || !!opts.onlyStaff);
    if (!item) break;
    const finish = (set: Partial<typeof notificationsOutbox.$inferInsert>) =>
      db
        .update(notificationsOutbox)
        .set({ claimedAt: null, ...set })
        .where(and(eq(notificationsOutbox.id, item.id), eq(notificationsOutbox.status, "sending")));
    try {
      if (item.personId) {
        staffDefaults ??= await loadStaffDefaults(db);
        await processPersonItem(db, item as OutboxItem & { personId: string }, now, tz, registry, finish, report, {
          maxAttempts: MAX_ATTEMPTS,
          backoffMs,
          defaults: staffDefaults,
        });
        continue;
      }
      await processItem(db, item, now, tz, registry, prefsCache, finish, report, clock);
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
  clock: () => Date,
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
  if (!item.userId) return cancel("not_a_founder");
  const user = await getFounder(db, item.userId);
  if (!user) return cancel("not_a_founder");
  const founderItem = item as FounderItem;
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

  // Chase style "summary_only": overdue tasks are only listed in the morning summary.
  if (item.kind === "overdue_chase" && prefs.overdueChaseStyle === "summary_only") return cancel("chase_summary_only");

  // Quiet hours: hold until they end.
  if (isWithinWindow(now, prefs.quietStart, prefs.quietEnd, tz) && !(isUrgentItem(item) && prefs.urgentAtNight)) {
    await finish({ status: "pending", nextAttemptAt: windowEndAfter(now, prefs.quietStart, prefs.quietEnd, tz) });
    report.held++;
    return;
  }

  // Just before the morning summary (or held overnight until it): no separate push, the
  // summary lists it (as a parked line, no budget used).
  if (await shouldFoldIntoSummary(db, founderItem, now, tz, prefs)) {
    await finish({ status: "parked", parkedAt: now, nextAttemptAt: null, lastError: "folded_into_summary" });
    report.parked++;
    return;
  }

  // One push per task per local day, whatever the kind (backs up the planner's shared key).
  if (item.taskId && !isSummaryKind(item.kind) && item.kind !== "staff_update") {
    if ((await usedToday(db, founderItem, now, tz, taskTouchFilter(item.taskId))) > 0) {
      return cancel("already_pushed_today");
    }
  }

  // Budget.
  const cls = budgetClass(item);
  if (cls === "summary") {
    if ((await usedToday(db, founderItem, now, tz, budgetFilter(cls, founderItem))) >= 1) return cancel("already_sent_today");
  } else if (cls !== "urgent") {
    const cap = cls === "urgent_task" ? URGENT_TASK_PUSHES_PER_DAY : prefs.maxOtherPerDay;
    if ((await usedToday(db, founderItem, now, tz, budgetFilter(cls, founderItem))) >= cap) {
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
  if (item.kind === "overdue_chase" && prefs.overdueChaseStyle === "grouped") {
    return sendGroupedChase(ctx, founderItem, channel, recipient, finish, report, clock());
  }
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

/**
 * Chase style "grouped": the first overdue chase claimed for a founder (the highest priority,
 * already past quiet hours, the fold-into-summary rule, the one-push-per-task check and the
 * budget of its class) takes every other overdue chase of that founder due today and sends
 * ONE message listing them, with Done / +1 day / +3 days per task. Rules:
 * - it counts as one push against the budget (the tasks listed are stored as sent rows
 *   bundled into it, which `budgetFilter` does not count);
 * - it is the day's touch for every task listed (their own rows are sent), so a snooze
 *   reminder or any other push for those tasks later that day is cancelled;
 * - tasks that are no longer due a chase are dropped (same reasons as a single push); tasks
 *   that did not fit (MAX_GROUPED_CHASE_TASKS, Telegram's limit) are cancelled as
 *   `grouped_not_listed` and are not touched — the leader too: the message, its buttons and
 *   the budget are then carried by the first listed row (the list is ordered by task priority
 *   and days overdue, the claim order by outbox priority, so they can differ);
 * - on a failed send the other rows wait with the same backoff and go out together again;
 * - at most ONE grouped push per founder per local day, also with overlapping runs (each run
 *   claims its own leader): under an advisory lock on `grouped_chase:<user>:<day>` the leader
 *   is marked `payload.groupedChaseDay`; if another row of that founder already carries
 *   today's mark and is sent or being sent, this leader is parked (`grouped_already_sent`)
 *   and listed in the next summary instead.
 */
async function sendGroupedChase(
  ctx: ServiceContext,
  leader: FounderItem,
  channel: NotificationChannel,
  recipient: Recipient,
  finish: (set: Partial<typeof notificationsOutbox.$inferInsert>) => Promise<unknown>,
  report: DispatchReport,
  wall: Date,
): Promise<void> {
  const db = ctx.db;
  const now = ctx.now;
  const o = notificationsOutbox;
  const { start, end } = dayBounds(now, ctx.timeZone);
  const today = todayInTimeZone(now, ctx.timeZone);
  const groupedMark = { groupedChaseDay: today };
  const alreadyGrouped = await db.transaction(async (tx) => {
    await lockTransaction(tx as unknown as Db, `grouped_chase:${leader.userId}:${today}`);
    const [other] = await tx
      .select({ id: o.id })
      .from(o)
      .where(
        and(
          eq(o.userId, leader.userId),
          eq(o.kind, "overdue_chase"),
          ne(o.id, leader.id),
          isNull(o.bundledIntoId),
          sql`(${o.payload} ->> 'groupedChaseDay') = ${today}`,
          or(eq(o.status, "sent"), eq(o.status, "sending")),
        ),
      )
      .limit(1);
    if (other) return true;
    await tx
      .update(o)
      .set({ payload: sql`${o.payload} || ${JSON.stringify(groupedMark)}::jsonb` })
      .where(eq(o.id, leader.id));
    return false;
  });
  if (alreadyGrouped) {
    await finish({ status: "parked", parkedAt: now, nextAttemptAt: null, lastError: "grouped_already_sent" });
    report.parked++;
    return;
  }
  const followers = await db
    .update(o)
    .set({ status: "sending", claimedAt: wall })
    .where(
      and(
        eq(o.userId, leader.userId),
        eq(o.kind, "overdue_chase"),
        eq(o.status, "pending"),
        ne(o.id, leader.id),
        lte(o.scheduledFor, now),
        gte(o.scheduledFor, start),
        lt(o.scheduledFor, end),
        or(isNull(o.nextAttemptAt), lte(o.nextAttemptAt, now)),
        or(isNull(o.expiresAt), gt(o.expiresAt, now)),
      ),
    )
    .returning() as FounderItem[];
  const setRow = (id: string, set: Partial<typeof o.$inferInsert>) =>
    db
      .update(o)
      .set({ claimedAt: null, ...set })
      .where(and(eq(o.id, id), eq(o.status, "sending")));

  // Same checks as a single push, per task.
  const valid: { row: OutboxItem; task: TaskView }[] = [];
  let leaderSkip: string | null = null;
  const seenTasks = new Set<string>();
  for (const row of [leader, ...followers]) {
    let skip: string | null = null;
    if (row.taskId && seenTasks.has(row.taskId)) skip = "already_pushed_today";
    else if (row.taskId && row.id !== leader.id && (await usedToday(db, row, now, ctx.timeZone, taskTouchFilter(row.taskId))) > 0) {
      skip = "already_pushed_today";
    }
    const loaded = skip ? { skip } : await loadTaskForPush(ctx, row);
    if ("skip" in loaded) {
      if (row.id === leader.id) leaderSkip = loaded.skip;
      else {
        await setRow(row.id, { status: "cancelled", lastError: loaded.skip, nextAttemptAt: null });
        report.cancelled++;
      }
      continue;
    }
    seenTasks.add(loaded.task.id);
    valid.push({ row, task: loaded.task });
  }
  if (!valid.length) {
    await finish({ status: "cancelled", lastError: leaderSkip ?? "nothing_to_send", nextAttemptAt: null });
    report.cancelled++;
    return;
  }

  // Highest priority first, then the longest overdue.
  const rank: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  valid.sort(
    (x, y) =>
      (rank[x.task.priority] ?? 9) - (rank[y.task.priority] ?? 9) || (x.task.dueDate ?? "").localeCompare(y.task.dueDate ?? ""),
  );
  const built = buildGroupedChase(valid.map((v) => v.task), today);
  const { message, keptRefs } = fitTelegram(built.message);
  const listed = new Set(built.listed.filter((id) => keptRefs.has(taskRef(id))));
  // The message is carried by the first LISTED row (the documented order, highest priority
  // first): the leader (the row claimNext picked) can fall past the cap or be cut by
  // fitTelegram (outbox priority does not tell low from normal), and a row whose task is not
  // in the message must never be finished "sent" (that would be its task's touch for today).
  const carrier = valid.find((v) => listed.has(v.task.id));
  const setLeader = (set: Partial<typeof o.$inferInsert>) => finish(set);
  if (!carrier) {
    // Cannot happen with 300-character titles; nothing listed, nothing sent, nothing touched.
    for (const v of valid) {
      if (v.row.id === leader.id) continue;
      await setRow(v.row.id, { status: "cancelled", lastError: "grouped_not_listed", nextAttemptAt: null });
      report.cancelled++;
    }
    await setLeader({ status: "cancelled", lastError: leaderSkip ?? "grouped_not_listed", nextAttemptAt: null });
    report.cancelled++;
    return;
  }
  const carrierIsLeader = carrier.row.id === leader.id;
  const setCarrier = (set: Partial<typeof o.$inferInsert>) => (carrierIsLeader ? finish(set) : setRow(carrier.row.id, set));
  const callbacks = message.actions?.length
    ? await mintActionTokens(db, { userId: leader.userId, outboxId: carrier.row.id, actions: message.actions, now })
    : undefined;
  const result = await channel.send(recipient, message, callbacks);
  const attempts = carrier.row.attempts + 1;
  const others = valid.filter((v) => v.row.id !== carrier.row.id && v.row.id !== leader.id);
  const leaderValid = !carrierIsLeader && valid.some((v) => v.row.id === leader.id);

  if (result.ok) {
    await setCarrier({
      status: "sent",
      sentAt: now,
      channel: channel.name,
      providerMessageId: result.providerMessageId ?? null,
      message,
      attempts,
      lastError: null,
      nextAttemptAt: null,
      bundledIntoId: null,
      payload: { ...(carrier.row.payload as Record<string, unknown>), ...groupedMark, groupedTaskIds: [...listed] },
    });
    if (!carrierIsLeader) {
      // Not in the message: not touched today (a snooze reminder later today still goes out).
      await setLeader({ status: "cancelled", lastError: leaderSkip ?? "grouped_not_listed", nextAttemptAt: null });
      report.cancelled++;
    }
    for (const v of others) {
      if (listed.has(v.task.id)) {
        await setRow(v.row.id, { status: "sent", sentAt: now, channel: channel.name, bundledIntoId: carrier.row.id, lastError: null, nextAttemptAt: null });
      } else {
        await setRow(v.row.id, { status: "cancelled", lastError: "grouped_not_listed", nextAttemptAt: null });
        report.cancelled++;
      }
    }
    report.sent++;
    return;
  }
  const failed = result.permanent || attempts >= MAX_ATTEMPTS;
  const nextAttemptAt = failed ? null : new Date(now.getTime() + backoffMs(attempts));
  await setCarrier({ status: failed ? "failed" : "pending", attempts, lastError: result.error ?? "error", channel: channel.name, nextAttemptAt });
  // The others wait with the same backoff (they were not attempted themselves).
  const waiting = failed
    ? { status: "failed" as const, lastError: result.error ?? "error", nextAttemptAt: null }
    : { status: "pending" as const, nextAttemptAt };
  if (!carrierIsLeader) {
    if (leaderValid) await setLeader(waiting);
    else {
      await setLeader({ status: "cancelled", lastError: leaderSkip ?? "nothing_to_send", nextAttemptAt: null });
      report.cancelled++;
    }
  }
  for (const v of others) await setRow(v.row.id, waiting);
  if (failed) report.failed++;
  else report.retrying++;
}
