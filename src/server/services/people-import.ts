import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { decimalPlaces } from "@/lib/metrics";
import {
  EMPLOYMENT_TYPE_VALUES,
  normalizeName,
  normalizePhone,
  normalizeTelegram,
  parseAmount,
  type EmploymentTypeValue,
  type SalaryPayTypeValue,
} from "@/lib/people-schemas";
import type { Db } from "@/server/db/connect";
import { people, personCompanies } from "@/server/db/schema";
import type { ParsedTable } from "@/server/import/parse-table";
import { assertSalaryViewer, isSalaryViewer, visibleLinksWhere, visiblePeopleWhere } from "./access";
import type { ServiceContext } from "./context";
import { ServiceError } from "./errors";
import { listCompanyUnitOptions, type CompanyUnitOption } from "./people";
import { assertSameFile } from "./import-common";
import { lockTransaction } from "./locks";
import { addSalary, currentSalaries, logSalaryAccess } from "./salaries";
import { formatMoney } from "@/lib/money";

/**
 * Import people from a spreadsheet (replaces the founders' Excel sheet).
 *
 * Flow: parse (parse-table.ts) → map columns → `planImport` (preview: what will be
 * created / updated / skipped, and errors) → `applyImport` (re-plans inside a transaction
 * and writes). Nothing is stored between steps; the browser sends the file again.
 *
 * Matching (idempotent re-import): same name (case/ё-insensitive) AND same phone (digits,
 * +996/0 prefixes ignored). Without a phone, the name must match exactly one person.
 * A person with the same name but no phone yet is matched and gets the phone — by the
 * FIRST row of the file that does so (that row "claims" the person). A later row with the
 * same name and another phone is a different person (new), so two people are never
 * merged and a re-import of the same file matches each row by its phone.
 * Existing values are never overwritten, only empty fields are filled (also enforced in
 * the UPDATE itself: `coalesce(existing, new)`).
 *
 * Salaries: the salary column can be mapped ONLY by a salary viewer. For anyone else it is
 * refused (`forbidden`), also when a salary-looking column is mapped to another field
 * (e.g. notes), and the preview never contains salary values. Viewers see the current →
 * new amount per row, and decreases are flagged.
 *
 * Preview and confirm: the preview returns the sha256 of the file; confirm must send it
 * back and the file must have the same hash (`conflict` otherwise). Confirm runs under a
 * transaction-scoped advisory lock, so two imports at once cannot both create a person.
 */

export const IMPORT_FIELDS = [
  "fullName",
  "company",
  "role",
  "unit",
  "phone",
  "telegram",
  "email",
  "employmentType",
  "salary",
  "payType",
  "notes",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export const SALARY_FIELDS: ImportField[] = ["salary", "payType"];

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  fullName: "Full name",
  company: "Company",
  role: "Role / title",
  unit: "Unit (factory)",
  phone: "Phone",
  telegram: "Telegram",
  email: "Email",
  employmentType: "Employment type",
  salary: "Salary",
  payType: "Pay type",
  notes: "Notes",
};

const SYNONYMS: Record<ImportField, string[]> = {
  fullName: ["full name", "fullname", "name", "фио", "ф.и.о.", "ф.и.о", "имя", "сотрудник", "employee", "person"],
  company: ["company", "компания", "организация", "фирма", "осоо"],
  role: ["role", "title", "position", "job", "должность", "роль", "позиция"],
  unit: ["unit", "factory", "department", "цех", "подразделение", "фабрика", "участок", "отдел", "филиал"],
  phone: ["phone", "tel", "telephone", "mobile", "телефон", "тел", "тел.", "номер", "моб"],
  telegram: ["telegram", "tg", "телеграм", "телеграмм"],
  email: ["email", "e-mail", "mail", "почта", "эл. почта"],
  employmentType: ["employment type", "employment", "тип занятости", "занятость", "тип"],
  salary: ["salary", "зарплата", "зп", "з/п", "оклад", "ставка", "pay", "wage", "amount", "сумма"],
  payType: ["pay type", "тип оплаты", "оплата", "вид оплаты"],
  notes: ["notes", "note", "comment", "комментарий", "примечание", "заметки"],
};

export type ImportMapping = Partial<Record<ImportField, number | null>>;

export const importMappingSchema = z
  .object(Object.fromEntries(IMPORT_FIELDS.map((f) => [f, z.number().int().min(0).max(49).nullable().optional()])) as Record<
    ImportField,
    z.ZodOptional<z.ZodNullable<z.ZodNumber>>
  >)
  .strict();

/** Headers that look like salary columns (so the UI can say they are hidden). */
export function isSalaryHeader(header: string): boolean {
  const h = normalizeName(header);
  return [...SYNONYMS.salary, ...SYNONYMS.payType].some((s) => h === s || (s.length > 3 && h.includes(s)));
}

/** Indexes of columns whose header looks like a salary / pay type column. */
export function salaryHeaderIndexes(headers: string[]): number[] {
  return headers.map((h, i) => (isSalaryHeader(h) ? i : -1)).filter((i) => i >= 0);
}

/** Best-guess mapping from header names (English or Russian). Salary only when allowed. */
export function guessMapping(headers: string[], opts: { allowSalary: boolean }): ImportMapping {
  const norm = headers.map((h) => normalizeName(h));
  // Non-viewers: salary-looking columns are never suggested for any field.
  const used = new Set<number>(opts.allowSalary ? [] : salaryHeaderIndexes(headers));
  const out: ImportMapping = {};
  const fields = IMPORT_FIELDS.filter((f) => opts.allowSalary || !SALARY_FIELDS.includes(f));
  // Exact matches first, then "contains" (longest synonyms first).
  for (const pass of ["exact", "contains"] as const) {
    for (const field of fields) {
      if (out[field] !== undefined) continue;
      const syns = [...SYNONYMS[field]].sort((a, b) => b.length - a.length);
      const idx = norm.findIndex(
        (h, i) =>
          !used.has(i) &&
          syns.some((s) => (pass === "exact" ? h === s : s.length > 3 && h.includes(s))),
      );
      if (idx >= 0) {
        out[field] = idx;
        used.add(idx);
      }
    }
  }
  return out;
}

export interface ImportRowPlan {
  /** Row number in the spreadsheet (1-based, header included). */
  row: number;
  action: "create" | "update" | "skip" | "error";
  fullName: string;
  phone: string | null;
  companyName: string | null;
  role: string | null;
  unitName: string | null;
  /** Human-readable list of what will change (or why it is skipped). */
  changes: string[];
  errors: string[];
  /** Matched existing person (update/skip). */
  personId?: string;
  /** Present only for salary viewers who mapped the salary column. */
  salary?: { amount: number; currency: string; payType: SalaryPayTypeValue } | null;
  /** Viewers only: the current salary this row would replace (null: none yet). */
  salaryBefore?: { amount: number; currency: string; payType: SalaryPayTypeValue } | null;
  /** Viewers only: true when the file's amount is LOWER than the current salary. */
  salaryDecrease?: boolean;
}

export interface ImportPlan {
  rows: ImportRowPlan[];
  counts: { create: number; update: number; skip: number; error: number };
  salaryIncluded: boolean;
  /** Viewers only (0 otherwise): rows that would lower a current salary. */
  salaryDecreases: number;
  /** sha256 of the previewed file; the confirm step must send it back. */
  fileSha256: string;
}

export interface ImportOptions {
  /** Used when the file has no company column or a row leaves it empty. */
  defaultCompanyId?: string | null;
}

export interface ApplyImportOptions extends ImportOptions {
  /** `fileSha256` from the preview. The file must be the same, or nothing is imported. */
  expectedSha256: string;
}

const EMPLOYMENT_WORDS: Record<string, EmploymentTypeValue> = {
  staff: "staff",
  штат: "staff",
  штатный: "staff",
  "в штате": "staff",
  contractor: "contractor",
  подрядчик: "contractor",
  договор: "contractor",
  гпх: "contractor",
  "part-time": "part_time",
  "part time": "part_time",
  part_time: "part_time",
  совместитель: "part_time",
  "частичная занятость": "part_time",
  частичная: "part_time",
};
const PAY_WORDS: Record<string, SalaryPayTypeValue> = {
  monthly: "monthly",
  оклад: "monthly",
  месяц: "monthly",
  ежемесячно: "monthly",
  piecework: "piecework",
  сдельная: "piecework",
  сдельно: "piecework",
  "сдельная оплата": "piecework",
  hourly: "hourly",
  почасовая: "hourly",
  "в час": "hourly",
};

interface PersonRecord {
  id: string;
  nameKey: string;
  phoneKey: string;
  phone: string | null;
  telegramHandle: string | null;
  email: string | null;
  notes: string | null;
  leftAt: Date | null;
}

interface LinkRecord {
  id: string;
  personId: string;
  companyId: string;
  role: string;
  unitId: string | null;
  employmentType: EmploymentTypeValue;
  isActive: boolean;
}

/** What `applyImport` needs to execute a row (kept off the public preview shape). */
interface RowOps {
  plan: ImportRowPlan;
  /** Key of a person created earlier in this file ("new:<n>"), or an existing person id. */
  personRef: string;
  newPerson?: { fullName: string; phone: string | null; telegramHandle: string | null; email: string | null; notes: string | null };
  fill?: Partial<{ phone: string; telegramHandle: string; email: string; notes: string }>;
  link?:
    | { kind: "create"; companyId: string; role: string; unitId: string | null; employmentType: EmploymentTypeValue }
    | { kind: "update"; linkId: string; unitId?: string | null; employmentType?: EmploymentTypeValue };
  /** Existing link id, or undefined for the link created by this row. */
  linkRef?: string;
  salary?: { amount: number; currency: string; payType: SalaryPayTypeValue };
}

function resolveCompany(companies: CompanyUnitOption[], raw: string): CompanyUnitOption | undefined {
  const key = normalizeName(raw).replace(/^(осоо|оао|ип|llc)\s+/, "");
  return companies.find((c) =>
    [c.name, c.slug, c.legalName ?? ""].some((v) => {
      const k = normalizeName(v).replace(/^(осоо|оао|ип|llc)\s+/, "");
      return k !== "" && (k === key || normalizeName(v) === normalizeName(raw));
    }),
  );
}

async function buildPlan(
  ctx: ServiceContext,
  table: ParsedTable,
  rawMapping: ImportMapping,
  opts: ImportOptions,
): Promise<{ ops: RowOps[]; plan: ImportPlan }> {
  const mapping = importMappingSchema.parse(rawMapping);
  const salaryMapped = SALARY_FIELDS.some((f) => mapping[f] !== undefined && mapping[f] !== null);
  if (salaryMapped) await assertSalaryViewer(ctx);
  else if (!(await isSalaryViewer(ctx))) {
    // A non-viewer may not read a salary column through another field (notes, role, ...).
    const salaryCols = new Set(salaryHeaderIndexes(table.headers));
    const forged = IMPORT_FIELDS.find((f) => {
      const idx = mapping[f];
      return idx !== undefined && idx !== null && salaryCols.has(idx);
    });
    if (forged) {
      throw new ServiceError("forbidden", "Only salary viewers can import a salary column");
    }
  }
  if (mapping.fullName === undefined || mapping.fullName === null) {
    throw new ServiceError("validation", "Choose the column with the full name", { fullName: ["Required"] });
  }
  for (const f of IMPORT_FIELDS) {
    const idx = mapping[f];
    if (idx !== undefined && idx !== null && idx >= table.headers.length) {
      throw new ServiceError("validation", `Column for ${IMPORT_FIELD_LABELS[f]} does not exist`);
    }
  }

  const companies = await listCompanyUnitOptions(ctx);
  const defaultCompany = opts.defaultCompanyId ? companies.find((c) => c.id === opts.defaultCompanyId) : undefined;
  if (opts.defaultCompanyId && !defaultCompany) throw new ServiceError("not_found", "Company not found");
  const hasCompanyColumn = mapping.company !== undefined && mapping.company !== null;
  if (!hasCompanyColumn && !defaultCompany) {
    throw new ServiceError("validation", "Choose the company column or a default company", { company: ["Required"] });
  }

  const personRows = await ctx.db.select().from(people).where(visiblePeopleWhere(ctx));
  const persons: PersonRecord[] = personRows.map((p) => ({
    id: p.id,
    nameKey: normalizeName(p.fullName),
    phoneKey: normalizePhone(p.phone),
    phone: p.phone,
    telegramHandle: p.telegramHandle,
    email: p.email,
    notes: p.notes,
    leftAt: p.leftAt,
  }));
  const links: LinkRecord[] = await ctx.db
    .select({
      id: personCompanies.id,
      personId: personCompanies.personId,
      companyId: personCompanies.companyId,
      role: personCompanies.role,
      unitId: personCompanies.unitId,
      employmentType: personCompanies.employmentType,
      isActive: personCompanies.isActive,
    })
    .from(personCompanies)
    .where(visibleLinksWhere(ctx));
  const current = salaryMapped ? await currentSalaries(ctx, links.map((l) => l.id)) : new Map();

  // People and links created by earlier rows of this same file.
  const pending = new Map<string, { ref: string; firstRow: number }>(); // nameKey|phoneKey → ref
  const pendingLinks = new Map<string, number>(); // ref|company|role → row
  const cell = (r: string[], f: ImportField) => {
    const idx = mapping[f];
    return idx === undefined || idx === null ? "" : (r[idx] ?? "").trim();
  };

  const ops: RowOps[] = [];
  table.rows.forEach((r, i) => {
    const rowNo = table.rowNumbers[i] ?? i + 2;
    const errors: string[] = [];
    const changes: string[] = [];
    const fullName = cell(r, "fullName").replace(/\s+/g, " ");
    const phoneRaw = cell(r, "phone");
    const companyRaw = cell(r, "company");
    const roleRaw = cell(r, "role").replace(/\s+/g, " ");
    const unitRaw = cell(r, "unit");

    const plan: ImportRowPlan = {
      row: rowNo,
      action: "skip",
      fullName,
      phone: phoneRaw || null,
      companyName: companyRaw || defaultCompany?.name || null,
      role: roleRaw || null,
      unitName: unitRaw || null,
      changes,
      errors,
    };
    const op: RowOps = { plan, personRef: "" };

    if (!fullName) errors.push("Full name is empty");
    else if (fullName.length > 200) errors.push("Full name is too long");

    const company = companyRaw ? resolveCompany(companies, companyRaw) : defaultCompany;
    if (companyRaw && !company) errors.push(`Unknown company "${companyRaw}"`);
    if (company) plan.companyName = company.name;

    let unitId: string | null = null;
    if (unitRaw && company) {
      const u = company.units.find((x) => normalizeName(x.name) === normalizeName(unitRaw) || x.slug === unitRaw.toLowerCase());
      if (!u) errors.push(`Unknown unit "${unitRaw}" for ${company.name}`);
      else {
        unitId = u.id;
        plan.unitName = u.name;
      }
    }
    const role = (roleRaw || "Employee").slice(0, 120);
    plan.role = role;

    if (phoneRaw && !/^[0-9+()\-\s.]{3,40}$/.test(phoneRaw)) errors.push(`Phone "${phoneRaw}" is not a phone number`);
    const tgRaw = cell(r, "telegram");
    const telegram = tgRaw ? (normalizeTelegram(tgRaw) as string | null) : null;
    if (telegram && !/^[A-Za-z0-9_]{3,64}$/.test(telegram)) errors.push(`Telegram "${tgRaw}" is not a username`);
    const email = cell(r, "email") || null;
    if (email && !z.email().safeParse(email).success) errors.push(`Email "${email}" is not valid`);
    const notes = cell(r, "notes").slice(0, 5000) || null;

    const empRaw = normalizeName(cell(r, "employmentType"));
    let employmentType: EmploymentTypeValue | undefined;
    if (empRaw) {
      employmentType = EMPLOYMENT_WORDS[empRaw] ?? (EMPLOYMENT_TYPE_VALUES as readonly string[]).find((v) => v === empRaw) as EmploymentTypeValue | undefined;
      if (!employmentType) errors.push(`Employment type "${cell(r, "employmentType")}": use staff, contractor or part-time`);
    }

    let salary: RowOps["salary"];
    if (salaryMapped) {
      const salRaw = cell(r, "salary");
      const payRaw = normalizeName(cell(r, "payType"));
      const payType = payRaw ? PAY_WORDS[payRaw] : "monthly";
      if (payRaw && !payType) errors.push(`Pay type "${cell(r, "payType")}": use monthly, piecework or hourly`);
      if (salRaw) {
        // An .xlsx number is taken exactly as stored (never via its display text); amounts
        // are kept to the tiyin: more than 2 decimals is refused, never rounded.
        const salIdx = mapping.salary;
        const numeric = salIdx === undefined || salIdx === null ? null : (table.numbers?.[i]?.[salIdx] ?? null);
        const amount = numeric ? (numeric.percent ? Number.NaN : numeric.value) : parseAmount(salRaw);
        if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000) errors.push(`Salary "${salRaw}" is not an amount`);
        else if (decimalPlaces(amount) > 2) errors.push(`Salary "${salRaw}" has more than 2 decimals`);
        else salary = { amount, currency: "KGS", payType: payType ?? "monthly" };
      }
      plan.salary = salary ?? null;
    }

    if (errors.length > 0 || !company) {
      plan.action = "error";
      if (!company && errors.length === 0) errors.push("Company is empty");
      ops.push(op);
      return;
    }

    // --- Find the person ---------------------------------------------------
    const nameKey = normalizeName(fullName);
    const phoneKey = normalizePhone(phoneRaw);
    const fileKey = `${nameKey}|${phoneKey}`;
    const sameName = persons.filter((p) => p.nameKey === nameKey);
    let person: PersonRecord | undefined;
    const pend = pending.get(fileKey) ?? (phoneKey ? undefined : [...pending.entries()].find(([k]) => k.startsWith(`${nameKey}|`))?.[1]);
    if (pend) {
      op.personRef = pend.ref;
    } else if (phoneKey) {
      person = sameName.find((p) => p.phoneKey === phoneKey);
      if (!person) {
        const noPhone = sameName.filter((p) => !p.phoneKey);
        if (noPhone.length === 1) person = noPhone[0];
      }
    } else if (sameName.length === 1) {
      person = sameName[0];
    } else if (sameName.length > 1) {
      plan.action = "error";
      errors.push(`Several people are called "${fullName}"; add a phone to tell them apart`);
      ops.push(op);
      return;
    }

    if (person?.leftAt) {
      plan.action = "skip";
      plan.personId = person.id;
      changes.push("Marked as left in the app — not changed");
      ops.push(op);
      return;
    }

    if (!pend && !person) {
      const ref = `new:${rowNo}`;
      pending.set(fileKey, { ref, firstRow: rowNo });
      op.personRef = ref;
      op.newPerson = { fullName, phone: phoneRaw || null, telegramHandle: telegram, email, notes };
      changes.push("New person");
      if (sameName.length > 0) changes.push("Note: someone with this name but another phone already exists");
    } else if (person) {
      op.personRef = person.id;
      plan.personId = person.id;
      const fill: NonNullable<RowOps["fill"]> = {};
      if (phoneRaw && !person.phone) fill.phone = phoneRaw;
      if (telegram && !person.telegramHandle) fill.telegramHandle = telegram;
      if (email && !person.email) fill.email = email;
      if (notes && !person.notes) fill.notes = notes;
      if (Object.keys(fill).length > 0) {
        op.fill = fill;
        changes.push(`Fill ${Object.keys(fill).map((k) => (k === "telegramHandle" ? "telegram" : k)).join(", ")}`);
        // This row claims the person: later rows see the filled values, so a second row
        // with the same name and ANOTHER phone no longer matches (it is a new person),
        // and nothing filled here is filled again.
        if (fill.phone) {
          person.phone = fill.phone;
          person.phoneKey = phoneKey;
        }
        if (fill.telegramHandle) person.telegramHandle = fill.telegramHandle;
        if (fill.email) person.email = fill.email;
        if (fill.notes) person.notes = fill.notes;
      }
    }

    // --- Company link ------------------------------------------------------
    const linkKey = `${op.personRef}|${company.id}|${role.toLowerCase()}`;
    const fromFile = pendingLinks.get(linkKey);
    const existing = person
      ? links.find((l) => l.personId === person.id && l.companyId === company.id && l.role.toLowerCase() === role.toLowerCase())
      : undefined;
    if (fromFile !== undefined) {
      plan.action = "skip";
      changes.length = 0;
      changes.push(`Duplicate of row ${fromFile}`);
      ops.push(op);
      return;
    }
    pendingLinks.set(linkKey, rowNo);
    if (!existing) {
      op.link = { kind: "create", companyId: company.id, role, unitId, employmentType: employmentType ?? "staff" };
      changes.push(`Add ${role} at ${company.name}${plan.unitName ? ` (${plan.unitName})` : ""}`);
    } else if (!existing.isActive) {
      plan.action = "skip";
      changes.length = 0;
      changes.push(`Left ${company.name} in the app — not changed`);
      ops.push(op);
      return;
    } else {
      op.linkRef = existing.id;
      const upd: { kind: "update"; linkId: string; unitId?: string | null; employmentType?: EmploymentTypeValue } = {
        kind: "update",
        linkId: existing.id,
      };
      if (unitRaw && unitId !== existing.unitId) {
        upd.unitId = unitId;
        changes.push(`Unit → ${plan.unitName}`);
      }
      if (employmentType && employmentType !== existing.employmentType) {
        upd.employmentType = employmentType;
        changes.push(`Employment → ${employmentType.replace("_", "-")}`);
      }
      if (upd.unitId !== undefined || upd.employmentType) op.link = upd;
    }

    // --- Salary ------------------------------------------------------------
    if (salary) {
      const cur = existing ? current.get(existing.id) : undefined;
      plan.salaryBefore = cur ? { amount: cur.amount, currency: cur.currency, payType: cur.payType } : null;
      const same = cur && cur.amount === salary.amount && cur.currency === salary.currency && cur.payType === salary.payType;
      if (!same) {
        op.salary = salary;
        if (cur) {
          const decrease = cur.currency === salary.currency && salary.amount < cur.amount;
          plan.salaryDecrease = decrease;
          changes.push(
            `Salary ${formatMoney(cur.amount, cur.currency)} → ${formatMoney(salary.amount, salary.currency)}${decrease ? " (DECREASE — check the file is current)" : ""}`,
          );
        } else {
          changes.push(`Salary set: ${formatMoney(salary.amount, salary.currency)}`);
        }
      }
    }

    plan.action = op.newPerson ? "create" : changes.length > 0 ? "update" : "skip";
    if (plan.action === "skip") changes.push("Already up to date");
    if (plan.action === "update" && pend) changes.unshift(`Same person as row ${pend.firstRow}`);
    ops.push(op);
  });

  const counts = { create: 0, update: 0, skip: 0, error: 0 };
  for (const o of ops) counts[o.plan.action]++;
  const salaryDecreases = ops.filter((o) => o.plan.salaryDecrease && o.salary && o.plan.action === "update").length;
  return {
    ops,
    plan: { rows: ops.map((o) => o.plan), counts, salaryIncluded: salaryMapped, salaryDecreases, fileSha256: table.sha256 },
  };
}

/** Preview: what would be created / updated / skipped, with errors. Writes nothing (except the salary view audit). */
export async function planImport(
  ctx: ServiceContext,
  table: ParsedTable,
  mapping: ImportMapping,
  opts: ImportOptions = {},
): Promise<ImportPlan> {
  const { plan } = await buildPlan(ctx, table, mapping, opts);
  if (plan.salaryIncluded) {
    await logSalaryAccess(ctx, { action: "view", scope: "import_preview", details: { rows: plan.rows.length } });
  }
  return plan;
}

export interface ImportResult extends ImportPlan {
  applied: number;
}

/**
 * Re-plans and applies in one transaction. Error rows are not applied; the rest is.
 * The file must be the previewed one (`expectedSha256`), and people imports are
 * serialised by an advisory lock taken before planning.
 */
export async function applyImport(
  ctx: ServiceContext,
  table: ParsedTable,
  mapping: ImportMapping,
  opts: ApplyImportOptions,
): Promise<ImportResult> {
  assertSameFile(table, opts.expectedSha256);
  return ctx.db.transaction(async (rawTx) => {
    const tx: ServiceContext = { ...ctx, db: rawTx as unknown as Db };
    await lockTransaction(tx.db, "people-import");
    const { ops, plan } = await buildPlan(tx, table, mapping, opts);
    const created = new Map<string, string>(); // "new:<row>" → person id
    let applied = 0;
    for (const op of ops) {
      if (op.plan.action !== "create" && op.plan.action !== "update") continue;
      let personId = op.personRef.startsWith("new:") ? created.get(op.personRef) : op.personRef;
      if (op.newPerson) {
        const [row] = await tx.db.insert(people).values(op.newPerson).returning({ id: people.id });
        personId = row!.id;
        created.set(op.personRef, personId);
      }
      if (!personId) continue;
      if (op.fill) {
        // Never overwrite: only empty fields take the file's value, even if the row changed meanwhile.
        const set: Record<string, unknown> = { updatedAt: ctx.now };
        if (op.fill.phone) set.phone = sql`coalesce(${people.phone}, ${op.fill.phone})`;
        if (op.fill.telegramHandle) set.telegramHandle = sql`coalesce(${people.telegramHandle}, ${op.fill.telegramHandle})`;
        if (op.fill.email) set.email = sql`coalesce(${people.email}, ${op.fill.email})`;
        if (op.fill.notes) set.notes = sql`coalesce(${people.notes}, ${op.fill.notes})`;
        await tx.db.update(people).set(set).where(eq(people.id, personId));
      }
      let linkId = op.linkRef;
      if (op.link?.kind === "create") {
        const [l] = await tx.db
          .insert(personCompanies)
          .values({
            personId,
            companyId: op.link.companyId,
            role: op.link.role,
            unitId: op.link.unitId,
            employmentType: op.link.employmentType,
          })
          .returning({ id: personCompanies.id });
        linkId = l!.id;
      } else if (op.link?.kind === "update") {
        const set: Partial<typeof personCompanies.$inferInsert> = { updatedAt: ctx.now };
        if (op.link.unitId !== undefined) set.unitId = op.link.unitId;
        if (op.link.employmentType) set.employmentType = op.link.employmentType;
        await tx.db
          .update(personCompanies)
          .set(set)
          .where(and(eq(personCompanies.id, op.link.linkId), eq(personCompanies.personId, personId)));
      }
      if (op.salary && linkId) await addSalary(tx, linkId, op.salary, "import");
      applied++;
    }
    if (plan.salaryIncluded) {
      await logSalaryAccess(tx, { action: "import", scope: "import", details: { rows: plan.rows.length, applied } });
    }
    return { ...plan, applied };
  });
}

/** Mapping suggestion + which headers are salary columns, for the mapping step. */
export async function describeImportFile(ctx: ServiceContext, table: ParsedTable) {
  const allowSalary = await isSalaryViewer(ctx);
  return {
    headers: table.headers,
    rowCount: table.rows.length,
    allowSalary,
    salaryHeaders: allowSalary ? [] : salaryHeaderIndexes(table.headers),
    mapping: guessMapping(table.headers, { allowSalary }),
  };
}
