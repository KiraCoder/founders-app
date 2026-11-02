import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { salaries, salaryAccessLog, salaryViewers } from "@/server/db/schema";
import { isSalaryViewer } from "@/server/services/access";
import { toServiceError } from "@/server/services/errors";
import {
  addPersonLink,
  addPersonSalary,
  companyHeadcount,
  createPerson,
  getPerson,
  listPeople,
  markPersonLeft,
  updatePerson,
  updatePersonLink,
  type PersonView,
} from "@/server/services/people";
import { addSalary, listSalaryAccessLog, listSalaryViewers, setSalaryViewer } from "@/server/services/salaries";
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

/** True when no role of any person carries a salary key (absent, not just null). */
function noSalaryKeys(list: PersonView[]): boolean {
  return list.every((p) => p.roles.every((r) => !("salary" in r) && !("salaryHistory" in r)));
}

async function makeSeamstress(name: string, amount = 32000) {
  const p = await createPerson(t.ctx("nuraaly"), {
    fullName: name,
    phone: "+996 555 100 200",
    links: [
      {
        companyId: t.companyIds["alura-style"]!,
        unitId: (await unitId("alura-style", "hbk"))!,
        role: "Швея",
        salary: { amount, payType: "piecework", effectiveFrom: "2026-01-01" },
      },
    ],
  });
  return p;
}

async function unitId(company: string, slug: string) {
  const { companyUnits } = await import("@/server/db/schema");
  const rows = await t.handle.db.select().from(companyUnits).where(eq(companyUnits.companyId, t.companyIds[company]!));
  return rows.find((u) => u.slug === slug)?.id;
}

describe("salary viewers", () => {
  it("default: only Nuraaly is a salary viewer", async () => {
    expect(await isSalaryViewer(t.ctx("nuraaly"))).toBe(true);
    expect(await isSalaryViewer(t.ctx("talant"))).toBe(false);
    const list = await listSalaryViewers(t.ctx("talant"));
    expect(list.filter((v) => v.isViewer).map((v) => v.shortName)).toEqual(["Nuraaly"]);
  });

  it("re-running the seed keeps the founders' choice", async () => {
    const { seed } = await import("@/server/db/seed");
    await seed(t.handle.db, { password: "test-password", bcryptRounds: 4 });
    const rows = await t.handle.db.select().from(salaryViewers);
    expect(rows.map((r) => r.userId)).toEqual([t.userIds.nuraaly]);
  });
});

describe("Talant (not a salary viewer) never sees salaries", () => {
  let personId: string;
  beforeAll(async () => {
    personId = (await makeSeamstress("Салаватова Тест", 87654)).id;
  });

  it("people list, company tab and person page carry no salary key", async () => {
    const tl = t.ctx("talant");
    expect(noSalaryKeys(await listPeople(tl, {}, { salaryScope: "people_list" }))).toBe(true);
    expect(noSalaryKeys(await listPeople(tl, { companyId: t.companyIds["alura-style"] }, { salaryScope: "company:alura-style" }))).toBe(true);
    const person = await getPerson(tl, personId, { salaryScope: "person" });
    expect(noSalaryKeys([person])).toBe(true);
    expect(JSON.stringify(person)).not.toContain("87654");
  });

  it("search finds the person but never by or with the salary", async () => {
    const tl = t.ctx("talant");
    const byName = await search(tl, "Салаватова");
    expect(byName.people.map((p) => p.fullName)).toEqual(["Салаватова Тест"]);
    expect(JSON.stringify(byName)).not.toContain("87654");
    expect((await search(tl, "87654")).people).toEqual([]);
    // Not for Nuraaly either: search never touches salaries.
    expect((await search(t.ctx("nuraaly"), "87654")).people).toEqual([]);
  });

  it("salary writes and reads are forbidden", async () => {
    const tl = t.ctx("talant");
    const person = await getPerson(tl, personId);
    const linkId = person.roles[0]!.id;
    expect(await code(addSalary(tl, linkId, { amount: 1 }))).toBe("forbidden");
    expect(await code(addPersonSalary(tl, linkId, { amount: 1 }))).toBe("forbidden");
    expect(
      await code(
        createPerson(tl, {
          fullName: "Нельзя Зарплата",
          links: [{ companyId: t.companyIds["kiwi-go"]!, role: "Курьер", salary: { amount: 100 } }],
        }),
      ),
    ).toBe("forbidden");
    // Nothing was written by the refused create.
    expect((await listPeople(tl, { q: "Нельзя Зарплата" })).length).toBe(0);
    expect(
      await code(addPersonLink(tl, personId, { companyId: t.companyIds["kiwi-go"]!, role: "Курьер", salary: { amount: 5 } })),
    ).toBe("forbidden");
    expect(await code(listSalaryAccessLog(tl))).toBe("forbidden");
    expect(await code(setSalaryViewer(tl, t.userIds.talant, true))).toBe("forbidden");
  });

  it("Nuraaly sees the current salary in the list and the history on the person page", async () => {
    const n = t.ctx("nuraaly");
    const list = await listPeople(n, { companyId: t.companyIds["alura-style"] }, { salaryScope: "company:alura-style" });
    const row = list.find((p) => p.id === personId)!;
    expect(row.roles[0]!.salary?.amount).toBe(87654);
    expect(row.roles[0]!.salary?.payType).toBe("piecework");
    expect(row.roles[0]!.salary?.currency).toBe("KGS");
    // Without asking for salaries (e.g. search, pickers) even a viewer gets none.
    expect(noSalaryKeys(await listPeople(n, { companyId: t.companyIds["alura-style"] }))).toBe(true);
  });
});

describe("salary history and current selection", () => {
  it("current = latest effective_from on or before today; future rows only in history", async () => {
    const n = t.ctx("nuraaly"); // today = 2026-11-02 (Asia/Bishkek)
    const p = await makeSeamstress("История Зарплаты", 30000);
    const linkId = p.roles[0]!.id;
    await addSalary(n, linkId, { amount: "35 000", effectiveFrom: "2026-06-01", payType: "monthly", note: "raise" });
    await addSalary(n, linkId, { amount: 40000, effectiveFrom: "2026-12-01", payType: "monthly" });
    let person = await getPerson(n, p.id, { salaryScope: "person" });
    expect(person.roles[0]!.salary?.amount).toBe(35000);
    expect(person.roles[0]!.salaryHistory?.map((s) => s.amount)).toEqual([40000, 35000, 30000]);

    // Two changes on the same day: the newest row wins.
    const later = t.ctx("nuraaly", new Date("2026-11-02T07:00:00Z"));
    await addSalary(later, linkId, { amount: 36000, effectiveFrom: "2026-06-01" });
    person = await getPerson(n, p.id, { salaryScope: "person" });
    expect(person.roles[0]!.salary?.amount).toBe(36000);
    expect(person.roles[0]!.salaryHistory).toHaveLength(4);

    // When the future date arrives, it becomes current.
    const dec = await getPerson(t.ctx("nuraaly", new Date("2026-12-01T06:00:00Z")), p.id, { salaryScope: "person" });
    expect(dec.roles[0]!.salary?.amount).toBe(40000);
  });

  it("invalid amounts are rejected", async () => {
    const n = t.ctx("nuraaly");
    const p = await makeSeamstress("Плохая Сумма");
    const linkId = p.roles[0]!.id;
    expect(await code(addSalary(n, linkId, { amount: -5 }))).toBe("validation");
    expect(await code(addSalary(n, linkId, { amount: "много" }))).toBe("validation");
    expect(await code(addSalary(n, linkId, { amount: 100, currency: "kgs1" }))).toBe("validation");
  });
});

describe("salary audit log", () => {
  it("every change is logged; a list view is ONE row, not one per person", async () => {
    const n = t.ctx("nuraaly");
    const db = t.handle.db;
    const before = (await db.select().from(salaryAccessLog)).length;
    const p = await makeSeamstress("Аудит Тест");
    const changes = await db.select().from(salaryAccessLog).where(eq(salaryAccessLog.personId, p.id));
    expect(changes.map((c) => c.action)).toEqual(["change"]);
    expect(changes[0]!.actorUserId).toBe(t.userIds.nuraaly);
    expect(changes[0]!.personCompanyId).toBe(p.roles[0]!.id);

    const mid = (await db.select().from(salaryAccessLog)).length;
    expect(mid).toBe(before + 1);
    const list = await listPeople(n, {}, { salaryScope: "people_list" });
    expect(list.length).toBeGreaterThan(3);
    const after = await db.select().from(salaryAccessLog).orderBy(desc(salaryAccessLog.createdAt));
    expect(after.length).toBe(mid + 1);
    expect(after.some((r) => r.action === "view" && r.scope === "people_list")).toBe(true);

    // Talant's views are not logged as salary views (he gets no salary data).
    await listPeople(t.ctx("talant"), {}, { salaryScope: "people_list" });
    expect((await db.select().from(salaryAccessLog)).length).toBe(after.length);
  });

  it("toggling a salary viewer works and is audited; the last viewer cannot be removed", async () => {
    const n = t.ctx("nuraaly");
    const tl = t.ctx("talant");
    await setSalaryViewer(n, t.userIds.talant, true);
    expect(await isSalaryViewer(tl)).toBe(true);
    const seen = await listPeople(tl, { companyId: t.companyIds["alura-style"] }, { salaryScope: "company:alura-style" });
    expect(seen.some((p) => p.roles.some((r) => typeof r.salary?.amount === "number"))).toBe(true);

    await setSalaryViewer(tl, t.userIds.talant, false);
    expect(await isSalaryViewer(tl)).toBe(false);
    expect(noSalaryKeys(await listPeople(tl, {}, { salaryScope: "people_list" }))).toBe(true);

    // Nuraaly is now the only viewer: he cannot remove himself.
    expect(await code(setSalaryViewer(n, t.userIds.nuraaly, false))).toBe("conflict");
    expect(await isSalaryViewer(n)).toBe(true);

    const log = await listSalaryAccessLog(n);
    const toggles = log.filter((l) => l.action === "grant_viewer" || l.action === "revoke_viewer");
    expect(toggles.map((l) => [l.action, l.actor, l.targetName])).toEqual([
      ["revoke_viewer", "Talant", "Talant"],
      ["grant_viewer", "Nuraaly", "Talant"],
    ]);
    // Granting twice does not add a second log row.
    await setSalaryViewer(n, t.userIds.nuraaly, true);
    expect((await listSalaryAccessLog(n)).filter((l) => l.action === "grant_viewer")).toHaveLength(1);
  });
});

describe("people CRUD, multi-company, mark as left", () => {
  it("a person can work for several companies with a role per company", async () => {
    const n = t.ctx("nuraaly");
    const elmurat = (await listPeople(n, { q: "Elmurat" }))[0]!;
    expect(elmurat.roles.map((r) => r.companyName)).toEqual(
      expect.arrayContaining(["Kiwi Go", "Jobutify", "Alura Brand", "Alura Style", "Asqa Zou Holding"]),
    );
    const kiwi = await listPeople(n, { companyId: t.companyIds["kiwi-go"] });
    const inKiwi = kiwi.find((p) => p.fullName === "Elmurat")!;
    expect(inKiwi.roles.map((r) => r.companyName)).toEqual(["Kiwi Go"]);

    const p = await createPerson(n, {
      fullName: "Мульти Компания",
      shortName: "Мульти",
      telegramHandle: "@multi_test",
      email: "multi@example.test",
      links: [
        { companyId: t.companyIds["kiwi-go"]!, role: "Диспетчер", employmentType: "part_time" },
        { companyId: t.companyIds["upsell-group"]!, role: "Менеджер", employmentType: "contractor" },
      ],
    });
    expect(p.telegramHandle).toBe("multi_test");
    expect(p.roles.map((r) => [r.companyName, r.role, r.employmentType])).toEqual([
      ["Kiwi Go", "Диспетчер", "part_time"],
      ["Upsell Group", "Менеджер", "contractor"],
    ]);
    expect(await code(addPersonLink(n, p.id, { companyId: t.companyIds["kiwi-go"]!, role: "Диспетчер" }))).toBe("conflict");
    // Unit must belong to the company.
    expect(
      await code(addPersonLink(n, p.id, { companyId: t.companyIds["kiwi-go"]!, role: "Склад", unitId: (await unitId("alura-style", "hbk"))! })),
    ).toBe("validation");
  });

  it("filters by unit and reports headcount by unit (founders not counted)", async () => {
    const n = t.ctx("nuraaly");
    const hbk = (await unitId("alura-style", "hbk"))!;
    const osh = (await unitId("alura-style", "osh-rayon"))!;
    await createPerson(n, { fullName: "Ош Швея", links: [{ companyId: t.companyIds["alura-style"]!, unitId: osh, role: "Швея" }] });
    const inHbk = await listPeople(n, { companyId: t.companyIds["alura-style"], unitId: hbk });
    expect(inHbk.length).toBeGreaterThan(0);
    expect(inHbk.every((p) => p.roles.every((r) => r.unitName === "ХБК"))).toBe(true);
    const hc = await companyHeadcount(n, t.companyIds["alura-style"]!);
    const byName = Object.fromEntries(hc.byUnit.map((u) => [u.unitName, u.count]));
    expect(byName["Ош Район"]).toBe(1);
    expect(byName["ХБК"]).toBe(inHbk.length);
    // Elmurat (accountant, no unit) counts; the two founders do not.
    expect(byName["No unit"]).toBe(1);
    expect(hc.total).toBe(inHbk.length + 2);
  });

  it("mark as left hides the person from active lists but keeps history", async () => {
    const n = t.ctx("nuraaly");
    const p = await makeSeamstress("Ушедшая Швея", 31000);
    await markPersonLeft(n, p.id, "2026-10-31");
    expect((await listPeople(n)).some((x) => x.id === p.id)).toBe(false);
    expect((await listPeople(n, { companyId: t.companyIds["alura-style"] })).some((x) => x.id === p.id)).toBe(false);
    const left = await listPeople(n, { status: "left" });
    expect(left.some((x) => x.id === p.id)).toBe(true);
    expect((await listPeople(n, { status: "left", companyId: t.companyIds["alura-style"] })).some((x) => x.id === p.id)).toBe(true);

    const after = await getPerson(n, p.id, { salaryScope: "person" });
    expect(after.leftAt).not.toBeNull();
    expect(after.roles[0]!.isActive).toBe(false);
    expect(after.roles[0]!.endedOn).toBe("2026-10-31");
    expect(after.roles[0]!.salaryHistory?.map((s) => s.amount)).toEqual([31000]);
    const rows = await t.handle.db.select().from(salaries).where(eq(salaries.personCompanyId, p.roles[0]!.id));
    expect(rows).toHaveLength(1);
    // Headcount ignores people who left.
    const hc = await companyHeadcount(n, t.companyIds["alura-style"]!);
    expect(hc.byUnit.find((u) => u.unitName === "ХБК")!.count).toBeGreaterThan(0);

    // Undo.
    await updatePerson(n, p.id, { status: "active" });
    expect((await listPeople(n, { status: "active" })).some((x) => x.id === p.id)).toBe(true);
  });

  it("ending one company link keeps the person active elsewhere", async () => {
    const n = t.ctx("nuraaly");
    const p = await createPerson(n, {
      fullName: "Две Работы",
      links: [
        { companyId: t.companyIds["kiwi-go"]!, role: "Курьер" },
        { companyId: t.companyIds["alura-brand"]!, role: "Модель" },
      ],
    });
    await updatePersonLink(n, p.roles[0]!.id, { isActive: false });
    expect((await listPeople(n, { companyId: t.companyIds["kiwi-go"] })).some((x) => x.id === p.id)).toBe(false);
    expect((await listPeople(n, { companyId: t.companyIds["alura-brand"] })).some((x) => x.id === p.id)).toBe(true);
    expect((await listPeople(n)).some((x) => x.id === p.id)).toBe(true);
    const again = await getPerson(n, p.id);
    expect(again.roles.find((r) => r.companyName === "Kiwi Go")?.endedOn).toBe("2026-11-02");
  });

  it("search by phone digits, role and Telegram; edits are validated", async () => {
    const n = t.ctx("nuraaly");
    expect((await listPeople(n, { q: "555100200" })).length).toBeGreaterThan(0);
    expect((await listPeople(n, { q: "Диспетчер" })).map((p) => p.fullName)).toContain("Мульти Компания");
    expect((await listPeople(n, { q: "@multi_test" })).map((p) => p.fullName)).toContain("Мульти Компания");
    const p = (await listPeople(n, { q: "Мульти Компания" }))[0]!;
    expect(await code(updatePerson(n, p.id, { email: "not-an-email" }))).toBe("validation");
    expect(await code(updatePerson(n, p.id, { fullName: "" }))).toBe("validation");
    expect(await code(getPerson(n, "nope"))).toBe("not_found");
    const edited = await updatePerson(n, p.id, { notes: "Works two shifts", phone: "0555 000 999" });
    expect(edited.notes).toBe("Works two shifts");
  });
});
