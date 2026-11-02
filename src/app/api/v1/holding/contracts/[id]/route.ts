import { NextResponse, type NextRequest } from "next/server";
import type { ContractUpdateInput } from "@/lib/holding-schemas";
import { handleApi, isInvalidJson, jsonError, readJson } from "@/server/api";
import { archiveContract, updateContract } from "@/server/services/holding";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** PATCH /api/v1/holding/contracts/:id — contract fields, or `{ "archived": true }` (archive; never deleted). */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApi(async (ctx) => {
    const body = await readJson(req);
    if (isInvalidJson(body) || typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonError(400, "validation", "Body must be a JSON object");
    }
    if ((body as { archived?: unknown }).archived === true && Object.keys(body).length === 1) {
      await archiveContract(ctx, id);
      return NextResponse.json({ data: { id, archived: true } });
    }
    return NextResponse.json({ data: await updateContract(ctx, id, body as ContractUpdateInput) });
  });
}
