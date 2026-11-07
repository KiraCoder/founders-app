import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { companies } from "@/server/db/schema";

/**
 * The cross-request cache (src/server/cache.ts) against an in-memory stand-in for Next's data
 * cache: an entry is kept until a write revalidates one of its tags. Each test shows the read is
 * cached (a change behind the services' back stays invisible), then that the service write drops
 * the tag and the next read is fresh.
 */
const next = vi.hoisted(() => {
  const store = new Map<string, { value: unknown; tags: string[] }>();
  const revalidated: string[] = [];
  return {
    store,
    revalidated,
    unstable_cache:
      (fn: (...a: unknown[]) => Promise<unknown>, keyParts: string[], opts: { tags: string[] }) =>
      async (...args: unknown[]) => {
        const key = JSON.stringify(keyParts);
        const hit = store.get(key);
        if (hit) return hit.value;
        const value = await fn(...args);
        store.set(key, { value, tags: opts.tags });
        return value;
      },
    revalidateTag: (tag: string) => {
      revalidated.push(tag);
      for (const [k, e] of store) if (e.tags.includes(tag)) store.delete(k);
    },
  };
});
vi.mock("next/cache", () => ({ unstable_cache: next.unstable_cache, revalidateTag: next.revalidateTag, revalidatePath: () => {} }));

const { createTestDb } = await import("../helpers/db");
const { archiveCompany, createCompany, listCompanies } = await import("@/server/services/companies");
const { assignablePeopleByCompany, createPerson } = await import("@/server/services/people");
const { getOrgChart, updateDepartment } = await import("@/server/services/org");
const { listMetricDefinitions } = await import("@/server/services/metrics");
const { listRoles } = await import("@/server/services/ai-roles");
const { createCustomRole, updateRoleConfig } = await import("@/server/services/ai-role-editor");
const { createTask } = await import("@/server/services/tasks");
const { createProject } = await import("@/server/services/projects");
const { getTaskFormOptions } = await import("@/server/services/options");
const { routineFormOptions } = await import("@/server/services/routines");
const { setPersonChase, updateStaffDefaults, getStaffDefaults } = await import("@/server/services/staff");

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.handle.close();
});
beforeEach(() => {
  next.store.clear();
  next.revalidated.length = 0;
});

const kiwi = () => t.companyIds["kiwi-go"]!;

describe("shared cache: write → tag invalidated → fresh read", () => {
  it("companies: a rename behind the services' back is not seen; createCompany drops `companies`", async () => {
    const before = await listCompanies(t.ctx("nuraaly"));
    expect(before[0]!.createdAt).toBeInstanceOf(Date); // dates survive the JSON round trip
    await t.handle.db.update(companies).set({ name: "Renamed in SQL" }).where(eq(companies.id, kiwi()));
    expect((await listCompanies(t.ctx("talant"))).find((c) => c.id === kiwi())!.name).toBe("Kiwi Go"); // cached, shared by both founders
    await createCompany(t.ctx("nuraaly"), { name: "Cache Test Co" });
    expect(next.revalidated).toContain("companies");
    const after = await listCompanies(t.ctx("talant"));
    expect(after.map((c) => c.name)).toContain("Cache Test Co");
    expect(after.find((c) => c.id === kiwi())!.name).toBe("Renamed in SQL");
    await t.handle.db.update(companies).set({ name: "Kiwi Go" }).where(eq(companies.id, kiwi()));
  });

  it("people pickers: createPerson drops `people`", async () => {
    const before = await assignablePeopleByCompany(t.ctx("nuraaly"));
    const created = await createPerson(t.ctx("nuraaly"), { fullName: "Кэш Тестов", links: [{ companyId: kiwi(), role: "Курьер" }] });
    expect(next.revalidated).toContain("people");
    const after = await assignablePeopleByCompany(t.ctx("talant"));
    expect(before[kiwi()]?.some((p) => p.id === created.id) ?? false).toBe(false);
    expect(after[kiwi()]!.some((p) => p.id === created.id)).toBe(true);
  });

  it("org chart: an edit drops `org:<chartId>`; task counts stay per founder (never in the shared entry)", async () => {
    const scope = { companyId: kiwi(), companyUnitId: null };
    const chart = (await getOrgChart(t.ctx("nuraaly"), scope))!;
    const dept = chart.divisions.flatMap((d) => d.departments)[0]!;
    // A personal todo of Nuraaly's on that department: counted for her only.
    await createTask(t.ctx("nuraaly"), { title: "Моя заметка", visibility: "private", companyId: kiwi(), orgDepartmentId: dept.id });
    const n = (await getOrgChart(t.ctx("nuraaly"), scope))!.divisions.flatMap((d) => d.departments).find((d) => d.id === dept.id)!;
    const tl = (await getOrgChart(t.ctx("talant"), scope))!.divisions.flatMap((d) => d.departments).find((d) => d.id === dept.id)!;
    expect(n.openTasks).toBe(tl.openTasks + 1);
    for (const e of next.store.values()) expect(JSON.stringify(e.value)).not.toContain("Моя заметка");

    await updateDepartment(t.ctx("talant"), dept.id, { name: "Отдел после кэша" });
    expect(next.revalidated).toContain(`org:${chart.id}`);
    const fresh = (await getOrgChart(t.ctx("nuraaly"), scope))!;
    expect(fresh.divisions.flatMap((d) => d.departments).find((d) => d.id === dept.id)!.name).toBe("Отдел после кэша");
    expect(fresh.version).not.toBe(chart.version);
  });

  it("metric definitions: archiving a company drops them (tag `companies`)", async () => {
    const company = await createCompany(t.ctx("nuraaly"), { name: "Archive Me" });
    expect((await listMetricDefinitions(t.ctx("nuraaly"))).length).toBeGreaterThan(0);
    const kiwiDefs = (await listMetricDefinitions(t.ctx("nuraaly"), kiwi())).length;
    next.revalidated.length = 0;
    await archiveCompany(t.ctx("nuraaly"), kiwi());
    expect(next.revalidated).toContain("companies");
    expect(kiwiDefs).toBeGreaterThan(0);
    expect((await listMetricDefinitions(t.ctx("talant"))).some((d) => d.companyId === kiwi())).toBe(false);
    await t.handle.db.update(companies).set({ archivedAt: null }).where(eq(companies.id, kiwi()));
    await archiveCompany(t.ctx("nuraaly"), company.id);
  });

  it("AI role configs: a role edit drops `ai-roles`", async () => {
    const role = await createCustomRole(t.ctx("nuraaly"), { companyId: kiwi(), config: { profile: { name: "Cache watcher" }, watchedMetricKeys: ["revenue"] } });
    const before = (await listRoles(t.ctx("nuraaly"))).find((r) => r.key === role.key)!;
    expect(before.name).toBe("Cache watcher");
    next.revalidated.length = 0;
    await updateRoleConfig(t.ctx("talant"), role.key, { profile: { name: "Cache watcher 2" }, watchedMetricKeys: ["revenue"] });
    expect(next.revalidated).toContain("ai-roles");
    expect((await listRoles(t.ctx("nuraaly"))).find((r) => r.key === role.key)!.name).toBe("Cache watcher 2");
  });

  it("task form projects: createProject drops `projects`", async () => {
    const before = await getTaskFormOptions(t.ctx("nuraaly"));
    const project = await createProject(t.ctx("nuraaly"), { companyId: kiwi(), name: "Cached project" });
    expect(next.revalidated).toContain("projects");
    expect(before.projects.some((p) => p.id === project.id)).toBe(false);
    expect((await getTaskFormOptions(t.ctx("talant"))).projects.find((p) => p.id === project.id)).toEqual({ id: project.id, name: "Cached project", companyId: kiwi() });
  });

  it("routine form options + people's chase settings: the bot's defaults drop `staff-settings`, a person's override drops `people`", async () => {
    const ctx = t.ctx("nuraaly");
    const elmurat = t.personIds.elmurat!;
    const defaults = await getStaffDefaults(ctx);
    const before = await routineFormOptions(ctx);
    await updateStaffDefaults(ctx, { ...defaults, chaseEveryMinutes: 95 });
    expect(next.revalidated).toContain("staff-settings");
    const after = await routineFormOptions(t.ctx("talant"));
    expect(after.defaults.chaseEveryMinutes).toBe(95);
    expect(after.defaults.chaseEveryMinutes).not.toBe(before.defaults.chaseEveryMinutes);
    expect((await getTaskFormOptions(ctx)).personChase?.[elmurat]?.chaseEveryMinutes).toBe(95);

    next.revalidated.length = 0;
    await setPersonChase(ctx, elmurat, { chaseEveryMinutes: 45 });
    expect(next.revalidated).toContain("people");
    expect((await routineFormOptions(ctx)).people.find((p) => p.id === elmurat)!.defaults.chaseEveryMinutes).toBe(45);
    expect((await getTaskFormOptions(ctx)).personChase?.[elmurat]?.chaseEveryMinutes).toBe(45);
    await setPersonChase(ctx, elmurat, {});
    await updateStaffDefaults(ctx, defaults);
  });

  it("staff never read or fill the shared cache", async () => {
    const staff = { ...t.ctx("nuraaly"), user: { ...t.founders.nuraaly, role: "staff" as const } };
    expect(await listCompanies(staff)).toEqual([]);
    expect(next.store.size).toBe(0);
  });
});
