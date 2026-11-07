import "server-only";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { taskLabelLinks, taskLabels, type TaskLabel } from "@/server/db/schema";
import type { Db } from "@/server/db/connect";
import { CACHE_TAGS, invalidate } from "@/server/cache";
import { assertValidId } from "./access";
import type { ServiceContext } from "./context";
import { ServiceError } from "./errors";

/**
 * Task labels (0034): a name + a color, shared by both founders, many per task. Created inline
 * from a task's label picker or in Settings → Labels (rename, recolour, archive, delete when no
 * task uses it). Archived labels stay on the tasks that have them but are not offered any more.
 */

export interface LabelView {
  id: string;
  name: string;
  color: string;
  archived: boolean;
  /** Tasks using it (Settings → Labels). */
  uses?: number;
}

/** A small palette for new labels (cycled by count when no color is given). */
export const LABEL_COLORS = ["#2563EB", "#16A34A", "#9333EA", "#EA580C", "#DB2777", "#0891B2", "#CA8A04", "#DC2626", "#4B5563", "#65A30D"] as const;

const nameSchema = z.string().trim().min(1, "Name is required").max(40, "At most 40 characters");
const colorSchema = z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/, "Pick a color");

export const labelCreateSchema = z.object({ name: nameSchema, color: colorSchema.optional() }).strict();
export const labelUpdateSchema = z
  .object({ name: nameSchema.optional(), color: colorSchema.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

function assertFounder(ctx: ServiceContext) {
  if (ctx.user.role !== "founder") throw new ServiceError("forbidden", "Only the founders manage labels");
}

const view = (l: TaskLabel, uses?: number): LabelView => ({ id: l.id, name: l.name, color: l.color.toUpperCase(), archived: !!l.archivedAt, ...(uses !== undefined ? { uses } : {}) });

/** Labels to offer (not archived), or every label with its use count (Settings → Labels). */
export async function listLabels(ctx: ServiceContext, opts: { includeArchived?: boolean; withUses?: boolean } = {}): Promise<LabelView[]> {
  const rows = await ctx.db
    .select({
      l: taskLabels,
      uses: opts.withUses ? sql<number>`(select count(*) from ${taskLabelLinks} where ${taskLabelLinks.labelId} = ${taskLabels.id})`.mapWith(Number) : sql<number>`0`.mapWith(Number),
    })
    .from(taskLabels)
    .where(opts.includeArchived ? undefined : isNull(taskLabels.archivedAt))
    .orderBy(asc(taskLabels.sort), asc(sql`lower(${taskLabels.name})`));
  return rows.map((r) => view(r.l, opts.withUses ? r.uses : undefined));
}

async function nameTaken(db: Db, name: string, exceptId?: string): Promise<boolean> {
  const [row] = await db
    .select({ id: taskLabels.id })
    .from(taskLabels)
    .where(and(sql`lower(${taskLabels.name}) = lower(${name})`, exceptId ? sql`${taskLabels.id} <> ${exceptId}` : undefined));
  return !!row;
}

export async function createLabel(ctx: ServiceContext, input: unknown): Promise<LabelView> {
  assertFounder(ctx);
  const data = labelCreateSchema.parse(input);
  if (await nameTaken(ctx.db, data.name)) throw new ServiceError("validation", `A label “${data.name}” already exists`, { name: ["Already exists"] });
  const [{ n }] = (await ctx.db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(taskLabels)) as [{ n: number }];
  const [row] = await ctx.db
    .insert(taskLabels)
    .values({ name: data.name, color: (data.color ?? LABEL_COLORS[n % LABEL_COLORS.length]!).toUpperCase(), sort: 100 + n, createdByUserId: ctx.user.id })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new ServiceError("validation", `A label “${data.name}” already exists`, { name: ["Already exists"] });
  invalidate(CACHE_TAGS.labels);
  return view(row);
}

async function loadLabel(ctx: ServiceContext, id: string): Promise<TaskLabel> {
  assertValidId(id, "Label");
  const [row] = await ctx.db.select().from(taskLabels).where(eq(taskLabels.id, id));
  if (!row) throw new ServiceError("not_found", "Label not found");
  return row;
}

export async function updateLabel(ctx: ServiceContext, id: string, input: unknown): Promise<LabelView> {
  assertFounder(ctx);
  const patch = labelUpdateSchema.parse(input);
  const current = await loadLabel(ctx, id);
  if (patch.name && (await nameTaken(ctx.db, patch.name, current.id))) throw new ServiceError("validation", `A label “${patch.name}” already exists`, { name: ["Already exists"] });
  const [row] = await ctx.db
    .update(taskLabels)
    .set({ ...(patch.name ? { name: patch.name } : {}), ...(patch.color ? { color: patch.color.toUpperCase() } : {}), updatedAt: ctx.now })
    .where(eq(taskLabels.id, current.id))
    .returning();
  invalidate(CACHE_TAGS.labels);
  return view(row!);
}

export async function setLabelArchived(ctx: ServiceContext, id: string, archived: boolean): Promise<LabelView> {
  assertFounder(ctx);
  const current = await loadLabel(ctx, id);
  const [row] = await ctx.db
    .update(taskLabels)
    .set({ archivedAt: archived ? (current.archivedAt ?? ctx.now) : null, updatedAt: ctx.now })
    .where(eq(taskLabels.id, current.id))
    .returning();
  invalidate(CACHE_TAGS.labels);
  return view(row!);
}

/** Deletes a label no task uses (otherwise archive it). */
export async function deleteLabel(ctx: ServiceContext, id: string): Promise<void> {
  assertFounder(ctx);
  const current = await loadLabel(ctx, id);
  const deleted = await ctx.db
    .delete(taskLabels)
    .where(and(eq(taskLabels.id, current.id), sql`not exists (select 1 from ${taskLabelLinks} where ${taskLabelLinks.labelId} = ${current.id})`))
    .returning({ id: taskLabels.id });
  invalidate(CACHE_TAGS.labels);
  if (!deleted.length) throw new ServiceError("validation", `“${current.name}” is used by tasks — archive it instead`);
}

/** Labels of these tasks (archived ones included: a task keeps its labels). */
export async function labelsForTasks(db: Db, taskIds: readonly string[]): Promise<Map<string, LabelView[]>> {
  const out = new Map<string, LabelView[]>();
  if (!taskIds.length) return out;
  const rows = await db
    .select({ taskId: taskLabelLinks.taskId, l: taskLabels })
    .from(taskLabelLinks)
    .innerJoin(taskLabels, eq(taskLabels.id, taskLabelLinks.labelId))
    .where(inArray(taskLabelLinks.taskId, [...taskIds]))
    .orderBy(asc(taskLabels.sort), asc(sql`lower(${taskLabels.name})`));
  for (const r of rows) {
    const list = out.get(r.taskId) ?? [];
    list.push(view(r.l));
    out.set(r.taskId, list);
  }
  return out;
}

/**
 * Checks label ids for a task (unknown → validation error; an archived label may only stay, not
 * be added) and returns them de-duplicated.
 */
export async function validLabelIds(db: Db, ids: readonly string[], keep: readonly string[] = []): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const rows = await db.select({ id: taskLabels.id, archivedAt: taskLabels.archivedAt, name: taskLabels.name }).from(taskLabels).where(inArray(taskLabels.id, unique));
  const found = new Map(rows.map((r) => [r.id, r]));
  for (const id of unique) {
    const r = found.get(id);
    if (!r) throw new ServiceError("validation", "Label not found", { labelIds: ["Unknown label"] });
    if (r.archivedAt && !keep.includes(id)) throw new ServiceError("validation", `“${r.name}” is archived`, { labelIds: ["Archived label"] });
  }
  return unique;
}

/** Replaces a task's labels; returns the old and new id lists (for the activity log). */
export async function replaceTaskLabels(db: Db, taskId: string, labelIds: readonly string[]): Promise<{ before: string[]; after: string[] }> {
  const current = await db.select({ id: taskLabelLinks.labelId }).from(taskLabelLinks).where(eq(taskLabelLinks.taskId, taskId));
  const before = current.map((c) => c.id).sort();
  const after = [...new Set(labelIds)].sort();
  const drop = before.filter((id) => !after.includes(id));
  const add = after.filter((id) => !before.includes(id));
  if (drop.length) await db.delete(taskLabelLinks).where(and(eq(taskLabelLinks.taskId, taskId), inArray(taskLabelLinks.labelId, drop)));
  if (add.length) await db.insert(taskLabelLinks).values(add.map((labelId) => ({ taskId, labelId }))).onConflictDoNothing();
  return { before, after };
}

/** Label names by id (activity lines). */
export async function labelNames(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db.select({ id: taskLabels.id, name: taskLabels.name }).from(taskLabels).where(inArray(taskLabels.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r.name]));
}
