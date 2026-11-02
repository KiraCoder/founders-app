import { NextResponse, type NextRequest } from "next/server";
import { isIsoDate } from "@/lib/dates";
import type { LedgerEntryInput } from "@/lib/holding-schemas";
import { handleApi, isInvalidJson, jsonError, readJson } from "@/server/api";
import { addLedgerEntry, getDebts, listLedgerEntries } from "@/server/services/holding";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/holding/debts?asOf=2026-10-31 — net debt per company pair ("debtor owes
 * creditor amount"), the total, and the ledger entries (opening balances, payments).
 */
export async function GET(req: NextRequest) {
  return handleApi(async (ctx) => {
    const asOf = new URL(req.url).searchParams.get("asOf");
    if (asOf && !isIsoDate(asOf)) return jsonError(400, "validation", "asOf must be a date (YYYY-MM-DD)");
    const [debts, entries] = await Promise.all([getDebts(ctx, asOf ?? undefined), listLedgerEntries(ctx)]);
    return NextResponse.json({ data: { ...debts, entries } });
  });
}

/**
 * POST /api/v1/holding/debts — add a ledger entry:
 * `{ kind: "payment" | "opening", debtorCompanyId, creditorCompanyId, entryDate, amount, note? }`.
 */
export async function POST(req: NextRequest) {
  return handleApi(async (ctx) => {
    const body = await readJson(req);
    if (isInvalidJson(body) || typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonError(400, "validation", "Body must be a JSON object");
    }
    return NextResponse.json({ data: await addLedgerEntry(ctx, body as LedgerEntryInput) }, { status: 201 });
  });
}
