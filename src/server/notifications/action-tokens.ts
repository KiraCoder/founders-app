import "server-only";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/server/db/connect";
import { notificationActionTokens } from "@/server/db/schema";
import { randomToken, sha256 } from "./secrets";
import {
  actionKey,
  DEADLINE_ACTIONS,
  HOLDING_ACTIONS,
  ROUTINE_ACTIONS,
  STAFF_ACTIONS,
  TASK_ACTIONS,
  type ActionCallbacks,
  type DeadlineAction,
  type HoldingAction,
  type MessageAction,
  type RoutineAction,
  type StaffAction,
  type TaskAction,
} from "./types";

export const ACTION_TOKEN_TTL_DAYS = 7;
const PREFIX = "a:";

/**
 * Mints one server-side token per button. The callback data is only "a:<random>";
 * user, task and action are looked up from the hash, never trusted from Telegram.
 */
export async function mintActionTokens(
  db: Db,
  opts: { userId?: string; personId?: string; outboxId: string | null; actions: MessageAction[]; now: Date },
): Promise<ActionCallbacks> {
  if (!opts.userId === !opts.personId) throw new Error("A button belongs to exactly one founder or person");
  const callbacks: ActionCallbacks = {};
  if (!opts.actions.length) return callbacks;
  const expiresAt = new Date(opts.now.getTime() + ACTION_TOKEN_TTL_DAYS * 86_400_000);
  const rows = opts.actions.map((a) => {
    const token = randomToken();
    callbacks[actionKey(a)] = `${PREFIX}${token}`;
    return {
      tokenHash: sha256(token),
      userId: opts.userId ?? null,
      personId: opts.personId ?? null,
      taskId: a.taskId ?? null,
      holdingAskId: a.askId ?? null,
      deadlineRequestId: a.requestId ?? null,
      routineRunId: a.runId ?? null,
      action: a.action,
      payload: a.payload ?? ((a as { item?: string }).item ? { item: (a as { item?: string }).item } : null),
      outboxId: opts.outboxId,
      expiresAt,
    };
  });
  await db.insert(notificationActionTokens).values(rows);
  return callbacks;
}

/** A routine button (founder or person): the run and, for routine_tick, the checklist item key. */
export interface ConsumedRoutineAction {
  kind: "routine";
  runId: string;
  action: RoutineAction;
  item: string | null;
}

function routineOf(row: { routineRunId: string | null; action: string; payload: Record<string, unknown> | null }): ConsumedRoutineAction | null {
  if (!row.routineRunId || !(ROUTINE_ACTIONS as readonly string[]).includes(row.action)) return null;
  const item = typeof row.payload?.item === "string" ? row.payload.item : null;
  return { kind: "routine", runId: row.routineRunId, action: row.action as RoutineAction, item };
}

export type ConsumedAction =
  | ConsumedRoutineAction
  | { kind: "task"; taskId: string; action: TaskAction }
  | { kind: "holding"; askId: string; action: HoldingAction }
  | { kind: "deadline"; requestId: string; action: DeadlineAction };

export interface ConsumedStaffAction {
  kind: "staff";
  taskId: string;
  action: StaffAction;
  payload: Record<string, unknown>;
}

function parseCallback(callbackData: string): string | null {
  if (!callbackData.startsWith(PREFIX)) return null;
  const token = callbackData.slice(PREFIX.length);
  return /^[A-Za-z0-9_-]{16,64}$/.test(token) ? token : null;
}

/**
 * Single-use redemption for one PERSON (staff). Only staff actions on a task count; a founder's
 * token, another person's token, an expired or used one does nothing.
 */
export async function consumePersonActionToken(
  db: Db,
  callbackData: string,
  personId: string,
  now: Date,
): Promise<ConsumedStaffAction | ConsumedRoutineAction | null> {
  const token = parseCallback(callbackData);
  if (!token) return null;
  const [row] = await db
    .update(notificationActionTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(notificationActionTokens.tokenHash, sha256(token)),
        eq(notificationActionTokens.personId, personId),
        isNull(notificationActionTokens.usedAt),
        gt(notificationActionTokens.expiresAt, now),
      ),
    )
    .returning({
      taskId: notificationActionTokens.taskId,
      routineRunId: notificationActionTokens.routineRunId,
      action: notificationActionTokens.action,
      payload: notificationActionTokens.payload,
    });
  if (!row) return null;
  const routine = routineOf(row);
  if (routine) return routine;
  if (!row.taskId || !(STAFF_ACTIONS as readonly string[]).includes(row.action)) return null;
  return { kind: "staff", taskId: row.taskId, action: row.action as StaffAction, payload: row.payload ?? {} };
}

/**
 * Single-use redemption for one user. Returns null for unknown, expired, used or
 * other-user tokens: a forged or replayed callback does nothing.
 */
export async function consumeActionToken(
  db: Db,
  callbackData: string,
  userId: string,
  now: Date,
): Promise<ConsumedAction | null> {
  if (!callbackData.startsWith(PREFIX)) return null;
  const token = callbackData.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const [row] = await db
    .update(notificationActionTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(notificationActionTokens.tokenHash, sha256(token)),
        eq(notificationActionTokens.userId, userId),
        isNull(notificationActionTokens.usedAt),
        gt(notificationActionTokens.expiresAt, now),
      ),
    )
    .returning({
      taskId: notificationActionTokens.taskId,
      holdingAskId: notificationActionTokens.holdingAskId,
      deadlineRequestId: notificationActionTokens.deadlineRequestId,
      routineRunId: notificationActionTokens.routineRunId,
      action: notificationActionTokens.action,
      payload: notificationActionTokens.payload,
    });
  if (!row) return null;
  const routine = routineOf(row);
  if (routine) return routine;
  if (row.deadlineRequestId && (DEADLINE_ACTIONS as readonly string[]).includes(row.action)) {
    return { kind: "deadline", requestId: row.deadlineRequestId, action: row.action as DeadlineAction };
  }
  if (row.taskId && (TASK_ACTIONS as readonly string[]).includes(row.action)) {
    return { kind: "task", taskId: row.taskId, action: row.action as TaskAction };
  }
  if (row.holdingAskId && (HOLDING_ACTIONS as readonly string[]).includes(row.action)) {
    return { kind: "holding", askId: row.holdingAskId, action: row.action as HoldingAction };
  }
  return null;
}

/**
 * Of these callback datas, the ones that still work for this user right now (unused, not
 * expired), with the task / ask item each acts on. Read-only: nothing is consumed.
 */
export async function liveCallbacks(
  db: Db,
  callbackDatas: readonly string[],
  owner: string | { personId: string },
  now: Date,
): Promise<Map<string, { taskId: string | null; holdingAskId: string | null; deadlineRequestId: string | null; routineRunId: string | null }>> {
  const ownerWhere =
    typeof owner === "string" ? eq(notificationActionTokens.userId, owner) : eq(notificationActionTokens.personId, owner.personId);
  const byHash = new Map<string, string>();
  for (const d of callbackDatas) {
    if (!d.startsWith(PREFIX)) continue;
    const token = d.slice(PREFIX.length);
    if (/^[A-Za-z0-9_-]{16,64}$/.test(token)) byHash.set(sha256(token), d);
  }
  if (!byHash.size) return new Map();
  const rows = await db
    .select({
      tokenHash: notificationActionTokens.tokenHash,
      taskId: notificationActionTokens.taskId,
      holdingAskId: notificationActionTokens.holdingAskId,
      deadlineRequestId: notificationActionTokens.deadlineRequestId,
      routineRunId: notificationActionTokens.routineRunId,
    })
    .from(notificationActionTokens)
    .where(
      and(
        inArray(notificationActionTokens.tokenHash, [...byHash.keys()]),
        ownerWhere,
        isNull(notificationActionTokens.usedAt),
        gt(notificationActionTokens.expiresAt, now),
      ),
    );
  return new Map(
    rows.map((r) => [
      byHash.get(r.tokenHash)!,
      { taskId: r.taskId, holdingAskId: r.holdingAskId, deadlineRequestId: r.deadlineRequestId, routineRunId: r.routineRunId },
    ]),
  );
}
