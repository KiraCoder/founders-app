import "server-only";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { Db } from "@/server/db/connect";
import { telegramLinkCodes, telegramLinks, users } from "@/server/db/schema";
import { normalizeLinkCode, randomLinkCode, sha256 } from "./secrets";

export const LINK_CODE_TTL_MINUTES = 15;

/** New one-time code for `/start CODE`. Older unused codes of this user stop working. */
export async function createLinkCode(db: Db, userId: string, now: Date): Promise<{ code: string; expiresAt: Date }> {
  const code = randomLinkCode();
  const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_MINUTES * 60_000);
  await db.transaction(async (tx) => {
    await tx
      .update(telegramLinkCodes)
      .set({ usedAt: now })
      .where(and(eq(telegramLinkCodes.userId, userId), isNull(telegramLinkCodes.usedAt)));
    await tx.insert(telegramLinkCodes).values({ userId, codeHash: sha256(code), expiresAt });
  });
  return { code, expiresAt };
}

export interface ChatIdentity {
  chatId: string;
  telegramUserId: string;
  username?: string | null;
  firstName?: string | null;
}

export type LinkResult =
  | { ok: true; userId: string; shortName: string }
  | { ok: false; reason: "invalid" };

/**
 * Consumes a code (single use, must not be expired) and links the chat to its user.
 * Any previous link of that user or of that chat is replaced.
 */
export async function consumeLinkCode(db: Db, rawCode: string, chat: ChatIdentity, now: Date): Promise<LinkResult> {
  const code = normalizeLinkCode(rawCode);
  if (!code) return { ok: false, reason: "invalid" };
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(telegramLinkCodes)
      .set({ usedAt: now })
      .where(
        and(
          eq(telegramLinkCodes.codeHash, sha256(code)),
          isNull(telegramLinkCodes.usedAt),
          gt(telegramLinkCodes.expiresAt, now),
        ),
      )
      .returning({ userId: telegramLinkCodes.userId });
    if (!claimed?.userId) return { ok: false, reason: "invalid" } as const;
    const [user] = await tx
      .select({ id: users.id, shortName: users.shortName, role: users.role })
      .from(users)
      .where(eq(users.id, claimed.userId));
    if (!user || user.role !== "founder") return { ok: false, reason: "invalid" } as const;

    await tx
      .delete(telegramLinks)
      .where(or(eq(telegramLinks.userId, user.id), eq(telegramLinks.chatId, chat.chatId)));
    await tx.insert(telegramLinks).values({
      userId: user.id,
      chatId: chat.chatId,
      telegramUserId: chat.telegramUserId,
      username: chat.username ?? null,
      firstName: chat.firstName ?? null,
    });
    return { ok: true, userId: user.id, shortName: user.shortName } as const;
  });
}

/** The founder linked to a Telegram private chat (chat id AND sender must match). */
export async function findLinkByChat(db: Db, chatId: string, telegramUserId: string) {
  const [row] = await db
    .select({ link: telegramLinks, user: { id: users.id, email: users.email, name: users.name, shortName: users.shortName, role: users.role } })
    .from(telegramLinks)
    .innerJoin(users, eq(users.id, telegramLinks.userId))
    .where(and(eq(telegramLinks.chatId, chatId), eq(telegramLinks.telegramUserId, telegramUserId)));
  if (!row || row.user.role !== "founder") return null;
  return row;
}

export async function getLinkForUser(db: Db, userId: string) {
  const [row] = await db.select().from(telegramLinks).where(eq(telegramLinks.userId, userId));
  return row ?? null;
}
