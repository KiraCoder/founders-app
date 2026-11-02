import "server-only";
import { and, asc, count, eq, gt, gte, inArray, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import { todayInTimeZone, addDays, isWithinWindow, windowEndAfter, zonedTimeToUtc } from "@/lib/dates";
import type { SessionUser } from "@/server/auth/types";
import type { Db } from "@/server/db/connect";
import { notificationsOutbox, reminderSnoozes, type OutboxItem } from "@/server/db/schema";
import { makeContext, type ServiceContext } from "@/server/services/context";
import { getTask, getTodaySummary, type TaskView } from "@/server/services/tasks";
import { mintActionTokens } from "./action-tokens";
import { createChannelRegistry, type ChannelRegistry } from "./channels";
import { getFounder } from "./founders";
import { getLinkForUser } from "./linking";
import { buildEveningCheck, buildMorningSummary, buildTaskMessage } from "./messages";
import { loadPreferences, type Preferences } from "./preferences";
import { isSummaryKind, SUMMARY_KINDS, type NeutralMessage, type NotificationKind } from "./types";

export const MAX_ATTEMPTS = 5;
/** Retry delays after the 1st, 2nd, 3rd, 4th failure. */
export const BACKOFF_MINUTES = [1, 5, 15, 60];
/** A claimed item is invisible to other ticks for this long (simple lease against double sends). */
const LEASE_MS = 2 * 60_000;

export interface DispatchReport {
  sent: number;
  held: number;
  parked: number;
  cancelled: number;
  retrying: number;
  failed: number;
}

export interface DispatchOptions {
  registry?: ChannelRegistry;
  limit?: number;
  timeZone?: string;
}

const PRIORITY_RANK = sql<number>`case ${notificationsOutbox.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`;

export function backoffMs(attempts: number): number {
  const i = Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1;
  return BACKOFF_MINUTES[i]! * 60_000;
}

export function isUrgentItem(item: Pick<OutboxItem, "kind" | "priority">): boolean {
  return item.kind === "urgent" || item.priority === "urgent";
}

/** Local-day bounds [start, end) for budget counting. */
function dayBounds(now: Date, tz: string): { start: Date; end: Date } {
  const today = todayInTimeZone(now, tz);
  return { start: zonedTimeToUtc(today, "00:00", tz), end: zonedTimeToUtc(addDays(today, 1), "00:00", tz) };
}

async function sentTodayCount(db: Db, userId: string, now: Date, tz: string, kinds: { summary: boolean; kind?: string }) {
  const { start, end } = dayBounds(now, tz);
  const kindFilter = kinds.kind
    ? eq(notificationsOutbox.kind, kinds.kind)
    : kinds.summary
      ? inArray(notificationsOutbox.kind, [...SUMMARY_KINDS])
      : notInArray(notificationsOutbox.kind, [...SUMMARY_KINDS]);
  const [row] = await db
    .select({ n: count() })
    .from(notificationsOutbox)
    .where(
      and(
        eq(notificationsOutbox.userId, userId),
        eq(notificationsOutbox.status, "sent"),
        kindFilter,
        gte(notificationsOutbox.sentAt, start),
        lt(notificationsOutbox.sentAt, end),
      ),
    );
  return row?.n ?? 0;
}

/** Parked items not yet included in a summary, as summary lines (closed tasks dropped). */
async function openParkedLines(ctx: ServiceContext): Promise<{ ids: string[]; lines: string[] }> {
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
  const ids: string[] = [];
  const lines: string[] = [];
  for (const r of rows) {
    ids.push(r.id);
    if (r.taskId) {
      const task = await getTask(ctx, r.taskId).catch(() => null);
      if (!task || task.status === "done" || task.status === "cancelled") continue;
    }
    const line = (r.payload as { summaryLine?: unknown }).summaryLine;
    if (typeof line === "string" && !lines.includes(line)) lines.push(line);
  }
  return { ids, lines };
}

type Built = { message: NeutralMessage; bundle?: string[] } | { skip: string };

async function buildFor(ctx: ServiceContext, item: OutboxItem): Promise<Built> {
  const kind = item.kind as NotificationKind;
  if (kind === "morning_summary" || kind === "evening_check") {
    const summary = await getTodaySummary(ctx);
    const parked = await openParkedLines(ctx);
    const message =
      kind === "morning_summary"
        ? buildMorningSummary(summary, parked.lines, ctx.user.shortName)
        : buildEveningCheck(summary, parked.lines);
    return message ? { message, bundle: parked.ids } : { skip: "nothing_to_send" };
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
 * Sends every due outbox item, respecting each founder's preferences:
 * - quiet hours hold items (urgent ones too, unless "urgent at night" is on);
 * - summaries have their own daily slots; other pushes share a daily budget and the
 *   overflow is PARKED and listed in the next summary instead of being sent;
 * - channel errors retry with backoff up to MAX_ATTEMPTS.
 */
export async function dispatch(db: Db, now: Date, opts: DispatchOptions = {}): Promise<DispatchReport> {
  const registry = opts.registry ?? createChannelRegistry();
  const tz = opts.timeZone ?? (process.env.APP_TIMEZONE || "Asia/Bishkek");
  const report: DispatchReport = { sent: 0, held: 0, parked: 0, cancelled: 0, retrying: 0, failed: 0 };

  const due = await db
    .select()
    .from(notificationsOutbox)
    .where(
      and(
        eq(notificationsOutbox.status, "pending"),
        lte(notificationsOutbox.scheduledFor, now),
        or(isNull(notificationsOutbox.nextAttemptAt), lte(notificationsOutbox.nextAttemptAt, now)),
      ),
    )
    .orderBy(asc(PRIORITY_RANK), asc(notificationsOutbox.scheduledFor), asc(notificationsOutbox.createdAt))
    .limit(opts.limit ?? 200);

  const users = new Map<string, { user: SessionUser | null; prefs: Preferences; chatId: string | null }>();

  for (const item of due) {
    // Lease: claim the row so a concurrent tick cannot send it too.
    const [claimed] = await db
      .update(notificationsOutbox)
      .set({ nextAttemptAt: new Date(now.getTime() + LEASE_MS) })
      .where(
        and(
          eq(notificationsOutbox.id, item.id),
          eq(notificationsOutbox.status, "pending"),
          or(isNull(notificationsOutbox.nextAttemptAt), lte(notificationsOutbox.nextAttemptAt, now)),
        ),
      )
      .returning({ id: notificationsOutbox.id });
    if (!claimed) continue;

    const finish = (set: Partial<typeof notificationsOutbox.$inferInsert>) =>
      db.update(notificationsOutbox).set(set).where(eq(notificationsOutbox.id, item.id));
    const cancel = async (reason: string) => {
      await finish({ status: "cancelled", lastError: reason, nextAttemptAt: null });
      report.cancelled++;
    };

    if (!users.has(item.userId)) {
      const user = await getFounder(db, item.userId);
      users.set(item.userId, {
        user,
        prefs: await loadPreferences(db, item.userId),
        chatId: (await getLinkForUser(db, item.userId))?.chatId ?? null,
      });
    }
    const { user, prefs, chatId } = users.get(item.userId)!;
    if (!user) {
      await cancel("not_a_founder");
      continue;
    }
    if (item.expiresAt && item.expiresAt.getTime() <= now.getTime()) {
      await cancel("expired");
      continue;
    }

    // Quiet hours: hold until they end.
    if (isWithinWindow(now, prefs.quietStart, prefs.quietEnd, tz) && !(isUrgentItem(item) && prefs.urgentAtNight)) {
      await finish({ nextAttemptAt: windowEndAfter(now, prefs.quietStart, prefs.quietEnd, tz) });
      report.held++;
      continue;
    }

    // Budget.
    if (isSummaryKind(item.kind)) {
      if ((await sentTodayCount(db, user.id, now, tz, { summary: true, kind: item.kind })) >= 1) {
        await cancel("already_sent_today");
        continue;
      }
    } else if (!isUrgentItem(item)) {
      const used = await sentTodayCount(db, user.id, now, tz, { summary: false });
      if (used >= prefs.maxOtherPerDay) {
        await finish({ status: "parked", parkedAt: now, nextAttemptAt: null, lastError: "daily_budget_full" });
        report.parked++;
        continue;
      }
    }

    const ctx = { ...makeContext(db, user, now), timeZone: tz };
    const built = await buildFor(ctx, item);
    if ("skip" in built) {
      await cancel(built.skip);
      continue;
    }

    const recipient = { userId: user.id, telegramChatId: chatId };
    const channel = registry.resolve(recipient);
    const callbacks = built.message.actions?.length
      ? await mintActionTokens(db, { userId: user.id, outboxId: item.id, actions: built.message.actions, now })
      : undefined;
    const result = await channel.send(recipient, built.message, callbacks);
    const attempts = item.attempts + 1;

    if (result.ok) {
      await finish({
        status: "sent",
        sentAt: now,
        channel: channel.name,
        providerMessageId: result.providerMessageId ?? null,
        message: built.message,
        attempts,
        lastError: null,
        nextAttemptAt: null,
      });
      if (built.bundle?.length) {
        await db
          .update(notificationsOutbox)
          .set({ bundledIntoId: item.id })
          .where(and(inArray(notificationsOutbox.id, built.bundle), isNull(notificationsOutbox.bundledIntoId)));
      }
      report.sent++;
    } else if (result.permanent || attempts >= MAX_ATTEMPTS) {
      await finish({ status: "failed", attempts, lastError: result.error ?? "error", channel: channel.name, nextAttemptAt: null });
      report.failed++;
    } else {
      await finish({
        attempts,
        lastError: result.error ?? "error",
        channel: channel.name,
        nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)),
      });
      report.retrying++;
    }
  }
  return report;
}
