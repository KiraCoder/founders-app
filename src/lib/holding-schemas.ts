/**
 * Zod input schemas for the Holding page (server actions and REST). Form posts send ""
 * for empty fields; `blankToNull` turns those into null. Amounts are parsed by the
 * service (exact KGS, at most 2 decimals, "85.000" refused as ambiguous).
 */
import { z } from "zod";
import { isIsoDate } from "./dates";
import { ACT_STATUSES, CONTRACT_STATUSES, FLOW_STATUSES } from "./holding";

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const isoDate = z.string().trim().refine(isIsoDate, { message: "Use a valid date (YYYY-MM-DD)" });
const optionalDate = z.preprocess(blankToNull, isoDate.nullable().optional());
const optionalText = (max: number) => z.preprocess(blankToNull, z.string().trim().max(max).nullable().optional());
const optionalUuid = z.preprocess(blankToNull, z.uuid().nullable().optional());
const amount = z.preprocess(blankToNull, z.union([z.number(), z.string().trim().max(40)]).nullable().optional());
/** A month: "2026-10" or any day in it ("2026-10-31"). */
export const monthSchema = z
  .string()
  .trim()
  .refine((v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(v) || isIsoDate(v), { message: "Use a month like 2026-10" })
  .transform((v) => `${v.slice(0, 7)}-01`);

export const flowCreateSchema = z
  .object({
    fromCompanyId: z.uuid({ message: "Choose the company that provides the service" }),
    toCompanyId: z.uuid({ message: "Choose the company that receives it" }),
    service: z.string().trim().min(1, "What is the service? e.g. пошив").max(60),
    description: optionalText(500),
    since: optionalDate,
    until: optionalDate,
    status: z.preprocess(blankToNull, z.enum(FLOW_STATUSES).nullable().optional()),
  })
  .strict();
export type FlowCreateInput = z.input<typeof flowCreateSchema>;

/** The two companies of a flow never change (create a new flow instead). */
export const flowUpdateSchema = z
  .object({
    service: z.string().trim().min(1, "What is the service?").max(60).optional(),
    description: optionalText(500),
    since: optionalDate,
    until: optionalDate,
    status: z.enum(FLOW_STATUSES).optional(),
  })
  .strict();
export type FlowUpdateInput = z.input<typeof flowUpdateSchema>;

export const contractCreateSchema = z
  .object({
    flowId: z.uuid({ message: "Choose the flow" }),
    number: z.string().trim().min(1, "Contract number is required (e.g. № 12/2026)").max(60),
    signedOn: optionalDate,
    validUntil: optionalDate,
    status: z.preprocess(blankToNull, z.enum(CONTRACT_STATUSES).nullable().optional()),
    amountTerms: optionalText(500),
    attachmentFileId: optionalUuid,
  })
  .strict();
export type ContractCreateInput = z.input<typeof contractCreateSchema>;

export const contractUpdateSchema = contractCreateSchema.omit({ flowId: true }).partial().strict();
export type ContractUpdateInput = z.input<typeof contractUpdateSchema>;

/**
 * Change one cell of the акты grid. Fields left out stay as they are; null clears.
 * `requestedOn` defaults to today when the status becomes "requested".
 */
export const actPatchSchema = z
  .object({
    flowId: z.uuid(),
    period: monthSchema,
    status: z.enum(ACT_STATUSES).optional(),
    amount,
    actNumber: optionalText(60),
    actDate: optionalDate,
    requestedOn: optionalDate,
    note: optionalText(500),
    attachmentFileId: optionalUuid,
  })
  .strict();
export type ActPatchInput = z.input<typeof actPatchSchema>;

export const LEDGER_KINDS = ["opening", "payment"] as const;

export const ledgerEntrySchema = z
  .object({
    kind: z.enum(LEDGER_KINDS),
    debtorCompanyId: z.uuid({ message: "Choose the company that owes / pays" }),
    creditorCompanyId: z.uuid({ message: "Choose the company that is owed / paid" }),
    entryDate: isoDate,
    amount: z.union([z.number(), z.string().trim().min(1, "Enter the amount").max(40)]),
    note: optionalText(500),
  })
  .strict();
export type LedgerEntryInput = z.input<typeof ledgerEntrySchema>;

/** "I asked Elmurat" for these cells (in-app button). */
export const askedSchema = z
  .object({
    cells: z.array(z.object({ flowId: z.uuid(), period: monthSchema }).strict()).min(1).max(500),
  })
  .strict();
export type AskedInput = z.input<typeof askedSchema>;
