import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Db } from "@/server/db/connect";
import { parseTableFile } from "@/server/import/parse-table";
import { toServiceError } from "@/server/services/errors";
import { lockTransaction } from "@/server/services/locks";
import { applyMetricsImport, planMetricsImport } from "@/server/services/metrics-import";
import { applyImport, describeImportFile, planImport } from "@/server/services/people-import";
import { createPerson, getPerson, listPeople } from "@/server/services/people";
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
const csvTable = (lines: string[], name = "f.csv") => parseTableFile(new TextEncoder().encode(lines.join("\n")), name);

describe("same name, different phones (never merge two people)", () => {
  it("the first row claims the phoneless person, the second is a new person; re-import is a no-op", async () => {
    const n = t.ctx("nuraaly");
    const existing = await createPerson(n, { fullName: "Асель Клеймова", links: [{ companyId: t.companyIds["kiwi-go"]!, role: "Курьер" }] });
    const table = await csvTable([
      "ФИО,Компания,Должность,Телефон",
      "Асель Клеймова,Kiwi Go,Курьер,0555 111 111",
      "Асель Клеймова,Kiwi Go,Курьер,0777 222 222",
    ]);
    const mapping = { fullName: 0, company: 1, role: 2, phone: 3 };
    const plan = await planImport(n, table, mapping);
    expect(plan.rows.map((r) => r.action)).toEqual(["update", "create"]);
    expect(plan.rows[0]!.personId).toBe(existing.id);
    expect(plan.rows[0]!.changes).toContain("Fill phone");
    expect(plan.rows[1]!.changes.join(" ")).toMatch(/another phone/);

    await applyImport(n, table, mapping, { expectedSha256: table.sha256 });
    const found = await listPeople(n, { q: "Асель Клеймова" });
    expect(found).toHaveLength(2);
    expect(found.map((p) => p.phone).sort()).toEqual(["0555 111 111", "0777 222 222"]);
    expect((await getPerson(n, existing.id)).phone).toBe("0555 111 111"); // not overwritten by row 2

    const again = await planImport(n, table, mapping);
    expect(again.rows.map((r) => r.action)).toEqual(["skip", "skip"]);
    await applyImport(n, table, mapping, { expectedSha256: table.sha256 });
    expect(await listPeople(n, { q: "Асель Клеймова" })).toHaveLength(2);
  });

  it("a phone set after the preview is not overwritten by the confirm", async () => {
    const n = t.ctx("nuraaly");
    const p = await createPerson(n, { fullName: "Гуля Позже", links: [{ companyId: t.companyIds["kiwi-go"]!, role: "Курьер" }] });
    const table = await csvTable(["ФИО,Компания,Должность,Телефон", "Гуля Позже,Kiwi Go,Курьер,0555 333 333"]);
    // Someone sets the phone between preview and confirm.
    await t.handle.db.execute(sql`update people set phone = '0700 000 000' where id = ${p.id}`);
    await applyImport(n, table, { fullName: 0, company: 1, role: 2, phone: 3 }, { expectedSha256: table.sha256 });
    // The importer re-plans inside the transaction: the phone differs → a new person, and the
    // existing phone stays.
    expect((await getPerson(n, p.id)).phone).toBe("0700 000 000");
  });
});

describe("non-viewers cannot read a salary column through another field", () => {
  it("mapping the Оклад column to notes or role is forbidden for Talant (preview and confirm)", async () => {
    const tl = t.ctx("talant");
    const table = await parseTableFile(new Uint8Array(readFileSync(path.join(process.cwd(), "docs/samples/people-sample.csv"))), "s.csv");
    const info = await describeImportFile(tl, table);
    const salaryIdx = table.headers.indexOf("Оклад");
    expect(info.salaryHeaders).toContain(salaryIdx);
    expect(Object.values(info.mapping)).not.toContain(salaryIdx);
    for (const field of ["notes", "role", "phone"] as const) {
      expect(await code(planImport(tl, table, { ...info.mapping, [field]: salaryIdx }))).toBe("forbidden");
    }
    expect(await code(applyImport(tl, table, { ...info.mapping, notes: salaryIdx }, { expectedSha256: table.sha256 }))).toBe("forbidden");
    // Nuraaly (viewer) may map it anywhere.
    expect(await code(planImport(t.ctx("nuraaly"), table, { ...info.mapping, notes: salaryIdx }))).toBe("ok");
  });
});

describe("preview vs confirm: same file only", () => {
  it("people: confirm with another file (or no hash) is refused and writes nothing", async () => {
    const n = t.ctx("nuraaly");
    const previewed = await csvTable(["ФИО,Компания", "Хэш Первый,Kiwi Go"]);
    const other = await csvTable(["ФИО,Компания", "Хэш Второй,Kiwi Go"]);
    const plan = await planImport(n, previewed, { fullName: 0, company: 1 });
    expect(plan.fileSha256).toBe(previewed.sha256);
    expect(await code(applyImport(n, other, { fullName: 0, company: 1 }, { expectedSha256: plan.fileSha256 }))).toBe("conflict");
    expect(await code(applyImport(n, other, { fullName: 0, company: 1 }, { expectedSha256: "" }))).toBe("conflict");
    expect(await listPeople(n, { q: "Хэш" })).toHaveLength(0);
    await applyImport(n, previewed, { fullName: 0, company: 1 }, { expectedSha256: plan.fileSha256 });
    expect(await listPeople(n, { q: "Хэш" })).toHaveLength(1);
  });

  it("numbers: the same rule", async () => {
    const n = t.ctx("nuraaly");
    const company = t.companyIds["kiwi-go"]!;
    const previewed = await parseTableFile(new Uint8Array(readFileSync("docs/samples/kiwi-go-numbers-sample.csv")), "k.csv");
    const other = await csvTable(["Дата,Заказы", "2026-10-01,1"]);
    const plan = await planMetricsImport(n, company, previewed);
    expect(plan.fileSha256).toBe(previewed.sha256);
    expect(await code(applyMetricsImport(n, company, other, { expectedSha256: plan.fileSha256 }))).toBe("conflict");
    expect((await applyMetricsImport(n, company, previewed, { expectedSha256: plan.fileSha256 })).applied).toBeGreaterThan(0);
  });
});

describe("salary preview for viewers: current → new, decreases flagged", () => {
  it("an old file that would undo a raise is flagged as a decrease", async () => {
    const n = t.ctx("nuraaly");
    await createPerson(n, {
      fullName: "Повышенная Швея",
      phone: "0555 444 444",
      links: [{ companyId: t.companyIds["kiwi-go"]!, role: "Курьер", salary: { amount: 40000, effectiveFrom: "2026-10-01" } }],
    });
    const table = await csvTable(["ФИО,Компания,Должность,Телефон,Оклад", "Повышенная Швея,Kiwi Go,Курьер,0555 444 444,35000"]);
    const { mapping } = await describeImportFile(n, table);
    const plan = await planImport(n, table, mapping);
    const row = plan.rows[0]!;
    expect(row.action).toBe("update");
    expect(row.salaryBefore).toMatchObject({ amount: 40000 });
    expect(row.salary).toMatchObject({ amount: 35000 });
    expect(row.salaryDecrease).toBe(true);
    expect(row.changes.join(" ")).toMatch(/40\s000 KGS → 35\s000 KGS \(DECREASE/);
    expect(plan.salaryDecreases).toBe(1);
    // Talant's preview of the same file has none of it.
    const tlPlan = await planImport(t.ctx("talant"), table, { fullName: 0, company: 1, role: 2, phone: 3 });
    expect(JSON.stringify(tlPlan)).not.toMatch(/40\s?000|35\s?000|"salary"|salaryBefore|"salaryDecrease"/);
    expect(tlPlan.salaryDecreases).toBe(0);
  });
});

describe("concurrent imports", () => {
  it("pg_advisory_xact_lock works on the embedded database (held inside the transaction)", async () => {
    await t.handle.db.transaction(async (tx) => {
      await lockTransaction(tx as unknown as Db, "people-import");
      const locks = await (tx as unknown as Db).execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory'`);
      const rows = (locks as unknown as { rows: { n: number }[] }).rows;
      expect(rows[0]!.n).toBe(1);
    });
    const after = await t.handle.db.execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory'`);
    expect((after as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(0);
  });

  it("two confirms of the same new file at once create each person once", async () => {
    const n = t.ctx("nuraaly");
    const table = await csvTable(["ФИО,Компания,Телефон", "Параллельный Один,Kiwi Go,0555 909 001", "Параллельный Два,Kiwi Go,0555 909 002"]);
    const mapping = { fullName: 0, company: 1, phone: 2 };
    const results = await Promise.all([
      applyImport(n, table, mapping, { expectedSha256: table.sha256 }),
      applyImport(t.ctx("talant"), table, mapping, { expectedSha256: table.sha256 }),
    ]);
    expect(results.map((r) => r.applied).sort()).toEqual([0, 2]);
    expect(await listPeople(n, { q: "Параллельный" })).toHaveLength(2);
  });
});
