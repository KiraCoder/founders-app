/**
 * The task form lets a founder pick ANY person who works for the task's company (not only
 * Elmurat / Edil): active links, people not marked as left; founders are picked as users.
 * Editing a task whose person left keeps that person as an option (no silent un-assign).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assigneePeopleOptions } from "@/lib/task-assignee";
import { people, personCompanies } from "@/server/db/schema";
import { getTaskFormOptions } from "@/server/services/options";
import { createTask } from "@/server/services/tasks";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
const ids: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestDb();
  for (const [key, fullName, active, left] of [
    ["courier", "Azamat Courier", true, false],
    ["oldLink", "Old Link", false, false],
    ["gone", "Gone Person", true, true],
  ] as const) {
    const [p] = await t.handle.db.insert(people).values({ fullName, leftAt: left ? new Date() : null }).returning({ id: people.id });
    ids[key] = p!.id;
    await t.handle.db.insert(personCompanies).values({ personId: p!.id, companyId: t.companyIds["kiwi-go"]!, role: "courier", isActive: active });
  }
});
afterAll(async () => {
  await t.handle.close();
});

describe("task assignee picker: every person of the company", () => {
  it("lists all active people of the company (any role), not people who left / ended links / founders", async () => {
    const o = await getTaskFormOptions(t.ctx("nuraaly"));
    const kiwi = o.peopleByCompany[t.companyIds["kiwi-go"]!]!.map((p) => p.id);
    expect(kiwi).toEqual(expect.arrayContaining([ids.courier, t.personIds.elmurat]));
    expect(kiwi).not.toContain(ids.oldLink);
    expect(kiwi).not.toContain(ids.gone);
    expect(kiwi).not.toContain(t.personIds.nuraaly);
    // Each company has its own list: Edil (Jobutify) is not offered for Kiwi Go.
    expect(kiwi).not.toContain(t.personIds.edil);
    expect(o.peopleByCompany[t.companyIds["jobutify"]!]!.map((p) => p.id)).toEqual(expect.arrayContaining([t.personIds.edil, t.personIds.elmurat]));
  });

  it("a listed person can be assigned; a person of another company is refused", async () => {
    const n = t.ctx("nuraaly");
    const task = await createTask(n, { title: "Courier shift plan", companyId: t.companyIds["kiwi-go"]!, visibility: "shared", assigneePersonId: ids.courier });
    expect(task.assignee).toMatchObject({ kind: "person", id: ids.courier });
    await expect(
      createTask(n, { title: "Wrong company", companyId: t.companyIds["kiwi-go"]!, visibility: "shared", assigneePersonId: t.personIds.edil }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("editing keeps a current assignee who is no longer listed (same company only)", () => {
    const list = [{ id: "a", name: "A" }];
    const current = { kind: "person" as const, id: "gone", name: "Gone" };
    expect(assigneePeopleOptions(list, current, { taskCompanyId: "c1", companyId: "c1" }).map((p) => p.id)).toEqual(["a", "gone"]);
    expect(assigneePeopleOptions(list, current, { taskCompanyId: "c1", companyId: "c2" }).map((p) => p.id)).toEqual(["a"]);
    expect(assigneePeopleOptions(list, { kind: "person", id: "a", name: "A" }, { taskCompanyId: "c1", companyId: "c1" })).toHaveLength(1);
    expect(assigneePeopleOptions(list, null, { taskCompanyId: null, companyId: "c1" })).toEqual(list);
  });
});
