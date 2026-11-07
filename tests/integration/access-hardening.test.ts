import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "@/server/auth/types";
import type { ServiceContext } from "@/server/services/context";
import { getCompanyBySlug, listCompanyCards } from "@/server/services/companies";
import { ServiceError } from "@/server/services/errors";
import { snoozeTaskReminder } from "@/server/services/notifications";
import { assignablePeopleByCompany, listPeople } from "@/server/services/people";
import { createProject, getProject, listProjects } from "@/server/services/projects";
import { createTask, deleteTask, getTask, listTaskEvents, listTasks, updateTask } from "@/server/services/tasks";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.handle.close();
});

async function code(p: Promise<unknown>) {
  return p.then(
    () => null,
    (e: unknown) => (e instanceof ServiceError ? e.code : e),
  );
}

describe("malformed ids are 'not found', never a database error", () => {
  it("tasks, events, projects, reminders", async () => {
    const n = t.ctx("nuraaly");
    for (const bad of ["", "nope", "123", "00000000-0000-0000-0000-00000000000Z", "'; drop table tasks; --"]) {
      expect(await code(getTask(n, bad)), bad).toBe("not_found");
      expect(await code(updateTask(n, bad, { title: "x" })), bad).toBe("not_found");
      expect(await code(deleteTask(n, bad)), bad).toBe("not_found");
      expect(await code(listTaskEvents(n, bad)), bad).toBe("not_found");
      expect(await code(getProject(n, bad)), bad).toBe("not_found");
      expect(await code(snoozeTaskReminder(n, bad)), bad).toBe("not_found");
    }
    // Well-formed but unknown ids are not_found as before.
    expect(await code(getProject(n, "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f"))).toBe("not_found");
  });
});

describe("people, assignees and project counts go through access.ts", () => {
  const staff: SessionUser = {
    id: "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a",
    email: "staff@example.test",
    name: "Staff",
    shortName: "Staff",
    role: "staff",
  };
  const staffCtx = (): ServiceContext => ({ ...t.ctx("nuraaly"), user: staff });

  it("founders see every person and the assignable people of each company", async () => {
    const all = await listPeople(t.ctx("talant"));
    expect(all.map((p) => p.fullName)).toEqual(expect.arrayContaining(["Edil", "Elmurat"]));
    const byCompany = await assignablePeopleByCompany(t.ctx("talant"));
    expect(byCompany[t.companyIds["jobutify"]!]?.map((p) => p.name)).toContain("Edil");
  });

  it("a non-founder without company membership sees no people, assignees, projects or shared tasks", async () => {
    await createProject(t.ctx("nuraaly"), { companyId: t.companyIds["kiwi-go"]!, name: "Visible to founders" });
    await createTask(t.ctx("nuraaly"), { title: "Shared for founders", companyId: t.companyIds["kiwi-go"] });
    const s = staffCtx();
    expect(await listPeople(s)).toEqual([]);
    expect(await listPeople(s, { companyId: t.companyIds["jobutify"] })).toEqual([]);
    expect(await assignablePeopleByCompany(s)).toEqual({});
    expect(await listCompanyCards(s)).toEqual([]);
    expect(await listProjects(s)).toEqual([]);
    expect(await listTasks(s, { status: "any" })).toEqual([]);
  });
});

describe("counts never include the other founder's private tasks", () => {
  it("company cards, company page, project progress and company task tab", async () => {
    const kiwi = t.companyIds["kiwi-go"]!;
    const project = await createProject(t.ctx("talant"), { companyId: kiwi, name: "Counting project" });
    await createTask(t.ctx("talant"), {
      title: "Shared done",
      companyId: kiwi,
      projectId: project.id,
      status: "done",
    });

    const snapshot = async (who: "nuraaly" | "talant") => {
      const ctx = t.ctx(who);
      const card = (await listCompanyCards(ctx)).find((c) => c.id === kiwi)!;
      const page = await getCompanyBySlug(ctx, "kiwi-go");
      const p = await getProject(ctx, project.id);
      const tab = await listTasks(ctx, { companyId: kiwi, status: "any" });
      return {
        open: card.openTasks,
        overdue: card.overdueTasks,
        pageOpen: page.openTasks,
        pageOverdue: page.overdueTasks,
        total: p.totalTasks,
        done: p.doneTasks,
        progress: p.progress,
        tab: tab.length,
      };
    };

    const talantBefore = await snapshot("talant");
    const nuraalyBefore = await snapshot("nuraaly");

    // Nuraaly's private, overdue todo inside Talant's project / Kiwi Go.
    await createTask(t.ctx("nuraaly"), {
      title: "Nuraaly private in project",
      visibility: "private",
      companyId: kiwi,
      projectId: project.id,
      dueDate: "2026-10-01",
    });

    expect(await snapshot("talant")).toEqual(talantBefore);
    const nuraalyAfter = await snapshot("nuraaly");
    expect(nuraalyAfter.open).toBe(nuraalyBefore.open + 1);
    expect(nuraalyAfter.overdue).toBe(nuraalyBefore.overdue + 1);
    expect(nuraalyAfter.pageOpen).toBe(nuraalyBefore.pageOpen + 1);
    expect(nuraalyAfter.total).toBe(nuraalyBefore.total + 1);
    expect(nuraalyAfter.tab).toBe(nuraalyBefore.tab + 1);
    expect(talantBefore.progress).toBe(100);
    expect(nuraalyAfter.progress).toBe(50);
  });
});
