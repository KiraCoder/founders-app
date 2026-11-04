import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { SessionUser } from "@/server/auth/types";
import {
  aiRoleHires,
  aiRoleTemplates,
  clientProjects,
  companies,
  intercompanyFlows,
  metricDefinitions,
  orgCharts,
  people,
  personCompanies,
  projects,
  tasks,
} from "@/server/db/schema";
import {
  activeCompaniesWhere,
  archiveCompany,
  createCompany,
  deleteCompany,
  getCompanyBySlug,
  inActiveCompany,
  listCompanies,
  listCompaniesForSettings,
  moveCompany,
  reorderCompanies,
  restoreCompany,
  slugifyCompanyName,
  updateCompany,
} from "@/server/services/companies";
import type { ServiceContext } from "@/server/services/context";
import { toServiceError } from "@/server/services/errors";
import { getTaskFormOptions } from "@/server/services/options";
import { listCompanyUnitOptions } from "@/server/services/people";
import { search } from "@/server/services/search";
import { createTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.handle.close();
});

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => toServiceError(e)?.code ?? `unexpected: ${String(e)}`,
  );
const fields = (p: Promise<unknown>) =>
  p.then(
    () => ({}),
    (e: unknown) => toServiceError(e)?.fields ?? {},
  );
const n = () => t.ctx("nuraaly");

const staff: SessionUser = {
  id: "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a",
  email: "staff@example.test",
  name: "Staff",
  shortName: "Staff",
  role: "staff",
};
const staffCtx = (): ServiceContext => ({ ...n(), user: staff });

describe("slugs", () => {
  it("makes latin slugs from latin and Cyrillic names", () => {
    expect(slugifyCompanyName("Kiwi Go!")).toBe("kiwi-go");
    expect(slugifyCompanyName("  Alura   Style  ")).toBe("alura-style");
    expect(slugifyCompanyName("Алура Стайл")).toBe("alura-stayl");
    expect(slugifyCompanyName("Өнүгүү")).toBe("onuguu");
    expect(slugifyCompanyName("Café Crème")).toBe("cafe-creme");
    expect(slugifyCompanyName("!!!")).toBe("company");
    expect(slugifyCompanyName("x".repeat(100)).length).toBeLessThanOrEqual(48);
  });

  it("auto slugs are made unique; an explicit taken slug is a conflict on the slug field", async () => {
    const a = await createCompany(n(), { name: "Twin Co" });
    const b = await createCompany(n(), { name: "Twin Co" });
    const c = await createCompany(n(), { name: "Twin  co", slug: "" });
    expect([a.slug, b.slug, c.slug]).toEqual(["twin-co", "twin-co-2", "twin-co-3"]);
    expect(await code(createCompany(n(), { name: "Other", slug: "twin-co" }))).toBe("conflict");
    expect(await fields(createCompany(n(), { name: "Other", slug: "kiwi-go" }))).toHaveProperty("slug");
    // Archived companies keep their slug reserved.
    await archiveCompany(n(), b.id);
    expect(await code(createCompany(n(), { name: "Other", slug: "twin-co-2" }))).toBe("conflict");
    expect(await code(updateCompany(n(), c.id, { slug: "twin-co" }))).toBe("conflict");
    // Saving the same slug again is fine.
    expect(await code(updateCompany(n(), c.id, { slug: c.slug, name: "Twin Three" }))).toBe("ok");
  });
});

describe("validation", () => {
  it("rejects bad names, slugs, kinds, colors and unknown fields", async () => {
    expect(await fields(createCompany(n(), { name: "  " }))).toHaveProperty("name");
    expect(await fields(createCompany(n(), { name: "x".repeat(81) }))).toHaveProperty("name");
    expect(await fields(createCompany(n(), { name: "Ok", slug: "Bad Slug" }))).toHaveProperty("slug");
    expect(await fields(createCompany(n(), { name: "Ok", slug: "a--b" }))).toHaveProperty("slug");
    expect(await fields(createCompany(n(), { name: "Ok", slug: "-ab" }))).toHaveProperty("slug");
    expect(await fields(createCompany(n(), { name: "Ok", kind: "bakery" as never }))).toHaveProperty("kind");
    expect(await fields(createCompany(n(), { name: "Ok", color: "red" }))).toHaveProperty("color");
    expect(await code(createCompany(n(), { name: "Ok", archivedAt: new Date() } as never))).toBe("validation");
    expect(await code(updateCompany(n(), "not-a-uuid", { name: "x" }))).toBe("not_found");
    expect(await code(updateCompany(n(), t.companyIds["kiwi-go"]!, { kind: "nope" as never }))).toBe("validation");
  });

  it("stores defaults, trims text, uppercases colors and nulls empty optional fields", async () => {
    const c = await createCompany(n(), { name: " Defaults Ltd ", legalName: "  ", description: "", color: "#abcdef" });
    expect(c).toMatchObject({ name: "Defaults Ltd", slug: "defaults-ltd", kind: "generic", color: "#ABCDEF", legalName: null, description: null });
    const d = await createCompany(n(), { name: "Bare" });
    expect(d.color).toBe("#1E6B49");
  });

  it("renames, changes kind and color, and keeps other fields", async () => {
    const c = await createCompany(n(), { name: "Rename Me", legalName: "ОсОО Rename", kind: "factory" });
    const u = await updateCompany(n(), c.id, { name: "Renamed", kind: "courier", color: "#112233" });
    expect(u).toMatchObject({ name: "Renamed", slug: "rename-me", kind: "courier", color: "#112233", legalName: "ОсОО Rename" });
    const cleared = await updateCompany(n(), c.id, { legalName: "" });
    expect(cleared.legalName).toBeNull();
  });
});

describe("founders only", () => {
  it("staff cannot list for settings, create, update, archive, restore, reorder or delete", async () => {
    const s = staffCtx();
    const id = t.companyIds["kiwi-go"]!;
    expect(await code(listCompaniesForSettings(s))).toBe("forbidden");
    expect(await code(createCompany(s, { name: "Nope" }))).toBe("forbidden");
    expect(await code(updateCompany(s, id, { name: "Nope" }))).toBe("forbidden");
    expect(await code(archiveCompany(s, id))).toBe("forbidden");
    expect(await code(restoreCompany(s, id))).toBe("forbidden");
    expect(await code(moveCompany(s, id, "up"))).toBe("forbidden");
    expect(await code(reorderCompanies(s, [id]))).toBe("forbidden");
    expect(await code(deleteCompany(s, id))).toBe("forbidden");
    const [row] = await t.handle.db.select().from(companies).where(eq(companies.id, id));
    expect(row?.name).not.toBe("Nope");
  });
});

describe("reorder", () => {
  const sorts = async () => (await listCompanies(n())).map((c) => c.sort);

  it("new companies go to the end; move up/down swaps neighbours and renumbers", async () => {
    const before = await listCompanies(n());
    const c = await createCompany(n(), { name: "Last One" });
    let list = await listCompanies(n());
    expect(list.at(-1)?.id).toBe(c.id);
    expect(list).toHaveLength(before.length + 1);

    list = await moveCompany(n(), c.id, "up");
    expect(list.at(-2)?.id).toBe(c.id);
    // Integrity: unique, strictly increasing sorts; same set of companies.
    const s = await sorts();
    expect(new Set(s).size).toBe(s.length);
    expect([...s].sort((a, b) => a - b)).toEqual(s);
    expect(new Set(list.map((x) => x.id))).toEqual(new Set([...before.map((x) => x.id), c.id]));

    // Moving past the ends is a no-op.
    const first = list[0]!.id;
    list = await moveCompany(n(), first, "up");
    expect(list[0]!.id).toBe(first);
    list = await moveCompany(n(), list.at(-1)!.id, "down");
    expect(list.at(-1)!.id).not.toBe(c.id);
  });

  it("reorder takes a full permutation of active companies and rejects anything else", async () => {
    const list = await listCompanies(n());
    const ids = list.map((c) => c.id);
    const reversed = [...ids].reverse();
    const after = await reorderCompanies(n(), reversed);
    expect(after.map((c) => c.id)).toEqual(reversed);
    expect(after.map((c) => c.sort)).toEqual(reversed.map((_, i) => (i + 1) * 10));

    expect(await code(reorderCompanies(n(), reversed.slice(1)))).toBe("conflict");
    expect(await code(reorderCompanies(n(), [...reversed, reversed[0]!]))).toBe("conflict");
    expect(await code(reorderCompanies(n(), [...reversed.slice(1), "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f"]))).toBe("conflict");
    expect(await code(reorderCompanies(n(), ["nope"]))).toBe("validation");
    // Archived companies cannot be part of the order.
    const arch = (await listCompaniesForSettings(n())).find((c) => c.archivedAt)!;
    expect(await code(reorderCompanies(n(), [...reversed, arch.id]))).toBe("conflict");
    expect(await code(moveCompany(n(), arch.id, "up"))).toBe("validation");
    // Unchanged after the rejected attempts.
    expect((await listCompanies(n())).map((c) => c.id)).toEqual(reversed);
    await reorderCompanies(n(), ids);
  });
});

describe("archive and restore", () => {
  it("archived companies are hidden from lists, pickers, search and company pages, and come back on restore", async () => {
    const c = await createCompany(n(), { name: "Hidden Zebra", legalName: "ОсОО Zebra" });
    const archived = await archiveCompany(n(), c.id);
    expect(archived.archivedAt).toEqual(t.ctx("nuraaly").now);
    // Idempotent.
    expect((await archiveCompany(n(), c.id)).archivedAt).toEqual(archived.archivedAt);

    expect((await listCompanies(n())).some((x) => x.id === c.id)).toBe(false);
    expect((await getTaskFormOptions(n())).companies.some((x) => x.id === c.id)).toBe(false);
    expect((await listCompanyUnitOptions(n())).some((x) => x.id === c.id)).toBe(false);
    expect((await search(n(), "Zebra")).companies).toEqual([]);
    expect(await code(getCompanyBySlug(n(), c.slug))).toBe("not_found");
    // Still listed (as archived) in settings.
    const managed = (await listCompaniesForSettings(n())).find((x) => x.id === c.id);
    expect(managed?.archivedAt).not.toBeNull();

    const restored = await restoreCompany(n(), c.id);
    expect(restored.archivedAt).toBeNull();
    const list = await listCompanies(n());
    expect(list.at(-1)?.id).toBe(c.id);
    expect((await getCompanyBySlug(n(), c.slug)).name).toBe("Hidden Zebra");
  });

  it("exported helpers filter archived companies", async () => {
    const c = await createCompany(n(), { name: "Helper Check" });
    const p = await t.handle.db.insert(projects).values({ companyId: c.id, name: "Helper project" }).returning();
    const visible = () =>
      t.handle.db.select({ id: projects.id }).from(projects).where(inActiveCompany(n(), projects.companyId));
    expect((await visible()).some((r) => r.id === p[0]!.id)).toBe(true);
    await archiveCompany(n(), c.id);
    expect((await visible()).some((r) => r.id === p[0]!.id)).toBe(false);
    expect((await t.handle.db.select().from(companies).where(activeCompaniesWhere())).some((r) => r.id === c.id)).toBe(false);
  });
});

describe("hard delete", () => {
  it("deletes an unused company (active or archived)", async () => {
    const a = await createCompany(n(), { name: "Delete Active" });
    const b = await createCompany(n(), { name: "Delete Archived" });
    await archiveCompany(n(), b.id);
    const managed = await listCompaniesForSettings(n());
    expect(managed.find((c) => c.id === a.id)?.canDelete).toBe(true);
    await deleteCompany(n(), a.id);
    await deleteCompany(n(), b.id);
    const rows = await t.handle.db.select({ id: companies.id }).from(companies);
    expect(rows.some((r) => r.id === a.id || r.id === b.id)).toBe(false);
    expect(await code(deleteCompany(n(), a.id))).toBe("not_found");
  });

  it("refuses with 'archive instead' when the company has tasks, people, numbers, projects, org chart, flows or client projects", async () => {
    const db = t.handle.db;
    const owner = t.founders.nuraaly.id;
    const other = t.companyIds["kiwi-go"]!;
    const [person] = await db.insert(people).values({ fullName: "Link Person" }).returning();
    const cases: [string, (companyId: string) => Promise<unknown>, keyof Awaited<ReturnType<typeof listCompaniesForSettings>>[number]["usage"]][] = [
      ["tasks", (id) => db.insert(tasks).values({ title: "T", companyId: id, ownerUserId: owner }), "tasks"],
      ["people", (id) => db.insert(personCompanies).values({ personId: person!.id, companyId: id, role: "Worker" }), "peopleLinks"],
      [
        "numbers",
        (id) => db.insert(metricDefinitions).values({ companyId: id, key: "revenue", name: "Revenue", unit: "KGS", granularity: "month" }),
        "metricDefinitions",
      ],
      ["projects", (id) => db.insert(projects).values({ companyId: id, name: "P" }), "projects"],
      ["org chart", (id) => db.insert(orgCharts).values({ companyId: id, templateKey: "kiwi-go-seed" }), "orgChart"],
      ["flows (from)", (id) => db.insert(intercompanyFlows).values({ fromCompanyId: id, toCompanyId: other, service: "svc-a" }), "holdingFlows"],
      ["flows (to)", (id) => db.insert(intercompanyFlows).values({ fromCompanyId: other, toCompanyId: id, service: "svc-b" }), "holdingFlows"],
      ["client projects", (id) => db.insert(clientProjects).values({ companyId: id, clientName: "Client", title: "Build" }), "clientProjects"],
    ];
    for (const [label, add, key] of cases) {
      const c = await createCompany(n(), { name: `Used by ${label}` });
      await add(c.id);
      const managed = (await listCompaniesForSettings(n())).find((x) => x.id === c.id)!;
      expect(managed.usage[key], label).toBeGreaterThan(0);
      expect(managed.canDelete, label).toBe(false);
      const err = await deleteCompany(n(), c.id).then(
        () => null,
        (e: unknown) => toServiceError(e),
      );
      expect(err?.code, label).toBe("conflict");
      expect(err?.message, label).toMatch(/Archive it instead/);
      const [still] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, c.id));
      expect(still, label).toBeTruthy();
      // Archiving is always possible.
      expect(await code(archiveCompany(n(), c.id)), label).toBe("ok");
    }
  });

  it("any other reference the database protects also ends in 'archive instead'", async () => {
    const db = t.handle.db;
    const [template] = await db.select({ key: aiRoleTemplates.key }).from(aiRoleTemplates).limit(1);
    if (!template) return; // no AI templates seeded in this build
    const c = await createCompany(n(), { name: "Has AI Role" });
    await db.insert(aiRoleHires).values({ templateKey: template.key, companyId: c.id, settings: {} as never, hiredOn: "2026-11-01" });
    const err = await deleteCompany(n(), c.id).then(
      () => null,
      (e: unknown) => toServiceError(e),
    );
    expect(err?.code).toBe("conflict");
    expect(err?.message).toMatch(/Archive it instead/);
  });
});
