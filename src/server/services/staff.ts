import "server-only";
import { and, desc, eq, gt, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { addDays, zonedTimeToUtc } from "@/lib/dates";
import {
  compactOverride,
  DEFAULT_STAFF_SETTINGS,
  effectiveStaffSettings,
  parsePersonOverride,
  parseStaffDefaults,
  parseTaskOverride,
  pauseUntilSchema,
  STAFF_DEFAULTS_KEY,
  staffDefaultsSchema,
  staffPersonOverrideSchema,
  staffTaskOverrideSchema,
  type StaffSettings,
  type StaffTaskOverride,
} from "@/lib/staff-schemas";
import { CACHE_TAGS, invalidate, sharedCache } from "@/server/cache";
import type { Db } from "@/server/db/connect";
import {
  appSettings,
  notificationsOutbox,
  people,
  tasks,
  telegramLinkCodes,
  telegramLinks,
  type OutboxItem,
  type TelegramLink,
} from "@/server/db/schema";
import { inviteBotUsername, inviteDeepLink } from "@/server/notifications/config";
import { createPersonLinkCode } from "@/server/notifications/linking";
import { assertStaffBotAccess, assertValidId } from "./access";
import type { ServiceContext } from "./context";
import { ServiceError } from "./errors";
import { getTask } from "./tasks";

/**
 * Team on Telegram, the founders' side: invite a person to the bot, switch "bot may message"
 * on/off, pause, chase settings (global defaults → per person → per task), the log of what the
 * bot sent, unlink. Founders only (`assertStaffBotAccess`).
 *
 * The bot messages a person only when ALL hold: they linked a chat themselves (/start CODE),
 * did not send /stop, a founder switched "bot may message" on, they are not paused and did not
 * leave. The planner and the dispatcher both check this (staff-dispatcher.ts).
 */

export async function loadStaffDefaults(db: Db): Promise<StaffSettings> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, STAFF_DEFAULTS_KEY));
  return row ? parseStaffDefaults(row.value) : { ...DEFAULT_STAFF_SETTINGS };
}

/**
 * The defaults for PAGES (routines list and form, task form): founders read them through the
 * shared cache (tag `staff-settings`, dropped by `updateStaffDefaults`). Planner, dispatcher and
 * write paths keep reading the row (`loadStaffDefaults`).
 */
export async function readStaffDefaults(ctx: ServiceContext): Promise<StaffSettings> {
  return ctx.user.role === "founder" ? sharedCache(["staff:defaults"], [CACHE_TAGS.staffSettings], () => loadStaffDefaults(ctx.db)) : loadStaffDefaults(ctx.db);
}

export async function getStaffDefaults(ctx: ServiceContext): Promise<StaffSettings> {
  assertStaffBotAccess(ctx);
  return loadStaffDefaults(ctx.db);
}

export async function updateStaffDefaults(ctx: ServiceContext, input: unknown): Promise<StaffSettings> {
  assertStaffBotAccess(ctx);
  const value = staffDefaultsSchema.parse(input);
  await ctx.db
    .insert(appSettings)
    .values({ key: STAFF_DEFAULTS_KEY, value: { ...value }, updatedByUserId: ctx.user.id, updatedAt: ctx.now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: { ...value }, updatedByUserId: ctx.user.id, updatedAt: ctx.now } });
  invalidate(CACHE_TAGS.staffSettings);
  return value;
}

async function loadStaffPerson(ctx: ServiceContext, personId: string) {
  assertStaffBotAccess(ctx);
  assertValidId(personId, "Person");
  const [p] = await ctx.db.select().from(people).where(eq(people.id, personId));
  if (!p) throw new ServiceError("not_found", "Person not found");
  return p;
}

export interface PersonInvite {
  code: string;
  expiresAt: Date;
  deepLink: string;
  botUsername: string;
}

/** One-time code (15 minutes, hashed, single use) + deep link https://t.me/<bot>?start=<code>. */
export async function createPersonInvite(ctx: ServiceContext, personId: string): Promise<PersonInvite> {
  const p = await loadStaffPerson(ctx, personId);
  if (p.leftAt) throw new ServiceError("validation", "This person has left; they cannot be invited");
  if (p.userId) throw new ServiceError("validation", "Founders link their own Telegram on the Settings page");
  const { code, expiresAt } = await createPersonLinkCode(ctx.db, p.id, ctx.user.id, ctx.now);
  return { code, expiresAt, deepLink: inviteDeepLink(code), botUsername: inviteBotUsername() };
}

export type TelegramState = "not_linked" | "invited" | "linked" | "stopped";

export interface TeamMember {
  id: string;
  name: string;
  state: TelegramState;
  link: Pick<TelegramLink, "username" | "firstName" | "createdAt" | "stoppedAt"> | null;
  inviteExpiresAt: Date | null;
  botEnabled: boolean;
  pausedUntil: Date | null;
  paused: boolean;
  /** The bot will actually message them now. */
  reachable: boolean;
  override: Partial<StaffSettings>;
  effective: StaffSettings;
}

function memberOf(
  p: typeof people.$inferSelect,
  link: TelegramLink | undefined,
  invite: Date | undefined,
  defaults: StaffSettings,
  now: Date,
): TeamMember {
  const state: TelegramState = link ? (link.stoppedAt ? "stopped" : "linked") : invite ? "invited" : "not_linked";
  const paused = !!p.botPausedUntil && p.botPausedUntil.getTime() > now.getTime();
  const override = parsePersonOverride(p.staffChase);
  return {
    id: p.id,
    name: p.shortName || p.fullName,
    state,
    link: link ? { username: link.username, firstName: link.firstName, createdAt: link.createdAt, stoppedAt: link.stoppedAt } : null,
    inviteExpiresAt: invite ?? null,
    botEnabled: p.botEnabled,
    pausedUntil: p.botPausedUntil,
    paused,
    reachable: state === "linked" && p.botEnabled && !paused && !p.leftAt,
    override,
    effective: effectiveStaffSettings(defaults, override),
  };
}

async function inviteExpiries(db: Db, personIds: string[], now: Date): Promise<Map<string, Date>> {
  if (!personIds.length) return new Map();
  const rows = await db
    .select({ personId: telegramLinkCodes.personId, expiresAt: telegramLinkCodes.expiresAt })
    .from(telegramLinkCodes)
    .where(and(inArray(telegramLinkCodes.personId, personIds), isNull(telegramLinkCodes.usedAt), gt(telegramLinkCodes.expiresAt, now)));
  return new Map(rows.map((r) => [r.personId!, r.expiresAt]));
}

/** Everyone who is linked, invited (live code) or switched on — the Team on Telegram list. */
export async function listTeamOnTelegram(ctx: ServiceContext): Promise<TeamMember[]> {
  assertStaffBotAccess(ctx);
  const defaults = await loadStaffDefaults(ctx.db);
  const links = await ctx.db.select().from(telegramLinks).where(isNotNull(telegramLinks.personId));
  const live = await ctx.db
    .select({ personId: telegramLinkCodes.personId })
    .from(telegramLinkCodes)
    .where(and(isNotNull(telegramLinkCodes.personId), isNull(telegramLinkCodes.usedAt), gt(telegramLinkCodes.expiresAt, ctx.now)));
  const ids = [...new Set([...links.map((l) => l.personId!), ...live.map((l) => l.personId!)])];
  const rows = await ctx.db
    .select()
    .from(people)
    .where(and(isNull(people.userId), or(eq(people.botEnabled, true), ids.length ? inArray(people.id, ids) : undefined)))
    .orderBy(people.fullName);
  const invites = await inviteExpiries(ctx.db, rows.map((r) => r.id), ctx.now);
  const byPerson = new Map(links.map((l) => [l.personId!, l]));
  return rows.map((p) => memberOf(p, byPerson.get(p.id), invites.get(p.id), defaults, ctx.now));
}

export async function getTeamMember(ctx: ServiceContext, personId: string): Promise<TeamMember> {
  const p = await loadStaffPerson(ctx, personId);
  const [link] = await ctx.db.select().from(telegramLinks).where(eq(telegramLinks.personId, p.id));
  const invites = await inviteExpiries(ctx.db, [p.id], ctx.now);
  return memberOf(p, link, invites.get(p.id), await loadStaffDefaults(ctx.db), ctx.now);
}

export async function setPersonBotEnabled(ctx: ServiceContext, personId: string, enabled: boolean): Promise<void> {
  const p = await loadStaffPerson(ctx, personId);
  if (p.userId) throw new ServiceError("validation", "Founders are not messaged as staff");
  await ctx.db
    .update(people)
    .set({ botEnabled: enabled, botEnabledAt: enabled && !p.botEnabled ? ctx.now : p.botEnabledAt, updatedAt: ctx.now })
    .where(eq(people.id, p.id));
  if (!enabled) await cancelPersonQueue(ctx.db, p.id, "bot_switched_off");
}

/** Pause until the end of `date` (local day), or resume now with null / "". */
export async function setPersonPause(ctx: ServiceContext, personId: string, date: unknown): Promise<Date | null> {
  const p = await loadStaffPerson(ctx, personId);
  const day = pauseUntilSchema.parse(date);
  const until = day ? zonedTimeToUtc(addDays(day, 1), "00:00", ctx.timeZone) : null;
  if (until && until.getTime() <= ctx.now.getTime()) throw new ServiceError("validation", "Pick today or a later date");
  await ctx.db.update(people).set({ botPausedUntil: until, updatedAt: ctx.now }).where(eq(people.id, p.id));
  return until;
}

/** Per-person chase overrides; blank fields use the defaults; all blank clears the override. */
export async function setPersonChase(ctx: ServiceContext, personId: string, input: unknown): Promise<Partial<StaffSettings>> {
  const p = await loadStaffPerson(ctx, personId);
  const parsed = compactOverride(staffPersonOverrideSchema.parse(input));
  await ctx.db.update(people).set({ staffChase: parsed, updatedAt: ctx.now }).where(eq(people.id, p.id));
  // The person's chase defaults are part of the cached routine / task form options.
  invalidate(CACHE_TAGS.people);
  return parsed ?? {};
}

/** Unlink: the chat is forgotten; the person needs a new invite. Waiting messages are cancelled. */
export async function unlinkPerson(ctx: ServiceContext, personId: string): Promise<void> {
  const p = await loadStaffPerson(ctx, personId);
  await ctx.db.delete(telegramLinks).where(eq(telegramLinks.personId, p.id));
  await ctx.db
    .update(telegramLinkCodes)
    .set({ usedAt: ctx.now })
    .where(and(eq(telegramLinkCodes.personId, p.id), isNull(telegramLinkCodes.usedAt)));
  await cancelPersonQueue(ctx.db, p.id, "unlinked");
}

async function cancelPersonQueue(db: Db, personId: string, reason: string) {
  await db
    .update(notificationsOutbox)
    .set({ status: "cancelled", lastError: reason, nextAttemptAt: null })
    .where(and(eq(notificationsOutbox.personId, personId), inArray(notificationsOutbox.status, ["pending", "not_linked", "parked"])));
}

/** What the bot sent (or tried to) to this person, newest first. */
export async function listPersonMessages(ctx: ServiceContext, personId: string, limit = 20): Promise<OutboxItem[]> {
  const p = await loadStaffPerson(ctx, personId);
  return ctx.db
    .select()
    .from(notificationsOutbox)
    .where(eq(notificationsOutbox.personId, p.id))
    .orderBy(desc(notificationsOutbox.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
}

/** Recent staff messages of everyone (the dev inbox "Team messages" section). */
export async function listRecentStaffMessages(ctx: ServiceContext, limit = 30) {
  assertStaffBotAccess(ctx);
  return ctx.db
    .select({ item: notificationsOutbox, name: people.fullName, short: people.shortName })
    .from(notificationsOutbox)
    .innerJoin(people, eq(people.id, notificationsOutbox.personId))
    .orderBy(desc(notificationsOutbox.createdAt))
    .limit(limit);
}

export async function getTaskStaffChase(ctx: ServiceContext, taskId: string): Promise<StaffTaskOverride> {
  await getTask(ctx, taskId);
  const [row] = await ctx.db.select({ c: tasks.staffChase }).from(tasks).where(eq(tasks.id, taskId));
  return parseTaskOverride(row?.c);
}

/** Per-task override of the staff chase (chasing off, another cadence, escalation). */
export async function setTaskStaffChase(ctx: ServiceContext, taskId: string, input: unknown): Promise<StaffTaskOverride> {
  assertStaffBotAccess(ctx);
  const task = await getTask(ctx, taskId);
  if (task.visibility !== "shared") throw new ServiceError("validation", "Only shared tasks are chased");
  const parsed = compactOverride(staffTaskOverrideSchema.parse(input));
  await ctx.db.update(tasks).set({ staffChase: parsed }).where(eq(tasks.id, task.id));
  return parsed ?? {};
}

/** Telegram state per person (People list: a tag and the invite button). Founders only; else {}. */
export async function telegramStatesFor(ctx: ServiceContext, personIds: string[]): Promise<Record<string, { state: TelegramState; botEnabled: boolean }>> {
  if (ctx.user.role !== "founder" || !personIds.length) return {};
  const [rows, links, invites] = await Promise.all([
    ctx.db.select({ id: people.id, botEnabled: people.botEnabled }).from(people).where(inArray(people.id, personIds)),
    ctx.db.select().from(telegramLinks).where(inArray(telegramLinks.personId, personIds)),
    inviteExpiries(ctx.db, personIds, ctx.now),
  ]);
  const byPerson = new Map(links.map((l) => [l.personId!, l]));
  return Object.fromEntries(
    rows.map((r) => {
      const l = byPerson.get(r.id);
      const state: TelegramState = l ? (l.stoppedAt ? "stopped" : "linked") : invites.has(r.id) ? "invited" : "not_linked";
      return [r.id, { state, botEnabled: r.botEnabled }];
    }),
  );
}
