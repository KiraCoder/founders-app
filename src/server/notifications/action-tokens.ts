import "server-only";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/server/db/connect";
import { notificationActionTokens } from "@/server/db/schema";
import { randomToken, sha256 } from "./secrets";
import {
  actionKey,
  HOLDING_ACTIONS,
  TASK_ACTIONS,
  type ActionCallbacks,
  type HoldingAction,
  type MessageAction,
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
  opts: { userId: string; outboxId: string | null; actions: MessageAction[]; now: Date },
): Promise<ActionCallbacks> {
  const callbacks: ActionCallbacks = {};
  if (!opts.actions.length) return callbacks;
  const expiresAt = new Date(opts.now.getTime() + ACTION_TOKEN_TTL_DAYS * 86_400_000);
  const rows = opts.actions.map((a) => {
    const token = randomToken();
    callbacks[actionKey(a)] = `${PREFIX}${token}`;
    return {
      tokenHash: sha256(token),
      userId: opts.userId,
      taskId: a.taskId ?? null,
      holdingAskId: a.askId ?? null,
      action: a.action,
      outboxId: opts.outboxId,
      expiresAt,
    };
  });
  await db.insert(notificationActionTokens).values(rows);
  return callbacks;
}

export type ConsumedAction =
  | { kind: "task"; taskId: string; action: TaskAction }
  | { kind: "holding"; askId: string; action: HoldingAction };

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
      action: notificationActionTokens.action,
    });
  if (!row) return null;
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
  userId: string,
  now: Date,
): Promise<Map<string, { taskId: string | null; holdingAskId: string | null }>> {
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
    })
    .from(notificationActionTokens)
    .where(
      and(
        inArray(notificationActionTokens.tokenHash, [...byHash.keys()]),
        eq(notificationActionTokens.userId, userId),
        isNull(notificationActionTokens.usedAt),
        gt(notificationActionTokens.expiresAt, now),
      ),
    );
  return new Map(rows.map((r) => [byHash.get(r.tokenHash)!, { taskId: r.taskId, holdingAskId: r.holdingAskId }]));
}
