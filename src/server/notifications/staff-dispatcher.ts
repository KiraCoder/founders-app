import "server-only";
import { and, count, eq, gte, lt, ne, or } from "drizzle-orm";
import { addDays, isWithinWindow, todayInTimeZone, windowEndAfter, zonedTimeToUtc } from "@/lib/dates";
import { effectiveStaffSettings, parsePersonOverride, parseTaskOverride, taskChaseSettings, type StaffSettings } from "@/lib/staff-schemas";
import type { Db } from "@/server/db/connect";
import { notificationsOutbox, people, type OutboxItem } from "@/server/db/schema";
import { getPersonTask, listPersonOpenTasks, personContext, toLite } from "@/server/services/staff-tasks";
import { loadStaffDefaults } from "@/server/services/staff";
import { mintActionTokens } from "./action-tokens";
import type { ChannelRegistry } from "./channels";
import { getLinkForPerson } from "./linking";
import { buildStaffChase, buildStaffInfo, buildStaffMorningList, buildStaffNewTask } from "./messages-ru";
import { fitTelegram } from "./render-telegram";
import type { NeutralMessage } from "./types";

type Finish = (set: Partial<typeof notificationsOutbox.$inferInsert>) => Promise<unknown>;

export interface StaffDispatchCounters {
  sent: number;
  held: number;
  cancelled: number;
  retrying: number;
  failed: number;
}

/**
 * Sends one PERSON (staff) outbox row. The person must, right now: not have left, have linked the
 * bot themselves and not sent /stop, be switched on by a founder and not be paused. Otherwise the
 * row is cancelled (never held for later: nobody is messaged who did not start the bot; a new-task
 * message waits only while the person is paused). Then:
 * - quiet hours (their settings) hold the row until they end;
 * - the task must still be theirs and open (and for a chase: same deadline, chasing not switched
 *   off, nothing sent about it in this slot already);
 * - at most `maxPerDay` messages a day (a new-task message waits for tomorrow, a chase is dropped:
 *   the next slot asks again);
 * - buttons carry one-time tokens bound to this person.
 */
export async function processPersonItem(
  db: Db,
  item: OutboxItem & { personId: string },
  now: Date,
  tz: string,
  registry: ChannelRegistry,
  finish: Finish,
  report: StaffDispatchCounters,
  opts: { maxAttempts: number; backoffMs: (attempts: number) => number; defaults?: StaffSettings },
): Promise<void> {
  const cancel = async (reason: string) => {
    await finish({ status: "cancelled", lastError: reason, nextAttemptAt: null });
    report.cancelled++;
  };
  const hold = async (until: Date, reason: string) => {
    await finish({ status: "pending", nextAttemptAt: until, lastError: reason });
    report.held++;
  };
  if (item.attempts >= opts.maxAttempts) {
    await finish({ status: "failed", nextAttemptAt: null });
    report.failed++;
    return;
  }
  const [person] = await db.select().from(people).where(eq(people.id, item.personId));
  if (!person || person.leftAt || person.userId) return cancel("person_gone");
  const link = await getLinkForPerson(db, person.id);
  if (!link) return cancel("not_linked");
  if (link.stoppedAt) return cancel("stopped");
  if (!person.botEnabled) return cancel("bot_off");
  if (item.expiresAt && item.expiresAt.getTime() <= now.getTime()) return cancel("expired");
  if (person.botPausedUntil && person.botPausedUntil.getTime() > now.getTime()) {
    return item.kind === "staff_new_task" || item.kind === "staff_info" ? hold(person.botPausedUntil, "paused") : cancel("paused");
  }
  const settings = effectiveStaffSettings(opts.defaults ?? (await loadStaffDefaults(db)), parsePersonOverride(person.staffChase));
  if (isWithinWindow(now, settings.quietStart, settings.quietEnd, tz)) {
    return hold(windowEndAfter(now, settings.quietStart, settings.quietEnd, tz), "quiet_hours");
  }

  const pctx = personContext(db, person, now, tz);
  const today = todayInTimeZone(now, tz);
  let message: NeutralMessage;
  if (item.kind === "staff_new_task" || item.kind === "staff_chase") {
    const own = item.taskId ? await getPersonTask(pctx, item.taskId).catch(() => null) : null;
    if (!own) return cancel("task_gone_or_reassigned");
    if (own.task.status === "done" || own.task.status === "cancelled") return cancel("task_closed");
    if (item.kind === "staff_chase") {
      const p = item.payload as { dueDate?: string; slotStart?: string };
      if (own.task.dueDate !== p.dueDate) return cancel("deadline_moved");
      if (!taskChaseSettings(settings, parseTaskOverride(own.task.staffChase)).chaseEnabled) return cancel("chase_off");
      const since = p.slotStart ? new Date(p.slotStart) : now;
      const [dup] = await db
        .select({ n: count() })
        .from(notificationsOutbox)
        .where(
          and(
            eq(notificationsOutbox.personId, person.id),
            eq(notificationsOutbox.taskId, own.task.id),
            ne(notificationsOutbox.id, item.id),
            or(
              and(eq(notificationsOutbox.status, "sent"), gte(notificationsOutbox.sentAt, since)),
              eq(notificationsOutbox.status, "sending"),
              // The new-task message goes first (it waits in the queue behind this earlier slot).
              and(eq(notificationsOutbox.kind, "staff_new_task"), eq(notificationsOutbox.status, "pending")),
            ),
          ),
        );
      if ((dup?.n ?? 0) > 0) return cancel("already_pushed_this_slot");
      message = buildStaffChase(toLite(own.task, own.companyName), today);
    } else {
      message = buildStaffNewTask(toLite(own.task, own.companyName), today);
    }
  } else if (item.kind === "staff_morning_list") {
    const open = await listPersonOpenTasks(pctx);
    if (!open.length) return cancel("nothing_to_send");
    message = buildStaffMorningList(person.shortName || person.fullName, open, today);
  } else if (item.kind === "staff_info") {
    const text = (item.payload as { text?: string }).text;
    if (!text) return cancel("nothing_to_send");
    message = buildStaffInfo(text);
  } else {
    return cancel("unknown_kind");
  }

  // Daily cap per person (sent today or being sent by another run).
  const start = zonedTimeToUtc(today, "00:00", tz);
  const end = zonedTimeToUtc(addDays(today, 1), "00:00", tz);
  const [used] = await db
    .select({ n: count() })
    .from(notificationsOutbox)
    .where(
      and(
        eq(notificationsOutbox.personId, person.id),
        ne(notificationsOutbox.id, item.id),
        or(
          and(eq(notificationsOutbox.status, "sent"), gte(notificationsOutbox.sentAt, start), lt(notificationsOutbox.sentAt, end)),
          eq(notificationsOutbox.status, "sending"),
        ),
      ),
    );
  if ((used?.n ?? 0) >= settings.maxPerDay) {
    if (item.kind === "staff_new_task") return hold(zonedTimeToUtc(addDays(today, 1), settings.workStart, tz), "daily_cap_full");
    return cancel("daily_cap_full");
  }

  const recipient = { userId: person.id, personId: person.id, telegramChatId: link.chatId };
  const channel = registry.resolve(recipient);
  if (!channel) return cancel("not_linked");
  const fitted = fitTelegram(message).message;
  const callbacks = fitted.actions?.length
    ? await mintActionTokens(db, { personId: person.id, outboxId: item.id, actions: fitted.actions, now })
    : undefined;
  const result = await channel.send(recipient, fitted, callbacks);
  const attempts = item.attempts + 1;
  if (result.ok) {
    await finish({
      status: "sent",
      sentAt: now,
      channel: channel.name,
      providerMessageId: result.providerMessageId ?? null,
      message: fitted,
      attempts,
      lastError: null,
      nextAttemptAt: null,
      // The dev inbox only (never Telegram): keep the button data so a developer / the e2e test can
      // "press" a button through the webhook. Real Telegram rows never store raw tokens.
      ...(channel.name === "dev" && callbacks ? { payload: { ...(item.payload as object), devCallbacks: callbacks } } : {}),
    });
    report.sent++;
  } else if (result.permanent || attempts >= opts.maxAttempts) {
    await finish({ status: "failed", attempts, lastError: result.error ?? "error", channel: channel.name, nextAttemptAt: null });
    report.failed++;
  } else {
    await finish({
      status: "pending",
      attempts,
      lastError: result.error ?? "error",
      channel: channel.name,
      nextAttemptAt: new Date(now.getTime() + opts.backoffMs(attempts)),
    });
    report.retrying++;
  }
}
