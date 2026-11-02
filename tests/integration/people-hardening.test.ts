import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { salaryAccessLog, salaryViewers, users } from "@/server/db/schema";
import { isSalaryViewer } from "@/server/services/access";
import { toServiceError } from "@/server/services/errors";
import {
  companyHeadcount,
  createPerson,
  getPerson,
  listPeople,
  markPersonLeft,
  updatePerson,
  updatePersonLink,
} from "@/server/services/people";
import { addSalary, currentSalaries, setSalaryViewer } from "@/server/services/salaries";
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

describe("salary viewers: concurrent mutual revoke", () => {
  it("two viewers revoking each other at once leave exactly one viewer; one audit row", async () => {
    const n = t.ctx("nuraaly");
    const tl = t.ctx("talant");
    await setSalaryViewer(n, t.userIds.talant, true);
    const results = await Promise.all([
      code(setSalaryViewer(n, t.userIds.talant, false)),
      code(setSalaryViewer(tl, t.userIds.nuraaly, false)),
    ]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r !== "ok")).toHaveLength(1);
    expect(await t.handle.db.select().from(salaryViewers)).toHaveLength(1);
    const revokes = (await t.handle.db.select().from(salaryAccessLog)).filter((l) => l.action === "revoke_viewer");
    expect(revokes).toHaveLength(1);
    // Restore the default (Nuraaly only) for the other tests.
    const [left] = await t.handle.db.select().from(salaryViewers);
    if (left!.userId !== t.userIds.nuraaly) {
      await setSalaryViewer(tl, t.userIds.nuraaly, true);
      await setSalaryViewer(n, t.userIds.talant, false);
    }
    expect(await isSalaryViewer(n)).toBe(true);
    expect(await isSalaryViewer(tl)).toBe(false);
  });

  it("a salary viewer whose account is no longer a founder gets nothing (checked in the database)", async () => {
    const n = t.ctx("nuraaly");
    await t.handle.db.update(users).set({ role: "staff" }).where(eq(users.id, t.userIds.nuraaly));
    try {
      // The session still says "founder" (stale); the database decides.
      expect(await isSalaryViewer(n)).toBe(false);
      expect(await code(currentSalaries(n, []))).toBe("forbidden");
    } finally {
      await t.handle.db.update(users).set({ role: "founder" }).where(eq(users.id, t.userIds.nuraaly));
    }
    expect(await isSalaryViewer(n)).toBe(true);
    expect(await isSalaryViewer({ ...n, user: { ...n.user, role: "staff" } })).toBe(false);
  });
});

describe("salary rows written in the same instant", () => {
  it("same link, same date, same created_at: the row written last is current", async () => {
    const n = t.ctx("nuraaly");
    const p = await createPerson(n, { fullName: "Одновременная Зарплата", links: [{ companyId: t.companyIds["kiwi-go"]!, role: "Курьер" }] });
    const link = p.roles[0]!.id;
    for (const amount of [100, 300, 200]) await addSalary(n, link, { amount, effectiveFrom: "2026-10-01" });
    expect((await currentSalaries(n, [link])).get(link)!.amount).toBe(200);
  });
});

describe("headcount ignores founders by account, not by role text", () => {
  it("a person whose role is literally “founder” but who has no account is counted", async () => {
    const n = t.ctx("nuraaly");
    const company = t.companyIds["jobutify"]!;
    const before = (await companyHeadcount(n, company)).total;
    await createPerson(n, { fullName: "Внешний Сооснователь", links: [{ companyId: company, role: "founder" }] });
    expect((await companyHeadcount(n, company)).total).toBe(before + 1);
    // The two founders (people with user accounts) are linked to every company and never counted.
    const all = await listPeople(n, { companyId: company });
    const founders = all.filter((p) => p.isUser);
    expect(founders).toHaveLength(2);
    expect((await companyHeadcount(n, company)).total).toBe(all.length - 2);
  });
});

describe("mark as left: date and undo", () => {
  it("honours the leaving date; undo brings back exactly the links it ended", async () => {
    const n = t.ctx("nuraaly");
    const p = await createPerson(n, {
      fullName: "Уходящий Сотрудник",
      links: [
        { companyId: t.companyIds["kiwi-go"]!, role: "Курьер" },
        { companyId: t.companyIds["jobutify"]!, role: "Оператор" },
      ],
    });
    const [kiwi, job] = p.roles;
    // Jobutify ended by hand earlier.
    await updatePersonLink(n, job!.id, { isActive: false, endedOn: "2026-09-30" });

    const left = await markPersonLeft(n, p.id, "2026-10-15");
    expect(left.leftAt).toBe("2026-10-14T18:00:00.000Z"); // 15 Oct 00:00 in Bishkek
    expect(left.roles.find((r) => r.id === kiwi!.id)).toMatchObject({ isActive: false, endedOn: "2026-10-15" });
    expect(left.roles.find((r) => r.id === job!.id)).toMatchObject({ isActive: false, endedOn: "2026-09-30" });

    const back = await updatePerson(n, p.id, { status: "active" });
    expect(back.leftAt).toBeNull();
    expect(back.roles.find((r) => r.id === kiwi!.id)).toMatchObject({ isActive: true, endedOn: null });
    // Ended by hand: stays ended.
    expect(back.roles.find((r) => r.id === job!.id)).toMatchObject({ isActive: false, endedOn: "2026-09-30" });
    expect((await listPeople(n, { companyId: t.companyIds["kiwi-go"] })).some((x) => x.id === p.id)).toBe(true);
  });

  it("today keeps the exact time; a future date is refused", async () => {
    const n = t.ctx("nuraaly");
    const p = await createPerson(n, { fullName: "Сегодняшний Уход", links: [{ companyId: t.companyIds["kiwi-go"]!, role: "Курьер" }] });
    expect(await code(markPersonLeft(n, p.id, "2026-11-03"))).toBe("validation");
    expect((await getPerson(n, p.id)).leftAt).toBeNull();
    const left = await markPersonLeft(n, p.id);
    expect(left.leftAt).toBe(n.now.toISOString());
    expect(left.roles[0]!.endedOn).toBe("2026-11-02");
  });
});

describe("search: ё and е are the same letter", () => {
  it("finds Алёна by Алена and Семен by Семён (people, roles, global search)", async () => {
    const n = t.ctx("nuraaly");
    await createPerson(n, { fullName: "Алёна Ёлкина", links: [{ companyId: t.companyIds["kiwi-go"]!, role: "Тестировщица" }] });
    await createPerson(n, { fullName: "Семен Петров", links: [{ companyId: t.companyIds["kiwi-go"]!, role: "Счётчик" }] });
    expect((await listPeople(n, { q: "Алена" })).map((p) => p.fullName)).toEqual(["Алёна Ёлкина"]);
    expect((await listPeople(n, { q: "Елкина" })).map((p) => p.fullName)).toEqual(["Алёна Ёлкина"]);
    expect((await listPeople(n, { q: "Семён" })).map((p) => p.fullName)).toEqual(["Семен Петров"]);
    expect((await listPeople(n, { q: "счетчик" })).map((p) => p.fullName)).toEqual(["Семен Петров"]);
    expect((await search(n, "алена")).people.map((p) => p.fullName)).toEqual(["Алёна Ёлкина"]);
  });
});
