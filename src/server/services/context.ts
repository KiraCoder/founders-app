import "server-only";
import { appTimeZone, todayInTimeZone, type IsoDate } from "@/lib/dates";
import type { SessionUser } from "@/server/auth/types";
import type { Db } from "@/server/db/connect";

/** Everything a service needs: who is acting, on which DB, and what time it is. */
export interface ServiceContext {
  db: Db;
  user: SessionUser;
  now: Date;
  timeZone: string;
}

export function makeContext(db: Db, user: SessionUser, now = new Date()): ServiceContext {
  return { db, user, now, timeZone: appTimeZone() };
}

export function today(ctx: ServiceContext): IsoDate {
  return todayInTimeZone(ctx.now, ctx.timeZone);
}
