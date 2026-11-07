import { NextResponse, type NextRequest } from "next/server";
import type { ContractCreateInput } from "@/lib/holding-schemas";
import { handleApi, isInvalidJson, jsonError, readJson } from "@/server/api";
import { createContract, listContracts } from "@/server/services/holding";

export const dynamic = "force-dynamic";

/** GET /api/v1/holding/contracts?archived=1 — contracts with their flow, attachment and expiry warning. */
export async function GET(req: NextRequest) {
  return handleApi(async (ctx) => {
    const includeArchived = new URL(req.url).searchParams.get("archived") === "1";
    return NextResponse.json({ data: await listContracts(ctx, { includeArchived }) });
  });
}

/** POST /api/v1/holding/contracts — `{ flowId, number, signedOn?, validUntil?, status?, amountTerms?, attachmentFileId? }`. */
export async function POST(req: NextRequest) {
  return handleApi(async (ctx) => {
    const body = await readJson(req);
    if (isInvalidJson(body) || typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonError(400, "validation", "Body must be a JSON object");
    }
    return NextResponse.json({ data: await createContract(ctx, body as ContractCreateInput) }, { status: 201 });
  });
}
