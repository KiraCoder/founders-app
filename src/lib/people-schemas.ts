/**
 * Zod input schemas for people, person-company links and salaries. Shared by server
 * actions, the REST API and the importer. Form posts send "" for empty fields.
 */
import { z } from "zod";
import { isIsoDate } from "./dates";

export const EMPLOYMENT_TYPE_VALUES = ["staff", "contractor", "part_time"] as const;
export const SALARY_PAY_TYPE_VALUES = ["monthly", "piecework", "hourly"] as const;
export const PEOPLE_STATUS_VALUES = ["active", "left", "all"] as const;
export type EmploymentTypeValue = (typeof EMPLOYMENT_TYPE_VALUES)[number];
export type SalaryPayTypeValue = (typeof SALARY_PAY_TYPE_VALUES)[number];
export type PeopleStatus = (typeof PEOPLE_STATUS_VALUES)[number];

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentTypeValue, string> = {
  staff: "Staff",
  contractor: "Contractor",
  part_time: "Part-time",
};
export const PAY_TYPE_LABELS: Record<SalaryPayTypeValue, string> = {
  monthly: "Monthly",
  piecework: "Piecework",
  hourly: "Hourly",
};

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const optionalText = (max: number) => z.preprocess(blankToNull, z.string().trim().max(max).nullable().optional());
const optionalUuid = z.preprocess(blankToNull, z.uuid().nullable().optional());
const isoDate = z.string().refine(isIsoDate, { message: "Use a valid date (YYYY-MM-DD)" });
const optionalDate = z.preprocess(blankToNull, isoDate.nullable().optional());
const formBool = z.preprocess(
  (v) => (typeof v === "string" ? v === "on" || v === "true" || v === "1" : v),
  z.boolean(),
);

/** "@ali_k", "ali_k", "t.me/ali_k" → "ali_k". */
export function normalizeTelegram(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const s = v.trim().replace(/^https?:\/\/t\.me\//i, "").replace(/^t\.me\//i, "").replace(/^@/, "");
  return s === "" ? null : s;
}

/**
 * Parses money typed by people: "85 000", "85,000", "85000.50", "85 000,50 сом".
 * Returns NaN when it is not a number.
 */
export function parseAmount(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return Number.NaN;
  let s = v.replace(/[\s  ]/g, "").replace(/(сом|kgs|som|с)\.?$/i, "");
  if (s === "") return Number.NaN;
  // "85,000" / "1,250,000" → thousands; "850,50" → decimal comma.
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(s)) return Number.NaN;
  return Number(s);
}

export const amountSchema = z.preprocess(
  (v) => (v === "" || v === null || v === undefined ? v : parseAmount(v)),
  z
    .number({ message: "Enter an amount, e.g. 45000" })
    .refine((n) => Number.isFinite(n), "Enter an amount, e.g. 45000")
    .refine((n) => n >= 0, "Amount can't be negative")
    .refine((n) => n <= 1_000_000_000, "Amount is too large")
    .refine((n) => Math.round(n * 100) === n * 100 || Math.abs(Math.round(n * 100) - n * 100) < 1e-6, "At most 2 decimals"),
);

export const salaryInputSchema = z
  .object({
    amount: amountSchema,
    currency: z.preprocess(
      (v) => (typeof v === "string" ? (v.trim() === "" ? undefined : v.trim().toUpperCase()) : v),
      z.string().regex(/^[A-Z]{3}$/, "Use a 3-letter currency code, e.g. KGS").default("KGS"),
    ),
    payType: z.preprocess(blankToNull, z.enum(SALARY_PAY_TYPE_VALUES).nullable().optional()),
    /** Defaults to today (Asia/Bishkek) in the service. */
    effectiveFrom: optionalDate,
    note: optionalText(500),
  })
  .strict();
export type SalaryInput = z.input<typeof salaryInputSchema>;

const linkFields = {
  companyId: z.uuid({ message: "Choose a company" }),
  unitId: optionalUuid,
  role: z.string().trim().min(1, "Role is required").max(120),
  title: optionalText(200),
  employmentType: z.preprocess(blankToNull, z.enum(EMPLOYMENT_TYPE_VALUES).nullable().optional()),
  isActive: formBool.optional(),
  startedOn: optionalDate,
  endedOn: optionalDate,
};

export const linkCreateSchema = z
  .object({
    ...linkFields,
    /** Only salary viewers may send this; anyone else gets `forbidden`. */
    salary: salaryInputSchema.optional(),
  })
  .strict();
export type LinkCreateInput = z.input<typeof linkCreateSchema>;

export const linkUpdateSchema = z
  .object({
    unitId: linkFields.unitId,
    role: linkFields.role,
    title: linkFields.title,
    employmentType: linkFields.employmentType,
    isActive: linkFields.isActive,
    startedOn: linkFields.startedOn,
    endedOn: linkFields.endedOn,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });
export type LinkUpdateInput = z.input<typeof linkUpdateSchema>;

const personFields = {
  fullName: z.string().trim().min(1, "Full name is required").max(200),
  shortName: optionalText(80),
  phone: z.preprocess(blankToNull, z.string().trim().max(40).regex(/^[0-9+()\-\s.]*$/, "Use digits, spaces, +, -, ( )").nullable().optional()),
  telegramHandle: z.preprocess(
    normalizeTelegram,
    z.string().regex(/^[A-Za-z0-9_]{3,64}$/, "Telegram username: letters, digits, _").nullable().optional(),
  ),
  email: z.preprocess(blankToNull, z.email("Enter a valid email").max(200).nullable().optional()),
  notes: optionalText(5000),
};

export const personCreateSchema = z
  .object({
    ...personFields,
    links: z.array(linkCreateSchema).max(20).optional(),
  })
  .strict();
export type PersonCreateInput = z.input<typeof personCreateSchema>;

export const personUpdateSchema = z
  .object({
    ...personFields,
    /** "left" marks the person (and all their active company links) as left; "active" undoes it. */
    status: z.enum(["active", "left"]).optional(),
    /** Date the person left (with status "left"); default today. */
    leftOn: optionalDate,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });
export type PersonUpdateInput = z.input<typeof personUpdateSchema>;

export const peopleFiltersSchema = z.object({
  q: optionalText(200),
  companyId: optionalUuid,
  unitId: optionalUuid,
  status: z.preprocess(blankToNull, z.enum(PEOPLE_STATUS_VALUES).nullable().optional()),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});
export type PeopleFilters = z.input<typeof peopleFiltersSchema>;

/** Normalized key used to match people on import: lower-case, single spaces, ё → е. */
export function normalizeName(name: string): string {
  return name.normalize("NFC").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

/** Digits only; a local KG number "0555 123 456" and "+996 555 123 456" give the same key. */
export function normalizePhone(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.startsWith("996") && digits.length === 12) return digits.slice(3);
  if (digits.startsWith("0") && digits.length === 10) return digits.slice(1);
  return digits;
}
