import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";
import { people, salaries, salaryAccessLog } from "@/server/db/schema";
import { ImportFileError, MAX_IMPORT_BYTES, parseTableFile } from "@/server/import/parse-table";
import { toServiceError } from "@/server/services/errors";
import { applyImport, describeImportFile, guessMapping, planImport } from "@/server/services/people-import";
import { getPerson, listPeople } from "@/server/services/people";
import { createTestDb, type TestDb } from "../helpers/db";

const SAMPLE = path.join(process.cwd(), "docs/samples/people-sample.csv");
const sampleBytes = () => new Uint8Array(readFileSync(SAMPLE));

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

describe("parsing", () => {
  it("reads the sample CSV (Russian headers, UTF-8)", async () => {
    const table = await parseTableFile(sampleBytes(), "people-sample.csv");
    expect(table.headers[0]).toBe("ФИО");
    expect(table.rows).toHaveLength(10);
    expect(table.rowNumbers[0]).toBe(2);
  });

  it("reads semicolon CSV in Windows-1251 (Excel on Russian Windows)", async () => {
    const text = "ФИО;Компания;Телефон\r\nТест Тестов;Kiwi Go;0555 000 111\r\n";
    // Encode as cp1251 by hand for the Cyrillic letters used here.
    const cp1251: Record<string, number> = {};
    "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя".split("").forEach((ch, i) => (cp1251[ch] = 0xc0 + i));
    const bytes = new Uint8Array([...text].map((ch) => cp1251[ch] ?? ch.charCodeAt(0)));
    const table = await parseTableFile(bytes, "x.csv");
    expect(table.headers).toEqual(["ФИО", "Компания", "Телефон"]);
    expect(table.rows[0]).toEqual(["Тест Тестов", "Kiwi Go", "0555 000 111"]);
  });

  it("reads .xlsx with numbers, and refuses big, empty, .xls and fake files", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Люди");
    ws.addRow(["Full name", "Company", "Role", "Phone", "Salary"]);
    ws.addRow(["Xlsx Person", "Kiwi Go", "Courier", 996555000777, 25000]);
    const buf = new Uint8Array(await wb.xlsx.writeBuffer());
    const table = await parseTableFile(buf, "people.xlsx");
    expect(table.headers).toEqual(["Full name", "Company", "Role", "Phone", "Salary"]);
    expect(table.rows[0]).toEqual(["Xlsx Person", "Kiwi Go", "Courier", "996555000777", "25000"]);

    const err = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof ImportFileError ? e.message : String(e)));
    expect(await err(parseTableFile(new Uint8Array(MAX_IMPORT_BYTES + 1), "a.csv"))).toMatch(/2 MB/);
    expect(await err(parseTableFile(new Uint8Array(0), "a.csv"))).toMatch(/empty/);
    expect(await err(parseTableFile(new Uint8Array([1, 2, 3]), "a.xls"))).toMatch(/\.xls/);
    expect(await err(parseTableFile(new TextEncoder().encode("not a zip"), "a.xlsx"))).toMatch(/not a valid/);
    expect(await err(parseTableFile(new TextEncoder().encode("a,b"), "a.pdf"))).toMatch(/xlsx or \.csv/);
  });

  it("guesses the mapping from Russian headers; salary only for viewers", async () => {
    const table = await parseTableFile(sampleBytes(), "people-sample.csv");
    const forViewer = guessMapping(table.headers, { allowSalary: true });
    expect(forViewer).toMatchObject({ fullName: 0, company: 1, role: 2, unit: 3, phone: 4, telegram: 5, employmentType: 6, salary: 7, notes: 8 });
    const forOthers = guessMapping(table.headers, { allowSalary: false });
    expect(forOthers.salary).toBeUndefined();

    const talantView = await describeImportFile(t.ctx("talant"), table);
    expect(talantView.allowSalary).toBe(false);
    expect(talantView.mapping.salary).toBeUndefined();
    expect(talantView.salaryHeaders).toEqual([7]);
    expect(JSON.stringify(talantView)).not.toMatch(/32 000|28000|45000/);
  });
});

describe("import with the sample CSV", () => {
  it("Talant: preview has no salaries, and mapping the salary column is forbidden", async () => {
    const tl = t.ctx("talant");
    const table = await parseTableFile(sampleBytes(), "people-sample.csv");
    const { mapping } = await describeImportFile(tl, table);
    const plan = await planImport(tl, table, mapping);
    expect(plan.salaryIncluded).toBe(false);
    expect(plan.rows.every((r) => !("salary" in r))).toBe(true);
    expect(JSON.stringify(plan)).not.toMatch(/32000|32 000|28000|45000/);
    expect(await code(planImport(tl, table, { ...mapping, salary: 7 }))).toBe("forbidden");
    expect(await code(applyImport(tl, table, { ...mapping, salary: 7 }, { expectedSha256: table.sha256 }))).toBe("forbidden");
  });

  it("Nuraaly: preview reports create/skip/error rows; confirm creates; re-import changes nothing", async () => {
    const n = t.ctx("nuraaly");
    const table = await parseTableFile(sampleBytes(), "people-sample.csv");
    const { mapping, allowSalary } = await describeImportFile(n, table);
    expect(allowSalary).toBe(true);

    const plan = await planImport(n, table, mapping);
    expect(plan.salaryIncluded).toBe(true);
    const byRow = Object.fromEntries(plan.rows.map((r) => [r.row, r]));
    expect(plan.counts).toEqual({ create: 5, update: 1, skip: 1, error: 3 });
    expect(byRow[2]!.action).toBe("create");
    expect(byRow[2]!.unitName).toBe("ХБК");
    expect(byRow[2]!.salary).toEqual({ amount: 32000, currency: "KGS", payType: "monthly" });
    expect(byRow[6]!.action).toBe("skip"); // duplicate line
    expect(byRow[6]!.changes.join(" ")).toMatch(/Duplicate of row 5/);
    expect(byRow[8]!.action).toBe("update"); // second company of the accountant
    expect(byRow[8]!.changes.join(" ")).toMatch(/Same person as row 7/);
    expect(byRow[9]!.errors.join(" ")).toMatch(/Unknown company/);
    expect(byRow[10]!.errors.join(" ")).toMatch(/Salary "много"/);
    expect(byRow[11]!.errors.join(" ")).toMatch(/Full name is empty/);
    // Preview writes no people.
    expect((await listPeople(n, { q: "(пример)" })).length).toBe(0);

    const result = await applyImport(n, table, mapping, { expectedSha256: table.sha256 });
    expect(result.applied).toBe(6);
    const imported = await listPeople(n, { q: "(пример)" }, { salaryScope: "test" });
    expect(imported.map((p) => p.fullName).sort()).toEqual(
      ["Демо Курманбек (пример)", "Образцов Бакыт (пример)", "Примерова Нургуль (пример)", "Тестова Айгуль (пример)", "Учётова Гульнара (пример)"].sort(),
    );
    const accountant = imported.find((p) => p.fullName.startsWith("Учётова"))!;
    expect(accountant.roles.map((r) => [r.companyName, r.employmentType, r.salary?.amount])).toEqual([
      ["Jobutify", "part_time", 15000],
      ["Asqa Zou Holding", "part_time", 40000],
    ]);
    const courier = imported.find((p) => p.fullName.startsWith("Демо"))!;
    expect(courier.telegramHandle).toBe("sample_kurmanbek");
    expect(courier.roles).toHaveLength(1);
    const piece = imported.find((p) => p.fullName.startsWith("Примерова"))!;
    expect(piece.roles[0]!.unitName).toBe("Ош Район");

    // Salary changes are audited (one "change" per salary written) plus one "import" row.
    const log = await t.handle.db.select().from(salaryAccessLog);
    expect(log.filter((l) => l.action === "change" && l.scope === "import")).toHaveLength(6);
    expect(log.filter((l) => l.action === "import")).toHaveLength(1);

    // Re-import: no new people, no new links, no new salary rows.
    const peopleBefore = (await t.handle.db.select().from(people)).length;
    const salariesBefore = (await t.handle.db.select().from(salaries)).length;
    const again = await planImport(n, table, mapping);
    expect(again.counts).toEqual({ create: 0, update: 0, skip: 7, error: 3 });
    await applyImport(n, table, mapping, { expectedSha256: table.sha256 });
    expect((await t.handle.db.select().from(people)).length).toBe(peopleBefore);
    expect((await t.handle.db.select().from(salaries)).length).toBe(salariesBefore);
  });

  it("a changed salary in the sheet adds a history row; existing values are not overwritten", async () => {
    const n = t.ctx("nuraaly");
    const csv = [
      "ФИО,Компания,Должность,Цех,Телефон,Оклад,Email",
      // Same person matched by name + phone written differently.
      "Тестова Айгуль (пример),Alura Style,Швея,ХБК,0555000001,34000,aigul@example.test",
    ].join("\n");
    const table = await parseTableFile(new TextEncoder().encode(csv), "update.csv");
    const { mapping } = await describeImportFile(n, table);
    const plan = await planImport(n, table, mapping);
    expect(plan.rows[0]!.action).toBe("update");
    expect(plan.rows[0]!.changes[0]).toBe("Fill email");
    expect(plan.rows[0]!.changes[1]).toMatch(/^Salary 32\s000 KGS → 34\s000 KGS$/);
    expect(plan.rows[0]!.salaryBefore).toEqual({ amount: 32000, currency: "KGS", payType: "monthly" });
    expect(plan.rows[0]!.salaryDecrease).toBe(false);
    expect(plan.salaryDecreases).toBe(0);
    await applyImport(n, table, mapping, { expectedSha256: table.sha256 });
    const p = (await listPeople(n, { q: "Тестова Айгуль" }))[0]!;
    const full = await getPerson(n, p.id, { salaryScope: "test" });
    expect(full.phone).toBe("+996 555 000 001");
    expect(full.email).toBe("aigul@example.test");
    expect(full.roles[0]!.salaryHistory?.map((s) => s.amount)).toEqual([34000, 32000]);
  });

  it("a namesake with another phone is a new person; same name without phone is ambiguous", async () => {
    const n = t.ctx("nuraaly");
    const csv = [
      "ФИО,Компания,Телефон",
      "Тестова Айгуль (пример),Kiwi Go,+996 555 999 999",
      "Тестова Айгуль (пример),Kiwi Go,",
    ].join("\n");
    const table = await parseTableFile(new TextEncoder().encode(csv), "namesake.csv");
    const plan = await planImport(n, table, { fullName: 0, company: 1, phone: 2 });
    expect(plan.rows[0]!.action).toBe("create");
    expect(plan.rows[0]!.changes.join(" ")).toMatch(/another phone/);
    // The second row has no phone; the file already introduced a namesake, so it joins that one.
    expect(plan.rows[1]!.action).toBe("skip");
  });

  it("default company for files without a company column; leavers are not touched", async () => {
    const n = t.ctx("nuraaly");
    const csv = ["Name,Role,Phone", "Default Co Person,Courier,+996 555 000 321"].join("\n");
    const table = await parseTableFile(new TextEncoder().encode(csv), "d.csv");
    expect(await code(planImport(n, table, { fullName: 0, role: 1, phone: 2 }))).toBe("validation");
    const plan = await planImport(n, table, { fullName: 0, role: 1, phone: 2 }, { defaultCompanyId: t.companyIds["kiwi-go"] });
    expect(plan.rows[0]!.companyName).toBe("Kiwi Go");
    await applyImport(n, table, { fullName: 0, role: 1, phone: 2 }, { defaultCompanyId: t.companyIds["kiwi-go"], expectedSha256: table.sha256 });
    const p = (await listPeople(n, { q: "Default Co Person" }))[0]!;
    const { markPersonLeft } = await import("@/server/services/people");
    await markPersonLeft(n, p.id);
    const again = await planImport(n, table, { fullName: 0, role: 1, phone: 2 }, { defaultCompanyId: t.companyIds["kiwi-go"] });
    expect(again.rows[0]!.action).toBe("skip");
    expect(again.rows[0]!.changes.join(" ")).toMatch(/left/);
    const [row] = await t.handle.db.select().from(people).where(eq(people.id, p.id));
    expect(row!.leftAt).not.toBeNull();
  });
});
