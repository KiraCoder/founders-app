import "server-only";
import bcrypt from "bcryptjs";
import { and, eq, gt } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { Db } from "@/server/db/connect";
import { sessions, users } from "@/server/db/schema";
import { SESSION_TTL_SECONDS, signSessionToken, verifySessionToken } from "./session-token";
import type { AuthProvider, SessionUser } from "./types";

// Compared against when the email is unknown, so timing does not reveal which emails exist.
const DUMMY_HASH = "$2b$10$9.e1lUeZkOPLVmgRXw2OAujaU/EaOD7XGV.jxDo1mTZIzQKiiAz/K";

const userColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  shortName: users.shortName,
  role: users.role,
};

export const localAuthProvider: AuthProvider = {
  mode: "local",

  async signIn(db, email, password, meta) {
    const normalized = email.trim().toLowerCase();
    const [row] = await db
      .select({ ...userColumns, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, normalized));
    const ok = await bcrypt.compare(password, row?.passwordHash ?? DUMMY_HASH);
    if (!row || !row.passwordHash || !ok) return null;

    const sid = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
    await db.insert(sessions).values({
      id: sid,
      userId: row.id,
      expiresAt,
      userAgent: meta?.userAgent?.slice(0, 300) ?? null,
    });
    const token = await signSessionToken({ sid, uid: row.id }, expiresAt);
    const { passwordHash: _omit, ...user } = row;
    void _omit;
    return { user, token, expiresAt };
  },

  async getUser(db, token) {
    const claims = await verifySessionToken(token);
    if (!claims) return null;
    const [row] = await db
      .select(userColumns)
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.id, claims.sid),
          eq(sessions.userId, claims.uid),
          gt(sessions.expiresAt, new Date()),
        ),
      );
    return (row as SessionUser | undefined) ?? null;
  },

  async signOut(db: Db, token) {
    const claims = await verifySessionToken(token);
    if (claims) await db.delete(sessions).where(eq(sessions.id, claims.sid));
  },
};
