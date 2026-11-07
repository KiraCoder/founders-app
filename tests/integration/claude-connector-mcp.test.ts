import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import { people, personCompanies, projects, taskComments, tasks } from "@/server/db/schema";
import { handleMcpRequest } from "@/server/http/mcp";
import { createTask, getTask, listTasks } from "@/server/services/tasks";
import { createTestDb, FIXED_NOW, type TestDb } from "../helpers/db";
import { BASE, connect, ENV } from "../helpers/oauth";

let t: TestDb;
let nuraaly: string;
let talant: string;
const ids: Record<string, string> = {};

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

async function rpc(access: string | null, method: string, params: unknown = {}, id = 1) {
  const res = await handleMcpRequest(
    new Request(`${BASE}/api/mcp`, {
      method: "POST",
      headers: {
        ...(access ? { authorization: `Bearer ${access}` } : {}),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
    { db: t.handle.db, now: () => FIXED_NOW, timeZone: "Asia/Bishkek", env: ENV },
  );
  return res;
}

async function call(access: string, name: string, args: Record<string, unknown> = {}): Promise<ToolResult & { text: string; data: ReturnType<typeof JSON.parse> }> {
  const res = await rpc(access, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: ToolResult; error?: unknown };
  if (!body.result) throw new Error(`rpc error: ${JSON.stringify(body.error)}`);
  const text = body.result.content.map((c) => c.text).join("\n");
  const jsonStart = text.indexOf("\n\n");
  let data: unknown = null;
  if (!body.result.isError && jsonStart >= 0) data = JSON.parse(text.slice(jsonStart + 2));
  return { ...body.result, text, data };
}

async function addPerson(name: string, companySlug: string, role = "manager") {
  const [p] = await t.handle.db.insert(people).values({ fullName: name }).returning();
  await t.handle.db.insert(personCompanies).values({ personId: p!.id, companyId: t.companyIds[companySlug]!, role });
  ids[name] = p!.id;
  return p!.id;
}

beforeAll(async () => {
  t = await createTestDb();
  await addPerson("Aibek Asanov", "kiwi-go", "courier lead");
  await addPerson("Aibek Tolonov", "kiwi-go", "dispatcher");
  await addPerson("Gulnara Sadykova", "kiwi-go", "operations");
  await addPerson("Bakyt Jobutov", "jobutify");
  nuraaly = (await connect(t.handle.db, t.founders.nuraaly, FIXED_NOW)).access;
  talant = (await connect(t.handle.db, t.founders.talant, FIXED_NOW)).access;
});
afterAll(async () => {
  await t.handle.close();
});

describe("MCP protocol over /api/mcp", () => {
  it("initialize and tools/list (stateless, JSON responses)", async () => {
    const init = await rpc(nuraaly, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } });
    expect(init.status).toBe(200);
    expect(init.headers.get("mcp-session-id")).toBeNull();
    const body = await init.json();
    expect(body.result.serverInfo.name).toBe("founder-cockpit");
    expect(body.result.capabilities.tools).toBeTruthy();
    expect(body.result.instructions).toContain("create_project");

    const list = await (await rpc(nuraaly, "tools/list", {}, 2)).json();
    const names = list.result.tools.map((x: { name: string }) => x.name).sort();
    expect(names).toEqual(
      ["add_task_comment", "add_tasks", "complete_task", "create_project", "get_project", "list_companies", "list_people", "list_projects", "list_tasks", "update_task"].sort(),
    );
    const cp = list.result.tools.find((x: { name: string }) => x.name === "create_project");
    expect(cp.description).toMatch(/ambiguous/);
    expect(cp.inputSchema.required).toEqual(expect.arrayContaining(["company", "name"]));
    expect(cp.inputSchema.properties.tasks.items.properties.assignee.description).toMatch(/founder/);
  });

  it("auth required on every method; GET is 405 once authenticated", async () => {
    expect((await rpc(null, "tools/list")).status).toBe(401);
    const get = await handleMcpRequest(new Request(`${BASE}/api/mcp`, { headers: { authorization: `Bearer ${nuraaly}` } }), { db: t.handle.db, now: () => FIXED_NOW, env: ENV });
    expect(get.status).toBe(405);
    const anonGet = await handleMcpRequest(new Request(`${BASE}/api/mcp`), { db: t.handle.db, env: ENV });
    expect(anonGet.status).toBe(401);
  });
});

describe("read tools", () => {
  it("list_companies / list_people / list_projects", async () => {
    const companies = await call(nuraaly, "list_companies");
    expect(companies.data.map((c: { slug: string }) => c.slug)).toContain("kiwi-go");
    const ppl = await call(nuraaly, "list_people", { company: "kiwi go" });
    expect(ppl.data.company).toBe("Kiwi Go");
    expect(ppl.data.founders.map((f: { name: string }) => f.name).sort()).toEqual(["Nuraaly", "Talant"]);
    const names = ppl.data.people.map((p: { name: string }) => p.name);
    expect(names).toEqual(expect.arrayContaining(["Aibek Asanov", "Aibek Tolonov", "Elmurat"]));
    expect(names).not.toContain("Bakyt Jobutov");
    expect(JSON.stringify(ppl.data)).not.toMatch(/salary/i);
    const amb = await call(nuraaly, "list_people", { company: "Alura" });
    expect(amb.isError).toBe(true);
    expect(amb.text).toContain("Alura Brand");
    expect(amb.text).toContain("Alura Style");
    const none = await call(nuraaly, "list_projects", { company: "Nope Inc" });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/No company called “Nope Inc”.*Kiwi Go/);
  });
});

describe("create_project", () => {
  it("creates the project and its tasks in one go, resolving names (founders, people, me) and returning links", async () => {
    const res = await call(nuraaly, "create_project", {
      company: "Kiwi Go",
      name: "Osh launch",
      description: "Open the Osh in-city delivery",
      due_date: "2026-12-15",
      tasks: [
        { title: "Hire 5 couriers", assignee: "Aibek Asanov", due_date: "2026-11-20", priority: "high" },
        { title: "Price list for shops", assignee: "Talant", notes: "COD fee included" },
        { title: "Call the bank about COD", assignee: "me", due_date: "2026-11-10" },
        { title: "Book the warehouse", assignee: "gulnara" },
        { title: "Think about branding" },
      ],
    });
    expect(res.isError).toBeFalsy();
    expect(res.text).toMatch(/^Created project “Osh launch” in Kiwi Go with 5 tasks: https:\/\/cockpit\.test\/projects\//);
    const project = res.data.project;
    expect(project).toMatchObject({ name: "Osh launch", company: "Kiwi Go", due_date: "2026-12-15", tasks_total: 5, url: `${BASE}/projects/${project.id}` });
    const byTitle = Object.fromEntries(res.data.tasks.map((x: { title: string }) => [x.title, x]));
    expect(byTitle["Hire 5 couriers"]).toMatchObject({ assignee: "Aibek Asanov", priority: "high", due_date: "2026-11-20", private: false, company: "Kiwi Go" });
    expect(byTitle["Price list for shops"]).toMatchObject({ assignee: "Talant (founder)", notes: "COD fee included" });
    expect(byTitle["Call the bank about COD"].assignee).toBe("Nuraaly (founder)");
    expect(byTitle["Book the warehouse"].assignee).toBe("Gulnara Sadykova");
    expect(byTitle["Think about branding"].assignee).toBeNull();

    // Stored as normal shared company tasks owned by the authorizing founder (the chase planner picks them up).
    const rows = await t.handle.db.select().from(tasks).where(eq(tasks.projectId, project.id));
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.ownerUserId === t.founders.nuraaly.id && r.visibility === "shared" && r.companyId === t.companyIds["kiwi-go"])).toBe(true);
    expect(rows.find((r) => r.title === "Hire 5 couriers")!.assigneePersonId).toBe(ids["Aibek Asanov"]);
    // Talant sees the shared tasks in the app.
    const seen = await listTasks(t.ctx("talant"), { projectId: project.id, status: "any" });
    expect(seen).toHaveLength(5);
  });

  it("ambiguous or unknown assignee → nothing saved, the error lists the candidates", async () => {
    const before = (await t.handle.db.select().from(projects)).length;
    const res = await call(nuraaly, "create_project", {
      company: "kiwi-go",
      name: "Should not exist",
      tasks: [
        { title: "Ok task", assignee: "Talant" },
        { title: "Route plan", assignee: "Aibek" },
        { title: "Website", assignee: "Bakyt" },
      ],
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Nothing was saved.");
    expect(res.text).toMatch(/Task 2 “Route plan”: “Aibek” matches several assignees at Kiwi Go: “Aibek Asanov, courier lead”, “Aibek Tolonov, dispatcher”/);
    // Bakyt works at Jobutify only: company isolation, not offered for Kiwi Go.
    expect(res.text).toMatch(/Task 3 “Website”: No assignee called “Bakyt” at Kiwi Go\. Options: .*Elmurat/);
    expect(res.text).not.toContain("Bakyt Jobutov");
    expect((await t.handle.db.select().from(projects)).length).toBe(before);
    expect(await t.handle.db.select().from(tasks).where(eq(tasks.title, "Ok task"))).toHaveLength(0);
  });

  it("ambiguous company → candidates; a service refusal mid-way rolls back the whole plan", async () => {
    const amb = await call(nuraaly, "create_project", { company: "alura", name: "X" });
    expect(amb.isError).toBe(true);
    expect(amb.text).toMatch(/“alura” matches several companies: “Alura Brand”, “Alura Style”/);
    expect(amb.text).toContain("Alura Brand");

    const before = (await t.handle.db.select().from(projects)).length;
    // The second task is a private todo assigned to Talant: refused by the resolver before anything is written.
    const priv = await call(nuraaly, "create_project", {
      company: "Kiwi Go",
      name: "Rollback test",
      tasks: [{ title: "fine" }, { title: "private for Talant", assignee: "Talant", private: true }],
    });
    expect(priv.isError).toBe(true);
    expect(priv.text).toMatch(/private todo can only be assigned to you/);
    // A bad date passes the resolver but the service refuses it inside the transaction → rollback.
    const bad = await call(nuraaly, "create_project", {
      company: "Kiwi Go",
      name: "Rollback test",
      start_date: "2026-12-10",
      due_date: "2026-12-01",
      tasks: [{ title: "fine" }],
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Due date is before start date/);
    const badTask = await call(nuraaly, "create_project", { company: "Kiwi Go", name: "Rollback test 2", tasks: [{ title: "fine" }, { title: "bad date", due_date: "2026-02-31" }] });
    expect(badTask.isError).toBe(true);
    expect((await t.handle.db.select().from(projects)).length).toBe(before);
    expect(await t.handle.db.select().from(tasks).where(eq(tasks.title, "fine"))).toHaveLength(0);
  });

  it("private todos in a plan stay private to the authorizing founder", async () => {
    const res = await call(talant, "create_project", { company: "Jobutify", name: "Talant's plan", tasks: [{ title: "My secret todo", private: true }, { title: "Shared one", assignee: "Bakyt" }] });
    expect(res.isError).toBeFalsy();
    const secret = res.data.tasks.find((x: { title: string }) => x.title === "My secret todo");
    expect(secret.private).toBe(true);
    await expect(getTask(t.ctx("nuraaly"), secret.id)).rejects.toMatchObject({ code: "not_found" });
    // Through the connector too: Nuraaly's token cannot see or touch it.
    const listed = await call(nuraaly, "get_project", { project: "Talant's plan" });
    expect(listed.data.tasks.map((x: { title: string }) => x.title)).toEqual(["Shared one"]);
    const touch = await call(nuraaly, "complete_task", { id: secret.id });
    expect(touch.isError).toBe(true);
    expect(touch.text).toBe("Task not found");
    const comment = await call(nuraaly, "add_task_comment", { id: secret.id, text: "peek" });
    expect(comment.isError).toBe(true);
    const tl = await call(nuraaly, "list_tasks", { company: "Jobutify", status: "any" });
    expect(tl.data.map((x: { title: string }) => x.title)).not.toContain("My secret todo");
  });
});

describe("task tools", () => {
  it("add_tasks, list_tasks filters, update_task, complete_task, add_task_comment", async () => {
    const added = await call(nuraaly, "add_tasks", { project: "osh launch", tasks: [{ title: "Insurance for bikes", assignee: "Aibek Tolonov", due_date: "2026-10-30" }] });
    expect(added.isError).toBeFalsy();
    expect(added.text).toMatch(/^Added 1 task to “Osh launch” \(Kiwi Go\)/);
    const id = added.data[0].id as string;

    const overdue = await call(nuraaly, "list_tasks", { overdue: true, company: "Kiwi Go" });
    expect(overdue.data.map((x: { title: string }) => x.title)).toContain("Insurance for bikes");
    expect(overdue.data.every((x: { overdue: boolean }) => x.overdue)).toBe(true);
    const aibek = await call(nuraaly, "list_tasks", { assignee: "Aibek Asanov" });
    expect(aibek.data.map((x: { title: string }) => x.title)).toEqual(["Hire 5 couriers"]);
    const mine = await call(nuraaly, "list_tasks", { assignee: "me", project: "Osh launch" });
    expect(mine.data.map((x: { title: string }) => x.title)).toEqual(["Call the bank about COD"]);
    const limited = await call(nuraaly, "list_tasks", { project: "Osh launch", limit: 2 });
    expect(limited.data).toHaveLength(2);
    expect(limited.text).toMatch(/showing 2/);

    const upd = await call(nuraaly, "update_task", { id, due_date: "2026-11-25", assignee: "Gulnara", priority: "urgent", notes: "two quotes" });
    expect(upd.data).toMatchObject({ due_date: "2026-11-25", assignee: "Gulnara Sadykova", priority: "urgent", notes: "two quotes", overdue: false });
    const unassign = await call(nuraaly, "update_task", { id, assignee: null, notes: null });
    expect(unassign.data).toMatchObject({ assignee: null, notes: null });
    const wrongCo = await call(nuraaly, "update_task", { id, assignee: "Bakyt" });
    expect(wrongCo.isError).toBe(true);
    const nothing = await call(nuraaly, "update_task", { id });
    expect(nothing.isError).toBe(true);

    const done = await call(nuraaly, "complete_task", { id });
    expect(done.data.status).toBe("done");
    const c = await call(talant, "add_task_comment", { id, text: "Paid the insurance" });
    expect(c.isError).toBeFalsy();
    const [row] = await t.handle.db.select().from(taskComments).where(eq(taskComments.taskId, id));
    expect(row).toMatchObject({ text: "Paid the insurance", authorUserId: t.founders.talant.id });

    const proj = await call(talant, "get_project", { project: "Osh launch", company: "Kiwi Go" });
    expect(proj.data.tasks_total).toBe(6);
    expect(proj.data.tasks_done).toBe(1);
    expect(proj.data.tasks).toHaveLength(6);

    const badId = await call(nuraaly, "complete_task", { id: "not-a-uuid" });
    expect(badId.isError).toBe(true);
  });

  it("a founder's own private todo (no company) can only be assigned to them", async () => {
    const todo = await createTask(t.ctx("nuraaly"), { title: "Dentist", visibility: "private" });
    const toTalant = await call(nuraaly, "update_task", { id: todo.id, assignee: "Talant" });
    expect(toTalant.isError).toBe(true);
    expect(toTalant.text).toMatch(/personal todo/);
    const toPerson = await call(nuraaly, "update_task", { id: todo.id, assignee: "Elmurat" });
    expect(toPerson.isError).toBe(true);
    const toMe = await call(nuraaly, "update_task", { id: todo.id, assignee: "me" });
    expect(toMe.data.assignee).toBe("Nuraaly (founder)");
  });

  it("list_tasks filters the assignee in SQL: a task behind 500+ others is still found", async () => {
    const kiwi = t.companyIds["kiwi-go"]!;
    // 520 open tasks that sort first (earlier deadline), none of them Bakyt's.
    await t.handle.db.insert(tasks).values(
      Array.from({ length: 520 }, (_, i) => ({ title: `Filler ${i}`, companyId: kiwi, ownerUserId: t.founders.nuraaly.id, visibility: "shared" as const, dueDate: "2026-10-01" })),
    );
    const late = await createTask(t.ctx("nuraaly"), {
      title: "Gulnara far away",
      companyId: kiwi,
      assigneePersonId: ids["Gulnara Sadykova"],
      dueDate: "2027-06-01",
    });
    const res = await call(nuraaly, "list_tasks", { assignee: "Gulnara Sadykova", limit: 200 });
    expect(res.data.map((x: { id: string }) => x.id)).toContain(late.id);
    expect(res.data.every((x: { assignee: string }) => x.assignee === "Gulnara Sadykova")).toBe(true);
    // The service filter is exact: a founder filter never returns a person's task.
    const byUser = await listTasks(t.ctx("nuraaly"), { assigneeUserId: t.founders.nuraaly.id, status: "any", limit: 500 });
    expect(byUser.every((x) => x.assignee?.kind === "user" && x.assignee.id === t.founders.nuraaly.id)).toBe(true);
    const byPerson = await listTasks(t.ctx("nuraaly"), { assigneePersonId: ids["Gulnara Sadykova"], limit: 500 });
    expect(byPerson.map((x) => x.id)).toContain(late.id);
    const all = await call(nuraaly, "list_tasks", { company: "Kiwi Go", limit: 5 });
    expect(all.text).toMatch(/^500\+ tasks \(showing 5/);
    await t.handle.db.delete(tasks).where(like(tasks.title, "Filler %"));
  });
});
