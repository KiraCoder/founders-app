import "server-only";
import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import { salaryInputSchema, type SalaryInput } from "@/lib/people-schemas";
import {
  people,
  personCompanies,
  salaries,
  salaryAccessLog,
  salaryViewers,
  users,
  type SalaryPayType,
} from "@/server/db/schema";
import type { Db } from "@/server/db/connect";
import { assertSalaryViewer, assertValidId, isSalaryViewer, visibleLinksWhere } from "./access";
import { today, type ServiceContext } from "./context";
import { ServiceError } from "./errors";

/**
 * Salaries: the ONLY module that reads or writes the `salaries` table. Every exported
 * function that returns or changes salary data calls `assertSalaryViewer` first.
 */

export interface SalaryView {
  id: string;
  amount: number;
  currency: string;
  payType: SalaryPayType;
  effectiveFrom: string;
  note: string | null;
  createdAt: string;
  createdByName: string | null;
}

export type SalaryAction = "view" | "change" | "import" | "grant_viewer" | "revoke_viewer";

export async function canViewSalaries(ctx: ServiceContext): Promise<boolean> {
  return isSalaryViewer(ctx);
}

/** Audit row. Views are logged once per page/API call, never per row. */
export async function logSalaryAccess(
  ctx: ServiceContext,
  entry: {
    action: SalaryAction;
    scope: string;
    personId?: string | null;
    personCompanyId?: string | null;
    targetUserId?: string | null;
    details?: Record<string, unknown> | null;
  },
): Promise<void> {
  await ctx.db.insert(salaryAccessLog).values({
    actorUserId: ctx.user.id,
    action: entry.action,
    scope: entry.scope.slice(0, 120),
    personId: entry.personId ?? null,
    personCompanyId: entry.personCompanyId ?? null,
    targetUserId: entry.targetUserId ?? null,
    details: entry.details ?? null,
    createdAt: ctx.now,
  });
}

function toView(r: {
  id: string;
  amount: string;
  currency: string;
  payType: SalaryPayType;
  effectiveFrom: string;
  note: string | null;
  createdAt: Date;
  createdByName: string | null;
}): SalaryView {
  return { ...r, amount: Number(r.amount), createdAt: r.createdAt.toISOString() };
}

const salaryColumns = {
  id: salaries.id,
  personCompanyId: salaries.personCompanyId,
  amount: salaries.amount,
  currency: salaries.currency,
  payType: salaries.payType,
  effectiveFrom: salaries.effectiveFrom,
  note: salaries.note,
  createdAt: salaries.createdAt,
  createdByName: users.shortName,
};

/**
 * Current salary per link: the latest `effective_from` on or before today (ties: newest
 * row, by created_at and then insert order `seq`). Links without a current salary are absent from the map. Viewer only.
 */
export async function currentSalaries(ctx: ServiceContext, linkIds: string[]): Promise<Map<string, SalaryView>> {
  await assertSalaryViewer(ctx);
  const out = new Map<string, SalaryView>();
  if (linkIds.length === 0) return out;
  const rows = await ctx.db
    .select(salaryColumns)
    .from(salaries)
    .innerJoin(personCompanies, eq(personCompanies.id, salaries.personCompanyId))
    .leftJoin(users, eq(users.id, salaries.createdBy))
    .where(
      and(inArray(salaries.personCompanyId, linkIds), lte(salaries.effectiveFrom, today(ctx)), visibleLinksWhere(ctx)),
    )
    .orderBy(desc(salaries.effectiveFrom), desc(salaries.createdAt), desc(salaries.seq));
  for (const { personCompanyId, ...r } of rows) {
    if (!out.has(personCompanyId)) out.set(personCompanyId, toView(r));
  }
  return out;
}

/** Full history (newest first, future-dated rows included) per link. Viewer only. */
export async function salaryHistory(ctx: ServiceContext, linkIds: string[]): Promise<Map<string, SalaryView[]>> {
  await assertSalaryViewer(ctx);
  const out = new Map<string, SalaryView[]>();
  if (linkIds.length === 0) return out;
  const rows = await ctx.db
    .select(salaryColumns)
    .from(salaries)
    .innerJoin(personCompanies, eq(personCompanies.id, salaries.personCompanyId))
    .leftJoin(users, eq(users.id, salaries.createdBy))
    .where(and(inArray(salaries.personCompanyId, linkIds), visibleLinksWhere(ctx)))
    .orderBy(desc(salaries.effectiveFrom), desc(salaries.createdAt), desc(salaries.seq));
  for (const { personCompanyId, ...r } of rows) {
    (out.get(personCompanyId) ?? out.set(personCompanyId, []).get(personCompanyId)!).push(toView(r));
  }
  return out;
}

/**
 * Records a salary change as a NEW row (history is kept). Viewer only; audited.
 * `scope` says where the change came from ("person", "api", "import").
 */
export async function addSalary(
  ctx: ServiceContext,
  personCompanyId: string,
  input: SalaryInput,
  scope = "person",
): Promise<SalaryView> {
  await assertSalaryViewer(ctx);
  assertValidId(personCompanyId, "Company link");
  const data = salaryInputSchema.parse(input);
  const [link] = await ctx.db
    .select({ id: personCompanies.id, personId: personCompanies.personId })
    .from(personCompanies)
    .where(and(eq(personCompanies.id, personCompanyId), visibleLinksWhere(ctx)));
  if (!link) throw new ServiceError("not_found", "Company link not found");

  const effectiveFrom = data.effectiveFrom ?? today(ctx);
  // The salary row and its audit row are written together or not at all (a savepoint
  // when the caller is already in a transaction).
  return ctx.db.transaction(async (rawTx) => {
    const tx: ServiceContext = { ...ctx, db: rawTx as unknown as Db };
    const [row] = await tx.db
    .insert(salaries)
    .values({
      personCompanyId,
      amount: data.amount.toFixed(2),
      currency: data.currency,
      payType: data.payType ?? "monthly",
      effectiveFrom,
      note: data.note ?? null,
      createdBy: ctx.user.id,
      createdAt: ctx.now,
    })
    .returning();
    await logSalaryAccess(tx, {
      action: "change",
      scope,
      personId: link.personId,
      personCompanyId,
      details: { effectiveFrom, payType: row!.payType, currency: row!.currency },
    });
    return toView({ ...row!, createdByName: ctx.user.shortName });
  });
}

// ---------------------------------------------------------------------------
// Salary viewers (Settings → Access)
// ---------------------------------------------------------------------------

export interface SalaryViewerRow {
  userId: string;
  name: string;
  shortName: string;
  isViewer: boolean;
}

/** Founders and whether each may see salaries. Any founder may read this list. */
export async function listSalaryViewers(ctx: ServiceContext): Promise<SalaryViewerRow[]> {
  if (ctx.user.role !== "founder") throw new ServiceError("forbidden", "Founders only");
  const rows = await ctx.db
    .select({ userId: users.id, name: users.name, shortName: users.shortName, viewer: salaryViewers.userId })
    .from(users)
    .leftJoin(salaryViewers, eq(salaryViewers.userId, users.id))
    .where(eq(users.role, "founder"))
    .orderBy(asc(users.shortName));
  return rows.map((r) => ({ userId: r.userId, name: r.name, shortName: r.shortName, isViewer: r.viewer !== null }));
}

/**
 * Grants or revokes salary access. Only an existing salary viewer may do this; the last
 * viewer cannot be removed (nobody could ever grant it again). Audited.
 *
 * Runs in one transaction that first locks every salary_viewers row (FOR UPDATE), so two
 * founders revoking each other at the same moment are serialised: the second one sees
 * the first revoke and is refused. The actor is re-checked under the lock, and the audit
 * row is written in the same transaction.
 */
export async function setSalaryViewer(ctx: ServiceContext, userId: string, enabled: boolean): Promise<void> {
  await assertSalaryViewer(ctx);
  assertValidId(userId, "User");
  const [target] = await ctx.db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.id, userId));
  if (!target) throw new ServiceError("not_found", "User not found");
  if (target.role !== "founder") throw new ServiceError("validation", "Only founders can be salary viewers for now");

  await ctx.db.transaction(async (rawTx) => {
    const tx: ServiceContext = { ...ctx, db: rawTx as unknown as Db };
    const all = await tx.db.select({ userId: salaryViewers.userId }).from(salaryViewers).for("update");
    if (!all.some((v) => v.userId === ctx.user.id)) {
      throw new ServiceError("forbidden", "Only salary viewers can see or change salaries");
    }
    if (enabled) {
      const inserted = await tx.db
        .insert(salaryViewers)
        .values({ userId, grantedBy: ctx.user.id, createdAt: ctx.now })
        .onConflictDoNothing()
        .returning({ userId: salaryViewers.userId });
      if (inserted.length > 0) {
        await logSalaryAccess(tx, { action: "grant_viewer", scope: "settings", targetUserId: userId });
      }
      return;
    }
    if (!all.some((v) => v.userId === userId)) return;
    if (all.length <= 1) throw new ServiceError("conflict", "At least one salary viewer must remain");
    await tx.db.delete(salaryViewers).where(eq(salaryViewers.userId, userId));
    await logSalaryAccess(tx, { action: "revoke_viewer", scope: "settings", targetUserId: userId });
  });
}

export interface SalaryLogRow {
  id: string;
  at: string;
  actor: string | null;
  action: string;
  scope: string;
  personName: string | null;
  targetName: string | null;
}

/** Recent salary audit entries. Viewer only. */
export async function listSalaryAccessLog(ctx: ServiceContext, limit = 50): Promise<SalaryLogRow[]> {
  await assertSalaryViewer(ctx);
  const actor = users;
  const rows = await ctx.db
    .select({
      id: salaryAccessLog.id,
      at: salaryAccessLog.createdAt,
      actor: actor.shortName,
      action: salaryAccessLog.action,
      scope: salaryAccessLog.scope,
      personName: people.fullName,
      targetUserId: salaryAccessLog.targetUserId,
    })
    .from(salaryAccessLog)
    .leftJoin(actor, eq(actor.id, salaryAccessLog.actorUserId))
    .leftJoin(people, eq(people.id, salaryAccessLog.personId))
    .orderBy(desc(salaryAccessLog.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
  const names = new Map(
    (await ctx.db.select({ id: users.id, shortName: users.shortName }).from(users)).map((u) => [u.id, u.shortName]),
  );
  return rows.map(({ targetUserId, ...r }) => ({
    ...r,
    at: r.at.toISOString(),
    targetName: targetUserId ? (names.get(targetUserId) ?? null) : null,
  }));
}
