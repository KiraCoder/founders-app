import "server-only";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { people, taskChecklistItems, taskEvents, users, type TaskChecklistItem } from "@/server/db/schema";
import { assertValidId } from "./access";
import type { ServiceContext } from "./context";
import { ServiceError } from "./errors";
import { queueStaffTaskUpdate } from "./task-staff-updates";
import { createTask, getTask, type TaskView } from "./tasks";

/**
 * A task's checklist (subtasks, 0032). Everything goes through `getTask`, so it follows the task's
 * visibility (a personal todo's checklist is its owner's only). Items are added one by one; a tick
 * keeps the time and who (a founder here, or the assigned person in Telegram:
 * services/staff-tasks.ts `personCheckItem`). Adding, editing or removing an item of a task that
 * was already sent to its person queues ONE updated Telegram card (services/task-staff-updates.ts).
 */

export const MAX_CHECKLIST_ITEMS = 50;

export const checklistItemSchema = z.object({
  title: z.string().trim().min(1, "Write the item").max(300, "At most 300 characters"),
  details: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : typeof v === "string" ? v.trim() : v),
    z.string().max(2000, "At most 2000 characters").nullable().optional(),
  ),
});
export type ChecklistItemInput = z.input<typeof checklistItemSchema>;

export interface ChecklistItemView {
  id: string;
  title: string;
  details: string | null;
  doneAt: Date | null;
  /** Who ticked it ("Elmurat", "Nuraaly"), when ticked. */
  doneBy: string | null;
  doneVia: "app" | "telegram" | null;
}

/** What a change did for the assigned person (the UI's toast: "Elmurat will get an updated message"). */
export interface StaffNotice {
  notified: boolean;
  personName: string | null;
}

export async function listChecklist(ctx: ServiceContext, taskId: string): Promise<ChecklistItemView[]> {
  await getTask(ctx, taskId);
  return checklistRows(ctx, [taskId]).then((m) => m.get(taskId) ?? []);
}

/** Checklists of several (already access-checked) tasks, for the task list's progress. */
export async function checklistProgress(ctx: ServiceContext, taskIds: string[]): Promise<Map<string, { done: number; total: number }>> {
  if (!taskIds.length) return new Map();
  const rows = await ctx.db
    .select({
      taskId: taskChecklistItems.taskId,
      total: sql<number>`count(*)`.mapWith(Number),
      done: sql<number>`count(${taskChecklistItems.doneAt})`.mapWith(Number),
    })
    .from(taskChecklistItems)
    .where(inArray(taskChecklistItems.taskId, taskIds))
    .groupBy(taskChecklistItems.taskId);
  return new Map(rows.map((r) => [r.taskId, { done: r.done, total: r.total }]));
}

async function checklistRows(ctx: ServiceContext, taskIds: string[]): Promise<Map<string, ChecklistItemView[]>> {
  const rows = await ctx.db
    .select({ i: taskChecklistItems, userName: users.shortName, personName: people.fullName, personShort: people.shortName })
    .from(taskChecklistItems)
    .leftJoin(users, eq(users.id, taskChecklistItems.doneByUserId))
    .leftJoin(people, eq(people.id, taskChecklistItems.doneByPersonId))
    .where(inArray(taskChecklistItems.taskId, taskIds))
    .orderBy(asc(taskChecklistItems.position), asc(taskChecklistItems.createdAt));
  const out = new Map<string, ChecklistItemView[]>();
  for (const r of rows) {
    const list = out.get(r.i.taskId) ?? [];
    list.push({
      id: r.i.id,
      title: r.i.title,
      details: r.i.details,
      doneAt: r.i.doneAt,
      doneBy: r.i.doneAt ? (r.userName ?? r.personShort ?? r.personName ?? null) : null,
      doneVia: !r.i.doneAt ? null : r.i.doneByPersonId ? "telegram" : "app",
    });
    out.set(r.i.taskId, list);
  }
  return out;
}

async function logChecklist(ctx: ServiceContext, taskId: string, value: Record<string, unknown>) {
  const task = await getTask(ctx, taskId);
  await ctx.db.insert(taskEvents).values({
    taskId,
    companyId: task.company?.id ?? null,
    actorUserId: ctx.user.id,
    visibility: task.visibility,
    ownerUserId: task.ownerUserId,
    kind: "updated",
    field: "checklist",
    newValue: value,
  });
}

/** Adds one item at the end. */
export async function addChecklistItem(
  ctx: ServiceContext,
  taskId: string,
  input: ChecklistItemInput,
  opts: { notify?: boolean } = {},
): Promise<{ item: TaskChecklistItem } & StaffNotice> {
  const data = checklistItemSchema.parse(input);
  await getTask(ctx, taskId);
  const [count] = await ctx.db
    .select({ n: sql<number>`count(*)`.mapWith(Number), max: sql<number>`coalesce(max(${taskChecklistItems.position}), -1)`.mapWith(Number) })
    .from(taskChecklistItems)
    .where(eq(taskChecklistItems.taskId, taskId));
  if ((count?.n ?? 0) >= MAX_CHECKLIST_ITEMS) {
    throw new ServiceError("validation", `At most ${MAX_CHECKLIST_ITEMS} items per task`, { title: [`At most ${MAX_CHECKLIST_ITEMS} items`] });
  }
  const [item] = await ctx.db
    .insert(taskChecklistItems)
    .values({ taskId, title: data.title, details: data.details ?? null, position: (count?.max ?? -1) + 1, createdByUserId: ctx.user.id })
    .returning();
  await logChecklist(ctx, taskId, { action: "added", item: data.title });
  const n = opts.notify === false ? { queued: false, personName: null } : await queueStaffTaskUpdate(ctx.db, taskId, ctx.now);
  return { item: item!, notified: n.queued, personName: n.personName };
}

async function loadItem(ctx: ServiceContext, itemId: string): Promise<TaskChecklistItem> {
  assertValidId(itemId, "Item");
  const [row] = await ctx.db.select().from(taskChecklistItems).where(eq(taskChecklistItems.id, itemId));
  if (!row) throw new ServiceError("not_found", "Item not found");
  await getTask(ctx, row.taskId); // the task's visibility
  return row;
}

export async function updateChecklistItem(ctx: ServiceContext, itemId: string, input: ChecklistItemInput): Promise<StaffNotice> {
  const data = checklistItemSchema.parse(input);
  const item = await loadItem(ctx, itemId);
  if (item.title === data.title && (item.details ?? null) === (data.details ?? null)) return { notified: false, personName: null };
  await ctx.db
    .update(taskChecklistItems)
    .set({ title: data.title, details: data.details ?? null, updatedAt: ctx.now })
    .where(eq(taskChecklistItems.id, item.id));
  await logChecklist(ctx, item.taskId, { action: "edited", item: data.title });
  const n = await queueStaffTaskUpdate(ctx.db, item.taskId, ctx.now);
  return { notified: n.queued, personName: n.personName };
}

export async function removeChecklistItem(ctx: ServiceContext, itemId: string): Promise<StaffNotice> {
  const item = await loadItem(ctx, itemId);
  await ctx.db.delete(taskChecklistItems).where(eq(taskChecklistItems.id, item.id));
  await logChecklist(ctx, item.taskId, { action: "removed", item: item.title });
  const n = await queueStaffTaskUpdate(ctx.db, item.taskId, ctx.now);
  return { notified: n.queued, personName: n.personName };
}

/**
 * Moves an item one place up or down (positions are rewritten 0, 1, 2 … in the new order). The
 * person's card lists the items in order, so a sent task gets ONE updated card like other edits.
 */
export async function moveChecklistItem(ctx: ServiceContext, itemId: string, direction: "up" | "down"): Promise<StaffNotice> {
  if (direction !== "up" && direction !== "down") throw new ServiceError("validation", "Invalid direction");
  const item = await loadItem(ctx, itemId);
  const order = (
    await ctx.db
      .select({ id: taskChecklistItems.id })
      .from(taskChecklistItems)
      .where(eq(taskChecklistItems.taskId, item.taskId))
      .orderBy(asc(taskChecklistItems.position), asc(taskChecklistItems.createdAt))
  ).map((r) => r.id);
  const i = order.indexOf(item.id);
  const j = direction === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= order.length) return { notified: false, personName: null };
  [order[i], order[j]] = [order[j]!, order[i]!];
  await ctx.db.transaction(async (tx) => {
    for (const [pos, id] of order.entries()) await tx.update(taskChecklistItems).set({ position: pos }).where(eq(taskChecklistItems.id, id));
  });
  await logChecklist(ctx, item.taskId, { action: "moved", item: item.title, direction });
  const n = await queueStaffTaskUpdate(ctx.db, item.taskId, ctx.now);
  return { notified: n.queued, personName: n.personName };
}

/** A founder ticks / unticks an item (no message to the person: the next card shows it). */
export async function setChecklistItemDone(ctx: ServiceContext, itemId: string, done: boolean): Promise<void> {
  const item = await loadItem(ctx, itemId);
  if (!!item.doneAt === done) return;
  await ctx.db
    .update(taskChecklistItems)
    .set(done ? { doneAt: ctx.now, doneByUserId: ctx.user.id, doneByPersonId: null, updatedAt: ctx.now } : { doneAt: null, doneByUserId: null, doneByPersonId: null, updatedAt: ctx.now })
    .where(and(eq(taskChecklistItems.id, item.id), done ? isNull(taskChecklistItems.doneAt) : sql`true`));
  await logChecklist(ctx, item.taskId, { action: done ? "ticked" : "unticked", item: item.title });
}

/** Parses the create dialog's items (JSON: [{title, details}]); blank rows are dropped. */
export function parseChecklistField(raw: unknown): { title: string; details: string | null }[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ServiceError("validation", "Checklist could not be read", { checklist: ["Could not be read"] });
  }
  if (!Array.isArray(parsed)) return [];
  const items = parsed
    .filter((v) => v && typeof v === "object" && typeof (v as { title?: unknown }).title === "string" && (v as { title: string }).title.trim())
    .map((v) => checklistItemSchema.parse(v))
    .map((v) => ({ title: v.title, details: v.details ?? null }));
  if (items.length > MAX_CHECKLIST_ITEMS) throw new ServiceError("validation", `At most ${MAX_CHECKLIST_ITEMS} items per task`, { checklist: ["Too many items"] });
  return items;
}

/**
 * Promotes a sub-task (checklist item) to a full task (0034): a new task with the item's title
 * and details, in the same company / project / visibility, assigned like its parent, and linked
 * to it (tasks.parent_task_id). The item leaves the checklist (logged on the parent). A ticked
 * item becomes a Done task.
 */
export async function promoteChecklistItem(ctx: ServiceContext, itemId: string): Promise<TaskView> {
  const item = await loadItem(ctx, itemId);
  const parent = await getTask(ctx, item.taskId);
  const created = await createTask(ctx, {
    title: item.title,
    notes: item.details ?? null,
    visibility: parent.visibility,
    companyId: parent.company?.id ?? null,
    projectId: parent.project?.id ?? null,
    assigneeUserId: parent.assignee?.kind === "user" ? parent.assignee.id : null,
    assigneePersonId: parent.assignee?.kind === "person" ? parent.assignee.id : null,
    status: item.doneAt ? "done" : parent.status === "backlog" ? "backlog" : "todo",
    priority: parent.priority,
    parentTaskId: parent.id,
  });
  await ctx.db.delete(taskChecklistItems).where(eq(taskChecklistItems.id, item.id));
  await logChecklist(ctx, parent.id, { action: "promoted", item: item.title, taskId: created.id, key: created.key });
  return created;
}
