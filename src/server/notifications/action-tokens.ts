import "server-only";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@/server/db/connect";
import { notificationActionTokens } from "@/server/db/schema";
import { randomToken, sha256 } from "./secrets";
import { actionKey, TASK_ACTIONS, type ActionCallbacks, type MessageAction, type TaskAction } from "./types";

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
    return { tokenHash: sha256(token), userId: opts.userId, taskId: a.taskId, action: a.action, outboxId: opts.outboxId, expiresAt };
  });
  await db.insert(notificationActionTokens).values(rows);
  return callbacks;
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
): Promise<{ taskId: string; action: TaskAction } | null> {
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
    .returning({ taskId: notificationActionTokens.taskId, action: notificationActionTokens.action });
  if (!row || !(TASK_ACTIONS as readonly string[]).includes(row.action)) return null;
  return { taskId: row.taskId, action: row.action as TaskAction };
}
