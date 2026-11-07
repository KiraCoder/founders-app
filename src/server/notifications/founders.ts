import "server-only";
import { and, eq } from "drizzle-orm";
import { cache } from "react";
import type { SessionUser } from "@/server/auth/types";
import type { Db } from "@/server/db/connect";
import { users } from "@/server/db/schema";

const cols = { id: users.id, email: users.email, name: users.name, shortName: users.shortName, role: users.role };

/**
 * The only people who ever receive notifications. People records (Edil, Elmurat, …)
 * are not users and can never be recipients.
 */
export const listFounders = cache(async (db: Db): Promise<SessionUser[]> => {
  // Per request (React `cache`, same db handle): the AI roles views call it many times.
  return db.select(cols).from(users).where(eq(users.role, "founder")).orderBy(users.email);
});

export async function getFounder(db: Db, userId: string): Promise<SessionUser | null> {
  const [row] = await db.select(cols).from(users).where(and(eq(users.id, userId), eq(users.role, "founder")));
  return row ?? null;
}
