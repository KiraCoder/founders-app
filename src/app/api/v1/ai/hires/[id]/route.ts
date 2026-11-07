import { NextResponse, type NextRequest } from "next/server";
import type { HirePatchInput } from "@/lib/ai-roles";
import { handleApi, isInvalidJson, jsonError, readJson } from "@/server/api";
import { getHire, listHireRuns, updateHire } from "@/server/services/ai-roles";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** GET /api/v1/ai/hires/:id — the hire with its settings and its recent runs. */
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApi(async (ctx) => {
    const hire = await getHire(ctx, id);
    return NextResponse.json({ data: { ...hire, runs: await listHireRuns(ctx, hire.id) } });
  });
}

/**
 * PATCH /api/v1/ai/hires/:id — tune and/or pause: `{ settings?: { schedule, thresholds,
 * requiredMetricKeys, recipients, askUserIds }, notes?, status?: "active" | "paused" }`.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApi(async (ctx) => {
    const body = await readJson(req);
    if (isInvalidJson(body) || typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonError(400, "validation", "Body must be a JSON object");
    }
    return NextResponse.json({ data: await updateHire(ctx, id, body as HirePatchInput) });
  });
}
