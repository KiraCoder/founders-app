import { NextResponse, type NextRequest } from "next/server";
import { handleApi, isInvalidJson, jsonError, readJson } from "@/server/api";
import { askCardFromGrid } from "@/server/services/holding-asks";
import { getActsGrid, patchAct } from "@/server/services/holding";
import type { ActPatchInput } from "@/lib/holding-schemas";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/holding/acts — the акты grid: months (last 12 finished + current), one row
 * per active flow with a cell per month (state, tone, recorded status, amount, …), the
 * missing / requested counts and `ask` (what to ask Elmurat for, plus the copyable message).
 */
export async function GET() {
  return handleApi(async (ctx) => {
    const grid = await getActsGrid(ctx);
    return NextResponse.json({ data: { ...grid, ask: askCardFromGrid(grid) } });
  });
}

/**
 * PATCH /api/v1/holding/acts — change one cell:
 * `{ flowId, period: "2026-10", status?, amount?, actNumber?, actDate?, requestedOn?, note?, attachmentFileId? }`.
 * Left-out fields stay; null clears.
 */
export async function PATCH(req: NextRequest) {
  return handleApi(async (ctx) => {
    const body = await readJson(req);
    if (isInvalidJson(body) || typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonError(400, "validation", "Body must be a JSON object");
    }
    const { cell } = await patchAct(ctx, body as ActPatchInput);
    return NextResponse.json({ data: cell });
  });
}
