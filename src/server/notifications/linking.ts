import "server-only";
import { and, eq, gt, isNotNull, isNull, or } from "drizzle-orm";
import type { Db } from "@/server/db/connect";
import { people, telegramLinkCodes, telegramLinks, users } from "@/server/db/schema";
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

/**
 * "Invite to Telegram" (founders only, checked by the caller): a one-time code for a PERSON.
 * Same rules as a founder's code: 15 minutes, stored hashed, single use; a new invite
 * invalidates the person's older unused ones.
 */
export async function createPersonLinkCode(
  db: Db,
  personId: string,
  createdByUserId: string,
  now: Date,
): Promise<{ code: string; expiresAt: Date }> {
  const code = randomLinkCode();
  const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_MINUTES * 60_000);
  await db.transaction(async (tx) => {
    await tx
      .update(telegramLinkCodes)
      .set({ usedAt: now })
      .where(and(eq(telegramLinkCodes.personId, personId), isNull(telegramLinkCodes.usedAt)));
    await tx.insert(telegramLinkCodes).values({ personId, createdByUserId, codeHash: sha256(code), expiresAt });
  });
  return { code, expiresAt };
}

export type LinkResult =
  | { ok: true; kind?: "user"; userId: string; shortName: string }
  | { ok: true; kind: "person"; personId: string; name: string }
  | { ok: false; reason: "invalid" | "chat_taken" };

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
      .returning({ userId: telegramLinkCodes.userId, personId: telegramLinkCodes.personId });
    if (!claimed) return { ok: false, reason: "invalid" } as const;
    if (claimed.personId) {
      const [person] = await tx
        .select({ id: people.id, fullName: people.fullName, shortName: people.shortName })
        .from(people)
        .where(and(eq(people.id, claimed.personId), isNull(people.leftAt)));
      if (!person) return { ok: false, reason: "invalid" } as const;
      // A founder's chat is never taken over by a person's invite (e.g. a founder testing the link).
      const [founderChat] = await tx
        .select({ id: telegramLinks.id })
        .from(telegramLinks)
        .where(and(eq(telegramLinks.chatId, chat.chatId), isNotNull(telegramLinks.userId)));
      if (founderChat) return { ok: false, reason: "chat_taken" } as const;
      await tx
        .delete(telegramLinks)
        .where(or(eq(telegramLinks.personId, person.id), eq(telegramLinks.chatId, chat.chatId)));
      await tx.insert(telegramLinks).values({
        personId: person.id,
        chatId: chat.chatId,
        telegramUserId: chat.telegramUserId,
        username: chat.username ?? null,
        firstName: chat.firstName ?? null,
      });
      return { ok: true, kind: "person", personId: person.id, name: person.shortName || person.fullName } as const;
    }
    if (!claimed.userId) return { ok: false, reason: "invalid" } as const;
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

/**
 * The person linked to a Telegram private chat (chat id AND sender must match), with the link
 * (stopped or not: the bot answers /start to resume). Null for founders' chats and people who left.
 */
export async function findPersonLinkByChat(db: Db, chatId: string, telegramUserId: string) {
  const [row] = await db
    .select({ link: telegramLinks, person: { id: people.id, fullName: people.fullName, shortName: people.shortName } })
    .from(telegramLinks)
    .innerJoin(people, eq(people.id, telegramLinks.personId))
    .where(and(eq(telegramLinks.chatId, chatId), eq(telegramLinks.telegramUserId, telegramUserId), isNull(people.leftAt)));
  return row ?? null;
}

export async function getLinkForPerson(db: Db, personId: string) {
  const [row] = await db.select().from(telegramLinks).where(eq(telegramLinks.personId, personId));
  return row ?? null;
}

/** /stop (stopped = now) or /start again (stopped = null) for a person's link. */
export async function setPersonLinkStopped(db: Db, linkId: string, stoppedAt: Date | null): Promise<void> {
  await db.update(telegramLinks).set({ stoppedAt }).where(and(eq(telegramLinks.id, linkId), isNotNull(telegramLinks.personId)));
}

export async function getLinkForUser(db: Db, userId: string) {
  const [row] = await db.select().from(telegramLinks).where(eq(telegramLinks.userId, userId));
  return row ?? null;
}
