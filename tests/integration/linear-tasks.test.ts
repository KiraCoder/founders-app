/**
 * Tasks like Linear (0034): keys (per company, concurrency-safe, renumbered on a company move,
 * ME for personal todos, searchable), labels (CRUD + on tasks), inline updates and permissions,
 * the bulk change, filters, estimate overrun (detection + ONE nudge), «Готово» with needs review,
 * «Принято» → In Progress, and the MCP / assistant tools.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { DEFAULT_STAFF_SETTINGS } from "@/lib/staff-schemas";
import {
  companies,
  notificationActionTokens,
  notificationsOutbox,
  people,
  taskEvents,
  taskKeyCounters,
  tasks,
  telegramLinkCodes,
  telegramLinks,
} from "@/server/db/schema";
import { planOverEstimates } from "@/server/notifications/estimate-planner";
import { handleTelegramUpdate } from "@/server/notifications/telegram-bot";
import type { TelegramUpdate } from "@/server/notifications/telegram-api";
import { findTool } from "@/server/mcp/all-tools";
import { runNow } from "@/server/mcp/registry";
import { createPersonInvite, setPersonBotEnabled, updateStaffDefaults } from "@/server/services/staff";
import { personAccept, personContext, personMarkDone } from "@/server/services/staff-tasks";
import { applyTaskAction } from "@/server/services/notifications";
import { createLabel, deleteLabel, listLabels, setLabelArchived, updateLabel } from "@/server/services/task-labels";
import { setTaskChase } from "@/server/services/task-activity";
import { addChecklistItem, listChecklist, promoteChecklistItem } from "@/server/services/task-checklist";
import { updateCompany } from "@/server/services/companies";
import { bulkUpdateTasks, createTask, findTaskByKey, getTask, listTasks, updateTask } from "@/server/services/tasks";
import { createTestDb, type TestDb } from "../helpers/db";

const local = (day: string, hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), h! - 6, m!));
};
const D = "2026-11-02"; // a Monday
const EDIL_CHAT = 7_000_001;

let t: TestDb;
let edil: string;
let kiwi: string;
let jobutify: string;

beforeAll(async () => {
  t = await createTestDb();
  edil = t.personIds.edil!;
  kiwi = t.companyIds["kiwi-go"]!;
  jobutify = t.companyIds.jobutify!;
});
afterAll(async () => {
  await t.handle.close();
});
beforeEach(async () => {
  const db = t.handle.db;
  await db.delete(notificationActionTokens);
  await db.delete(notificationsOutbox);
  await db.delete(telegramLinks);
  await db.delete(telegramLinkCodes);
  await db.delete(taskEvents);
  await db.delete(tasks);
  await db.update(people).set({ botEnabled: false, botEnabledAt: null, botPausedUntil: null, staffChase: null });
  await updateStaffDefaults(t.ctx("nuraaly"), { ...DEFAULT_STAFF_SETTINGS });
});

const msgUpdate = (chatId: number, text: string): TelegramUpdate => ({
  update_id: Math.floor(Math.random() * 1e9),
  message: { message_id: 1, chat: { id: chatId, type: "private" }, from: { id: chatId, first_name: "X" }, text },
});
async function onTelegram(personId: string, chatId: number, at = local(D, "08:30")) {
  const invite = await createPersonInvite(t.ctx("nuraaly", at), personId);
  await handleTelegramUpdate(t.handle.db, msgUpdate(chatId, `/start ${invite.code}`), at);
  await setPersonBotEnabled(t.ctx("nuraaly", at), personId, true);
}
const prefixOf = async (companyId: string) => (await t.handle.db.select({ p: companies.taskPrefix }).from(companies).where(eq(companies.id, companyId)))[0]!.p!;

describe("task keys", () => {
  it("each company numbers its own tasks; personal todos are ME-n per founder; keys are searchable", async () => {
    const n = t.ctx("nuraaly");
    const a = await createTask(n, { title: "Kiwi one", companyId: kiwi });
    const b = await createTask(n, { title: "Kiwi two", companyId: kiwi });
    const j = await createTask(n, { title: "Job one", companyId: jobutify });
    const me = await createTask(n, { title: "Mine", visibility: "private" });
    const tal = await createTask(t.ctx("talant"), { title: "Talant's", visibility: "private" });
    const kiwiPrefix = await prefixOf(kiwi);
    expect(kiwiPrefix).toMatch(/^[A-Z][A-Z0-9]{1,5}$/);
    expect(b.number).toBe(a.number + 1);
    expect(a.key).toBe(`${kiwiPrefix}-${a.number}`);
    expect(j.key.startsWith(`${await prefixOf(jobutify)}-`)).toBe(true);
    expect(me.key).toMatch(/^ME-\d+$/);
    expect(tal.key).toMatch(/^ME-\d+$/);
    // Search by key (any case), and a bare number.
    expect((await listTasks(n, { status: "any", search: b.key.toLowerCase() })).map((x) => x.id)).toEqual([b.id]);
    expect((await findTaskByKey(n, a.key))?.id).toBe(a.id);
    expect((await findTaskByKey(n, me.key))?.id).toBe(me.id);
    // Talant's ME-n is not mine.
    expect(await findTaskByKey(t.ctx("nuraaly"), `ME-${tal.number}`).then((x) => x?.id ?? null)).not.toBe(tal.id);
  });

  it("concurrent creates in one company never get the same number (the counter row serializes them)", async () => {
    const n = t.ctx("nuraaly");
    const made = await Promise.all(Array.from({ length: 12 }, (_, i) => createTask(n, { title: `Parallel ${i}`, companyId: kiwi })));
    const numbers = made.map((m) => m.number).sort((x, y) => x - y);
    expect(new Set(numbers).size).toBe(12);
    expect(numbers[11]! - numbers[0]!).toBe(11);
    const [counter] = await t.handle.db.select().from(taskKeyCounters).where(eq(taskKeyCounters.scope, `company:${kiwi}`));
    expect(counter!.lastNumber).toBeGreaterThanOrEqual(numbers[11]!);
  });

  it("moving a task to another company gives it that company's next key; the prefix is editable", async () => {
    const n = t.ctx("nuraaly");
    const task = await createTask(n, { title: "Mover", companyId: kiwi });
    const moved = await updateTask(n, task.id, { companyId: jobutify });
    expect(moved.key.startsWith(`${await prefixOf(jobutify)}-`)).toBe(true);
    await updateCompany(n, jobutify, { taskPrefix: "jbt" });
    expect((await getTask(n, task.id)).key).toBe(`JBT-${moved.number}`);
    await expect(updateCompany(n, kiwi, { taskPrefix: "JBT" })).rejects.toMatchObject({ code: "conflict" });
    await expect(updateCompany(n, kiwi, { taskPrefix: "ME" })).rejects.toThrow(/kept for personal todos/);
  });
});

describe("labels", () => {
  it("seeded labels, create / rename / recolor / archive, delete only when unused", async () => {
    const n = t.ctx("nuraaly");
    expect((await listLabels(n)).map((l) => l.name)).toEqual(expect.arrayContaining(["Operations", "Improvement", "Automation", "Production", "Photos"]));
    const l = await createLabel(n, { name: "Urgent fix", color: "#ff0000" });
    expect(l.color).toBe("#FF0000");
    await expect(createLabel(n, { name: "urgent FIX" })).rejects.toMatchObject({ code: "validation" });
    await updateLabel(n, l.id, { name: "Hotfix", color: "#00aa00" });
    const task = await createTask(n, { title: "Labelled", companyId: kiwi, labelIds: [l.id] });
    expect(task.labels.map((x) => x.name)).toEqual(["Hotfix"]);
    await expect(deleteLabel(n, l.id)).rejects.toMatchObject({ code: "validation" });
    await setLabelArchived(n, l.id, true);
    expect((await listLabels(n)).some((x) => x.id === l.id)).toBe(false);
    // An archived label stays on its task but cannot be added to another.
    expect((await getTask(n, task.id)).labels.map((x) => x.name)).toEqual(["Hotfix"]);
    const other = await createTask(n, { title: "Other", companyId: kiwi });
    await expect(updateTask(n, other.id, { labelIds: [l.id] })).rejects.toMatchObject({ code: "validation" });
    await updateTask(n, task.id, { labelIds: [] });
    await deleteLabel(n, l.id);
    expect((await listLabels(n, { includeArchived: true })).some((x) => x.id === l.id)).toBe(false);
  });

  it("only founders manage labels", async () => {
    const staff = { ...t.ctx("nuraaly"), user: { ...t.founders.nuraaly, role: "staff" as const } };
    await expect(createLabel(staff, { name: "Nope" })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("inline updates, permissions and the bulk bar", () => {
  it("status, priority, estimate, labels and needs review change one at a time, each logged", async () => {
    const n = t.ctx("nuraaly");
    const [ops] = (await listLabels(n)).filter((l) => l.name === "Operations");
    const task = await createTask(n, { title: "Inline", companyId: kiwi });
    expect(task).toMatchObject({ status: "todo", priority: "none", estimate: null, needsReview: true });
    await updateTask(n, task.id, { status: "in_progress" });
    await updateTask(n, task.id, { priority: "high" });
    await updateTask(n, task.id, { estimate: 5 });
    await updateTask(n, task.id, { labelIds: [ops!.id] });
    const after = await updateTask(n, task.id, { needsReview: false });
    expect(after).toMatchObject({ status: "in_progress", priority: "high", estimate: 5, needsReview: false });
    expect(after.startedAt).not.toBeNull();
    expect(after.labels.map((l) => l.name)).toEqual(["Operations"]);
    await expect(updateTask(n, task.id, { estimate: 4 as never })).rejects.toBeTruthy();
    const events = await t.handle.db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id));
    expect(events.map((e) => e.field).filter(Boolean)).toEqual(expect.arrayContaining(["status", "priority", "estimate", "labels", "needsReview"]));
    // Back to Todo clears started_at (a new In Progress stint later).
    expect((await updateTask(n, task.id, { status: "todo" })).startedAt).toBeNull();
  });

  it("the other founder's personal todo cannot be changed; old names (normal, waiting) are still understood", async () => {
    const mine = await createTask(t.ctx("nuraaly"), { title: "Secret", visibility: "private" });
    await expect(updateTask(t.ctx("talant"), mine.id, { status: "done" })).rejects.toMatchObject({ code: "not_found" });
    const legacy = await updateTask(t.ctx("nuraaly"), mine.id, { priority: "normal" as never, status: "waiting" as never });
    expect(legacy).toMatchObject({ priority: "medium", status: "in_review" });
  });

  it("bulk: the same change for several tasks, labels added / removed; a refused task is reported", async () => {
    const n = t.ctx("nuraaly");
    const photos = (await listLabels(n)).find((l) => l.name === "Photos")!;
    const a = await createTask(n, { title: "Bulk A", companyId: kiwi });
    const b = await createTask(n, { title: "Bulk B", companyId: kiwi });
    const secret = await createTask(t.ctx("talant"), { title: "Not mine", visibility: "private" });
    const r = await bulkUpdateTasks(n, [a.id, b.id, secret.id], { status: "backlog", priority: "low" }, { add: [photos.id] });
    expect(r.updated).toBe(2);
    expect(r.failed).toHaveLength(1);
    for (const id of [a.id, b.id]) expect(await getTask(n, id)).toMatchObject({ status: "backlog", priority: "low", labels: [expect.objectContaining({ name: "Photos" })] });
    await bulkUpdateTasks(n, [a.id], {}, { remove: [photos.id] });
    expect((await getTask(n, a.id)).labels).toEqual([]);
  });

  it("filters: statuses, priorities, labels, estimates, due, assignees, active view", async () => {
    const n = t.ctx("nuraaly");
    const auto = (await listLabels(n)).find((l) => l.name === "Automation")!;
    const x = await createTask(n, { title: "F backlog", companyId: kiwi, status: "backlog", priority: "urgent", estimate: 3 });
    const y = await createTask(n, { title: "F review", companyId: kiwi, status: "in_review", labelIds: [auto.id], dueDate: "2026-10-30" });
    const z = await createTask(n, { title: "F done", companyId: jobutify, status: "done", assigneeUserId: t.userIds.talant });
    const ids = async (f: Parameters<typeof listTasks>[1]) => (await listTasks(n, { ...f, search: "F " })).map((v) => v.id).sort();
    expect(await ids({ status: "active" })).toEqual([y.id]);
    expect(await ids({ status: "any", statuses: ["backlog", "done"] })).toEqual([x.id, z.id].sort());
    expect(await ids({ status: "any", priorities: ["urgent"] })).toEqual([x.id]);
    expect(await ids({ status: "any", labelIds: [auto.id] })).toEqual([y.id]);
    expect(await ids({ status: "any", estimates: [3] })).toEqual([x.id]);
    expect(await ids({ status: "any", estimates: [0] })).toEqual([y.id, z.id].sort());
    expect(await ids({ status: "any", due: ["overdue"] })).toEqual([y.id]);
    expect(await ids({ status: "any", assignees: [`user:${t.userIds.talant}`] })).toEqual([z.id]);
    expect(await ids({ status: "any", companyIds: [jobutify] })).toEqual([z.id]);
  });
});

describe("sub-tasks", () => {
  it("a sub-task is promoted to a full task linked to its parent (same company and assignee)", async () => {
    const n = t.ctx("nuraaly");
    const parent = await createTask(n, { title: "Parent", companyId: kiwi, assigneeUserId: t.userIds.talant, priority: "high" });
    const { item } = await addChecklistItem(n, parent.id, { title: "Child step", details: "Notes" }, { notify: false });
    const child = await promoteChecklistItem(n, item.id);
    expect(child).toMatchObject({ title: "Child step", notes: "Notes", parentTaskId: parent.id, priority: "high", company: expect.objectContaining({ id: kiwi }) });
    expect(child.assignee).toMatchObject({ kind: "user", id: t.userIds.talant });
    expect(await listChecklist(n, parent.id)).toEqual([]);
  });
});

describe("staff on Telegram: «Принято» and «Готово» with needs review", () => {
  it("«Принято» → In Progress; «Готово» → In Review with an Approve push to the founder; Approve → Done", async () => {
    await onTelegram(edil, EDIL_CHAT);
    const n = t.ctx("nuraaly", local(D, "08:40"));
    const task = await createTask(n, { title: "Отчёт", companyId: jobutify, assigneePersonId: edil });
    const pctx = personContext(t.handle.db, { id: edil, fullName: "Edil", shortName: "Edil" }, local(D, "09:00"));
    expect(await personAccept(pctx, task.id)).toEqual({ started: true });
    expect((await getTask(n, task.id)).status).toBe("in_progress");
    const done = await personMarkDone({ ...pctx, now: local(D, "11:00") }, task.id);
    expect(done).toMatchObject({ alreadyClosed: false, review: true });
    expect((await getTask(n, task.id)).status).toBe("in_review");
    const [push] = await t.handle.db
      .select()
      .from(notificationsOutbox)
      .where(and(eq(notificationsOutbox.userId, t.userIds.nuraaly), eq(notificationsOutbox.kind, "staff_update")));
    expect(push!.status).toBe("pending");
    const message = (push!.payload as { message: { actions: { action: string; taskId: string }[] } }).message;
    expect(message.actions).toEqual([expect.objectContaining({ action: "done", taskId: task.id })]);
    // Pressing it again: already waiting for review.
    expect(await personMarkDone({ ...pctx, now: local(D, "11:05") }, task.id)).toMatchObject({ alreadyClosed: true, review: true });
    // The founder approves (the push's button).
    await applyTaskAction(t.ctx("nuraaly", local(D, "12:00")), "done", task.id);
    expect((await getTask(n, task.id)).status).toBe("done");
  });

  it("without needs review «Готово» closes the task", async () => {
    await onTelegram(edil, EDIL_CHAT);
    const n = t.ctx("nuraaly", local(D, "08:40"));
    const task = await createTask(n, { title: "Без проверки", companyId: jobutify, assigneePersonId: edil, needsReview: false });
    const pctx = personContext(t.handle.db, { id: edil, fullName: "Edil", shortName: "Edil" }, local(D, "09:00"));
    expect(await personMarkDone(pctx, task.id)).toMatchObject({ review: false });
    expect((await getTask(n, task.id)).status).toBe("done");
  });
});

describe("estimate overrun", () => {
  it("flags a task in progress longer than its estimate (working hours, Mon–Sat) and nudges the person ONCE + one founders' line", async () => {
    await onTelegram(edil, EDIL_CHAT);
    const n = t.ctx("nuraaly", local(D, "09:00"));
    const task = await createTask(n, { title: "Сверка", companyId: jobutify, assigneePersonId: edil, estimate: 2, status: "in_progress" });
    // 10:30 (default window 09:00–20:00): 1.5 working hours of 2 → not over.
    expect((await getTask(t.ctx("nuraaly", local(D, "10:30")), task.id)).overEstimate).toBe(false);
    expect(await planOverEstimates(t.handle.db, local(D, "10:30"), "Asia/Bishkek")).toEqual({ flagged: 0, nudged: 0 });
    // 11:30: 2.5 h → over estimate.
    const later = t.ctx("nuraaly", local(D, "11:30"));
    expect((await getTask(later, task.id)).overEstimate).toBe(true);
    expect((await listTasks(later, { status: "any", overEstimate: true })).map((x) => x.id)).toEqual([task.id]);
    expect(await planOverEstimates(t.handle.db, local(D, "11:30"), "Asia/Bishkek")).toEqual({ flagged: 1, nudged: 1 });
    // Only once.
    expect(await planOverEstimates(t.handle.db, local(D, "13:00"), "Asia/Bishkek")).toEqual({ flagged: 0, nudged: 0 });
    const rows = await t.handle.db.select().from(notificationsOutbox).where(eq(notificationsOutbox.taskId, task.id));
    const nudge = rows.filter((r) => r.personId === edil && r.kind === "staff_info");
    expect(nudge).toHaveLength(1);
    expect((nudge[0]!.payload as { text: string }).text).toContain("дольше оценки");
    const lines = rows.filter((r) => r.userId === t.userIds.nuraaly && r.kind === "staff_update");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.status).toBe("parked");
    expect((lines[0]!.payload as { summaryLine: string }).summaryLine).toMatch(/^Over estimate: [A-Z0-9]+-\d+ Сверка — ▲ 2/);
  });

  it("chasing paused: no nudge to the person, the founders still get their line", async () => {
    await onTelegram(edil, EDIL_CHAT);
    const n = t.ctx("nuraaly", local(D, "09:00"));
    const task = await createTask(n, { title: "Пауза", companyId: jobutify, assigneePersonId: edil, estimate: 1, status: "in_progress" });
    await setTaskChase(n, task.id, { chase: "off" });
    expect(await planOverEstimates(t.handle.db, local(D, "12:00"), "Asia/Bishkek")).toEqual({ flagged: 1, nudged: 0 });
  });

  it("Sunday and the hours outside the window do not count", async () => {
    const n = t.ctx("nuraaly", local("2026-11-07", "19:00")); // Saturday 19:00
    const task = await createTask(n, { title: "Weekend", companyId: kiwi, estimate: 3, status: "in_progress" });
    // Sat 19–20 (1 h) + Sunday (0) + Mon 09–10:30 (1.5 h) = 2.5 h < 3.
    expect((await getTask(t.ctx("nuraaly", local("2026-11-09", "10:30")), task.id)).overEstimate).toBe(false);
    expect((await getTask(t.ctx("nuraaly", local("2026-11-09", "11:30")), task.id)).overEstimate).toBe(true);
  });
});

describe("MCP / assistant tools", () => {
  const env = () => ({ ctx: t.ctx("nuraaly"), baseUrl: "https://app.test" });
  const tool = (name: string) => findTool(name, "mcp")!;

  it("create_task with status, priority, estimate and labels; update_task by key; list_tasks by label; the preview shows them", async () => {
    const created = (await runNow(tool("create_task"), env(), {
      company: "Kiwi Go",
      title: "Shoot product photos",
      status: "backlog",
      priority: "high",
      estimate: 5,
      labels: ["photos", "Production"],
    })) as { data: { id: string; key: string; status: string; priority: string; estimate: number; labels: string[] } };
    expect(created.data).toMatchObject({ status: "backlog", priority: "high", estimate: 5, labels: ["Production", "Photos"] });
    const t2 = tool("update_task");
    if (t2.kind !== "write") throw new Error("write tool expected");
    const { preview } = await t2.prepare(env(), { id: created.data.key, status: "in_progress", estimate: 8, labels: ["Operations"] } as never);
    expect(preview.fields.map((f) => f.label)).toEqual(["Task", "Status", "Estimate", "Labels"]);
    expect(preview.fields.find((f) => f.label === "Status")!.value).toBe("Backlog → In Progress");
    const updated = (await runNow(t2, env(), { id: created.data.key, status: "in_progress", estimate: 8, labels: ["Operations"] })) as { data: { status: string; estimate: number; labels: string[] } };
    expect(updated.data).toMatchObject({ status: "in_progress", estimate: 8, labels: ["Operations"] });
    const listed = (await runNow(tool("list_tasks"), env(), { label: "Operations", status: "active" })) as { data: { key: string }[] };
    expect(listed.data.map((x) => x.key)).toEqual([created.data.key]);
    await expect(runNow(tool("create_task"), env(), { company: "Kiwi Go", title: "x", labels: ["No such label"] })).rejects.toMatchObject({ code: "validation" });
    await expect(runNow(tool("create_task"), env(), { title: "No company" })).rejects.toMatchObject({ code: "validation" });
    // complete_task by key approves a task in review.
    await updateTask(t.ctx("nuraaly"), created.data.id, { status: "in_review" });
    const done = (await runNow(tool("complete_task"), env(), { id: created.data.key })) as { data: { status: string } };
    expect(done.data.status).toBe("done");
  });
});
