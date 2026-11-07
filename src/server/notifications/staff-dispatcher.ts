import "server-only";
import { and, count, eq, gte, lt, ne, or, sql } from "drizzle-orm";
import { addDays, isWithinWindow, todayInTimeZone, windowEndAfter, zonedTimeToUtc } from "@/lib/dates";
import { effectiveStaffSettings, parsePersonOverride, parseTaskOverride, taskChaseSettings, type StaffSettings } from "@/lib/staff-schemas";
import type { Db } from "@/server/db/connect";
import { notificationsOutbox, people, type OutboxItem } from "@/server/db/schema";
import { getPersonTask, listPersonOpenTasks, loadStaffCard, personContext, toLite } from "@/server/services/staff-tasks";
import { loadStaffDefaults } from "@/server/services/staff";
import { routineMessageInput } from "@/server/services/routines";
import { mintActionTokens } from "./action-tokens";
import type { ChannelRegistry } from "./channels";
import { getLinkForPerson } from "./linking";
import { loadRoutineForMessage, markRoutineMessageSent } from "./routine-planner";
import {
  buildRoutineMessageRu,
  buildStaffGroupedChase,
  buildStaffInfo,
  buildStaffMorningList,
  buildStaffTaskCard,
  type StaffTaskLite,
} from "./messages-ru";
import { fitTelegram } from "./render-telegram";
import { taskRef, type NeutralMessage } from "./types";

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
    return item.kind === "staff_new_task" || item.kind === "staff_info" || item.kind === "staff_task_update"
      ? hold(person.botPausedUntil, "paused")
      : cancel("paused");
  }
  const settings = effectiveStaffSettings(opts.defaults ?? (await loadStaffDefaults(db)), parsePersonOverride(person.staffChase));
  if (isWithinWindow(now, settings.quietStart, settings.quietEnd, tz)) {
    return hold(windowEndAfter(now, settings.quietStart, settings.quietEnd, tz), "quiet_hours");
  }

  const pctx = personContext(db, person, now, tz);
  const today = todayInTimeZone(now, tz);
  let message: NeutralMessage;
  let listed: { id: string; dueDate: string | null }[] | null = null;
  if (item.kind === "staff_chase") {
    const chase = await buildChase(db, pctx, item, settings, today);
    if ("skip" in chase) return cancel(chase.skip);
    message = chase.message;
    listed = chase.listed;
  } else if (item.kind === "staff_new_task" || item.kind === "staff_task_update") {
    // The task card as it is now (checklist included); an update is one card however many changes.
    const card = item.taskId ? await loadStaffCard(pctx, item.taskId).catch(() => null) : null;
    if (!card) return cancel("task_gone_or_reassigned");
    if (card.status !== "open") return cancel("task_closed");
    message = buildStaffTaskCard(card, today, item.kind === "staff_new_task" ? "new" : "update");
  } else if (item.kind === "staff_morning_list") {
    const open = await listPersonOpenTasks(pctx);
    if (!open.length) return cancel("nothing_to_send");
    message = buildStaffMorningList(person.shortName || person.fullName, open, today);
  } else if (item.kind === "staff_info") {
    const text = (item.payload as { text?: string }).text;
    if (!text) return cancel("nothing_to_send");
    message = buildStaffInfo(text);
  } else if (item.kind === "staff_routine") {
    const loaded = await loadRoutineForMessage(db, item, { personId: person.id });
    if ("skip" in loaded) return cancel(loaded.skip);
    const { routine, run } = loaded;
    message = buildRoutineMessageRu(await routineMessageInput(db, routine, run), loaded.updated ? "updated" : loaded.reminder ? "reminder" : "ask");
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
    if (item.kind === "staff_new_task" || item.kind === "staff_task_update") {
      return hold(zonedTimeToUtc(addDays(today, 1), settings.workStart, tz), "daily_cap_full");
    }
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
      // A grouped chase records which tasks it listed (the chase count per task, the delivery
      // trail); with exactly one task it is "about" that task (a text reply becomes its comment).
      ...(listed ? { taskId: listed.length === 1 ? listed[0]!.id : null } : {}),
      ...(listed || (channel.name === "dev" && callbacks)
        ? {
            payload: {
              ...(item.payload as object),
              ...(listed ? { listed } : {}),
              ...(channel.name === "dev" && callbacks ? { devCallbacks: callbacks } : {}),
            },
          }
        : {}),
    });
    if (item.kind === "staff_routine") await markRoutineMessageSent(db, item, now);
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

type ChaseEntry = { id: string; dueDate: string | null; slotStart?: string };

/** The tasks a chase row is for (grouped rows: payload.tasks; rows queued before the grouping: taskId). */
function chaseEntries(item: OutboxItem): ChaseEntry[] {
  const p = (item.payload ?? {}) as { tasks?: ChaseEntry[]; dueDate?: string; slotStart?: string };
  if (Array.isArray(p.tasks)) return p.tasks;
  return item.taskId ? [{ id: item.taskId, dueDate: p.dueDate ?? null, slotStart: p.slotStart }] : [];
}

/**
 * Builds the grouped chase at send time from the tasks' CURRENT state. A task is left out when it
 * is no longer theirs / open, its deadline moved, chasing was switched off for it, or it was
 * already messaged in its slot (an earlier chase listed it, or its new-task message was sent in the
 * slot or still waits — the new-task message goes first).
 */
async function buildChase(
  db: Db,
  pctx: ReturnType<typeof personContext>,
  item: OutboxItem & { personId: string },
  settings: StaffSettings,
  today: string,
): Promise<{ message: NeutralMessage; listed: { id: string; dueDate: string | null }[] } | { skip: string }> {
  const reasons: string[] = [];
  const keep: { lite: StaffTaskLite; dueDate: string | null }[] = [];
  for (const e of chaseEntries(item)) {
    const own = await getPersonTask(pctx, e.id).catch(() => null);
    if (!own) {
      reasons.push("task_gone_or_reassigned");
      continue;
    }
    if (own.task.status === "done" || own.task.status === "cancelled") {
      reasons.push("task_closed");
      continue;
    }
    if (own.task.dueDate !== e.dueDate) {
      reasons.push("deadline_moved");
      continue;
    }
    // "Chase now" (a founder's explicit tap, 0032) goes out even while chasing is off or paused.
    const manual = (item.payload as { manual?: boolean } | null)?.manual === true;
    if (!manual && !taskChaseSettings(settings, parseTaskOverride(own.task.staffChase)).chaseEnabled) {
      reasons.push("chase_off");
      continue;
    }
    const since = e.slotStart ? new Date(e.slotStart) : pctx.now;
    const o = notificationsOutbox;
    const listedJson = JSON.stringify([{ id: e.id }]);
    const [dup] = await db
      .select({ n: count() })
      .from(o)
      .where(
        and(
          eq(o.personId, item.personId),
          ne(o.id, item.id),
          or(
            // Its new-task message (sent in the slot, or still waiting: it goes first).
            and(
              eq(o.kind, "staff_new_task"),
              eq(o.taskId, e.id),
              or(and(eq(o.status, "sent"), gte(o.sentAt, since)), eq(o.status, "pending"), eq(o.status, "sending")),
            ),
            // An earlier chase that listed it in this slot (or one being sent right now).
            and(
              eq(o.kind, "staff_chase"),
              eq(o.status, "sent"),
              gte(o.sentAt, since),
              or(eq(o.taskId, e.id), sql`(${o.payload} -> 'listed') @> ${listedJson}::jsonb`),
            ),
            and(
              eq(o.kind, "staff_chase"),
              eq(o.status, "sending"),
              or(eq(o.taskId, e.id), sql`(${o.payload} -> 'tasks') @> ${listedJson}::jsonb`),
            ),
          ),
        ),
      );
    if ((dup?.n ?? 0) > 0) {
      reasons.push("already_pushed_this_slot");
      continue;
    }
    keep.push({ lite: toLite(own.task, own.companyName), dueDate: own.task.dueDate });
  }
  if (!keep.length) {
    const unique = [...new Set(reasons)];
    return { skip: unique.length === 1 ? unique[0]! : "nothing_to_send" };
  }
  // Earliest deadline first (the longest overdue on top).
  keep.sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""));
  const built = buildStaffGroupedChase(
    keep.map((k) => k.lite),
    today,
  );
  const fitted = fitTelegram(built.message);
  const shown = new Set(built.listed.filter((id) => keep.length === 1 || fitted.keptRefs.has(taskRef(id))));
  // One task: its full card (checklist, details, buttons re-drawn in place when pressed).
  const card = keep.length === 1 ? await loadStaffCard(pctx, keep[0]!.lite.id).catch(() => null) : null;
  return {
    message: card ? buildStaffTaskCard(card, today, "chase") : built.message,
    listed: keep.filter((k) => shown.has(k.lite.id)).map((k) => ({ id: k.lite.id, dueDate: k.dueDate })),
  };
}
