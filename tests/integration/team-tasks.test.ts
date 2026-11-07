/**
 * Team view of tasks (founders only): tasks grouped by founder / person with counts (open,
 * overdue, due today, waiting, done in the last 7 days), Telegram status per header, filters,
 * the Unassigned group, privacy of personal todos, and the person page's Tasks section.
 * Today is 2026-11-02 in Bishkek (FIXED_NOW).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { people, tasks, telegramLinks } from "@/server/db/schema";
import { createTask } from "@/server/services/tasks";
import { getPersonTasks, getTeamTasks, type TeamBoard } from "@/server/services/team-tasks";
import { createTestDb, FIXED_NOW, type TestDb } from "../helpers/db";

let t: TestDb;
const id: Record<string, string> = {};
const DAY = 24 * 60 * 60 * 1000;

const group = (b: TeamBoard, key: string) => b.groups.find((g) => g.key === key);
const titles = (b: TeamBoard, key: string) => group(b, key)?.tasks.map((x) => x.title) ?? [];
const allTitles = (b: TeamBoard) => b.groups.flatMap((g) => g.tasks.map((x) => x.title));

beforeAll(async () => {
  t = await createTestDb();
  const n = t.ctx("nuraaly");
  const tal = t.ctx("talant");
  const kiwi = t.companyIds["kiwi-go"]!;
  const job = t.companyIds["jobutify"]!;
  const mk = async (key: string, ctx: typeof n, input: Parameters<typeof createTask>[1]) => {
    id[key] = (await createTask(ctx, input)).id;
  };
  await mk("n1", n, { title: "N secret todo", visibility: "private", dueDate: "2026-10-30" });
  await mk("n2", n, { title: "N secret self", visibility: "private", assigneeUserId: t.userIds.nuraaly });
  await mk("n3", n, { title: "Elmurat overdue akt", visibility: "shared", companyId: kiwi, assigneePersonId: t.personIds.elmurat, dueDate: "2026-11-01" });
  await mk("n4", n, { title: "Elmurat waiting", visibility: "shared", companyId: kiwi, assigneePersonId: t.personIds.elmurat, dueDate: "2026-11-02", status: "waiting" });
  await mk("n5", n, { title: "Edil later", visibility: "shared", companyId: job, assigneePersonId: t.personIds.edil, dueDate: "2026-11-10" });
  await mk("n6", n, { title: "Nobody has it", visibility: "shared", companyId: kiwi });
  await mk("n7", n, { title: "Elmurat done recent", visibility: "shared", companyId: job, assigneePersonId: t.personIds.elmurat });
  await mk("n8", n, { title: "Elmurat done old", visibility: "shared", companyId: kiwi, assigneePersonId: t.personIds.elmurat });
  await mk("n9", n, { title: "Talant job", visibility: "shared", companyId: kiwi, assigneeUserId: t.userIds.talant, dueDate: "2026-11-02" });
  await mk("t1", tal, { title: "T secret", visibility: "private" });
  const db = t.handle.db;
  await db.update(tasks).set({ status: "done", completedAt: new Date(FIXED_NOW.getTime() - DAY) }).where(eq(tasks.id, id.n7!));
  await db.update(tasks).set({ status: "done", completedAt: new Date(FIXED_NOW.getTime() - 10 * DAY) }).where(eq(tasks.id, id.n8!));

  // Telegram: Elmurat linked + switched on; Edil linked, switched on, paused; Nuraaly linked her own chat.
  await db.insert(telegramLinks).values([
    { personId: t.personIds.elmurat, chatId: "100", telegramUserId: "100" },
    { personId: t.personIds.edil, chatId: "101", telegramUserId: "101" },
    { userId: t.userIds.nuraaly, chatId: "102", telegramUserId: "102" },
  ]);
  await db.update(people).set({ botEnabled: true }).where(eq(people.id, t.personIds.elmurat!));
  await db.update(people).set({ botEnabled: true, botPausedUntil: new Date(FIXED_NOW.getTime() + 2 * DAY) }).where(eq(people.id, t.personIds.edil!));
});
afterAll(async () => {
  await t.handle.close();
});

describe("team view: grouping and counts", () => {
  it("groups by founder / person / unassigned in a stable order with the right counts", async () => {
    const b = await getTeamTasks(t.ctx("talant"));
    expect(b.groups.map((g) => g.key)).toEqual([
      `user:${t.userIds.talant}`,
      `user:${t.userIds.nuraaly}`,
      `person:${t.personIds.edil}`,
      `person:${t.personIds.elmurat}`,
      "unassigned",
    ]);
    const elmurat = group(b, `person:${t.personIds.elmurat}`)!;
    expect(elmurat.counts).toEqual({ open: 2, overdue: 1, dueToday: 1, waiting: 1, doneRecent: 1 });
    expect(elmurat.tasks.map((x) => x.title)).toEqual(["Elmurat overdue akt", "Elmurat waiting"]);
    expect(elmurat.personId).toBe(t.personIds.elmurat);
    expect(elmurat.name).toBe("Elmurat");

    const talant = group(b, `user:${t.userIds.talant}`)!;
    expect(talant.counts).toMatchObject({ open: 2, dueToday: 1, overdue: 0 });
    expect(titles(b, `user:${t.userIds.talant}`).sort()).toEqual(["T secret", "Talant job"]);
    // A founder's group links to their people record.
    expect(talant.personId).toBe(t.personIds.talant);
  });

  it("shows the Telegram status of each header", async () => {
    const b = await getTeamTasks(t.ctx("talant"));
    expect(group(b, `person:${t.personIds.elmurat}`)!.telegram).toBe("on");
    expect(group(b, `person:${t.personIds.edil}`)!.telegram).toBe("paused");
    expect(group(b, `user:${t.userIds.nuraaly}`)!.telegram).toBe("on");
    expect(group(b, `user:${t.userIds.talant}`)!.telegram).toBe("not_linked");
    expect(group(b, "unassigned")!.telegram).toBeNull();
  });

  it("is founders only", async () => {
    const staff = { ...t.ctx("talant"), user: { ...t.founders.talant, role: "staff" as const } };
    await expect(getTeamTasks(staff)).rejects.toMatchObject({ code: "forbidden" });
    await expect(getPersonTasks(staff, t.personIds.elmurat!)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("team view: privacy", () => {
  it("Talant never sees Nuraaly's personal todos, in any group", async () => {
    for (const filters of [{}, { status: "any" as const }, { assignee: `user:${t.userIds.nuraaly}` }, { overdueOnly: true }]) {
      const b = await getTeamTasks(t.ctx("talant"), filters);
      expect(allTitles(b).filter((x) => x.startsWith("N secret"))).toEqual([]);
      const nur = group(b, `user:${t.userIds.nuraaly}`);
      if (nur) expect(nur.counts.open).toBe(0);
    }
  });

  it("Nuraaly sees her own personal todos, only in her own group (not Unassigned)", async () => {
    const b = await getTeamTasks(t.ctx("nuraaly"));
    expect(b.groups[0]!.key).toBe(`user:${t.userIds.nuraaly}`);
    expect(titles(b, `user:${t.userIds.nuraaly}`).sort()).toEqual(["N secret self", "N secret todo"]);
    expect(group(b, `user:${t.userIds.nuraaly}`)!.counts.overdue).toBe(1);
    expect(titles(b, "unassigned")).toEqual(["Nobody has it"]);
    expect(allTitles(b)).not.toContain("T secret");
  });
});

describe("team view: filters and the Unassigned group", () => {
  it("Unassigned holds shared tasks without an assignee only", async () => {
    const b = await getTeamTasks(t.ctx("talant"), { assignee: "unassigned" });
    expect(b.groups.map((g) => g.key)).toEqual(["unassigned"]);
    expect(titles(b, "unassigned")).toEqual(["Nobody has it"]);
    expect(group(b, "unassigned")!.counts.open).toBe(1);
  });

  it("company filter", async () => {
    const b = await getTeamTasks(t.ctx("talant"), { companyId: t.companyIds["jobutify"] });
    expect(titles(b, `person:${t.personIds.edil}`)).toEqual(["Edil later"]);
    expect(group(b, `person:${t.personIds.elmurat}`)!.counts).toMatchObject({ open: 0, doneRecent: 1 });
    expect(group(b, "unassigned")).toBeUndefined();
    expect(titles(b, `user:${t.userIds.talant}`)).toEqual([]);
  });

  it("person filter shows only that group", async () => {
    const b = await getTeamTasks(t.ctx("talant"), { assignee: `person:${t.personIds.elmurat}` });
    expect(b.groups.map((g) => g.key)).toEqual([`person:${t.personIds.elmurat}`]);
    const f = await getTeamTasks(t.ctx("talant"), { assignee: `user:${t.userIds.talant}` });
    expect(f.groups.map((g) => g.key)).toEqual([`user:${t.userIds.talant}`]);
  });

  it("status filter and overdue only; counts stay the same", async () => {
    const waiting = await getTeamTasks(t.ctx("talant"), { status: "waiting" });
    expect(titles(waiting, `person:${t.personIds.elmurat}`)).toEqual(["Elmurat waiting"]);
    expect(group(waiting, `person:${t.personIds.elmurat}`)!.counts.open).toBe(2);

    const overdue = await getTeamTasks(t.ctx("talant"), { overdueOnly: "1" });
    expect(titles(overdue, `person:${t.personIds.elmurat}`)).toEqual(["Elmurat overdue akt"]);
    expect(titles(overdue, `user:${t.userIds.talant}`)).toEqual([]);

    const done = await getTeamTasks(t.ctx("talant"), { status: "done" });
    expect(titles(done, `person:${t.personIds.elmurat}`).sort()).toEqual(["Elmurat done old", "Elmurat done recent"]);

    const any = await getTeamTasks(t.ctx("talant"), { status: "any" });
    expect(titles(any, `person:${t.personIds.elmurat}`)).toHaveLength(4);
  });

  it("refuses malformed filters", async () => {
    await expect(getTeamTasks(t.ctx("talant"), { assignee: "user:nope" })).rejects.toThrow();
    await expect(getTeamTasks(t.ctx("talant"), { status: "bogus" as never })).rejects.toThrow();
  });
});

describe("person page: Tasks section", () => {
  it("lists a person's overdue, open and recently done tasks with a preset for Assign a task", async () => {
    const p = await getPersonTasks(t.ctx("talant"), t.personIds.elmurat!);
    expect(p.overdue.map((x) => x.title)).toEqual(["Elmurat overdue akt"]);
    expect(p.open.map((x) => x.title)).toEqual(["Elmurat waiting"]);
    expect(p.doneRecent.map((x) => x.title)).toEqual(["Elmurat done recent"]);
    expect(p.assignee).toBe(`person:${t.personIds.elmurat}`);
    expect(p.companyId).toBeTruthy();
    expect(Object.values(t.companyIds)).toContain(p.companyId);
    expect(p.group.telegram).toBe("on");
  });

  it("a founder's page shows their tasks; the other founder's personal todos stay hidden", async () => {
    const asTalant = await getPersonTasks(t.ctx("talant"), t.personIds.nuraaly!);
    expect(asTalant.assignee).toBe(`user:${t.userIds.nuraaly}`);
    expect([...asTalant.open, ...asTalant.overdue].map((x) => x.title)).toEqual([]);
    const asNuraaly = await getPersonTasks(t.ctx("nuraaly"), t.personIds.nuraaly!);
    expect([...asNuraaly.open, ...asNuraaly.overdue].map((x) => x.title).sort()).toEqual(["N secret self", "N secret todo"]);
    const talantOwn = await getPersonTasks(t.ctx("nuraaly"), t.personIds.talant!);
    expect(talantOwn.open.map((x) => x.title)).toEqual(["Talant job"]);
  });

  it("unknown or malformed person is not found", async () => {
    await expect(getPersonTasks(t.ctx("talant"), "nope")).rejects.toMatchObject({ code: "not_found" });
    await expect(getPersonTasks(t.ctx("talant"), "00000000-0000-0000-0000-000000000001")).rejects.toMatchObject({ code: "not_found" });
  });
});
