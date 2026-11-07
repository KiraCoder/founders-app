import { NextResponse, type NextRequest } from "next/server";
import { metricValueInputSchema } from "@/lib/metric-schemas";
import { handleApi, isInvalidJson, jsonError, readJson } from "@/server/api";
import { getMetric, listMetricValues, recordMetricValue } from "@/server/services/metrics";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/v1/metrics/:id/values?history=1&limit=200 — current value per period (newest
 * first); with history=1 also the corrected (non-current) rows.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApi(async (ctx) => {
    const url = new URL(req.url);
    const metric = await getMetric(ctx, id);
    const limit = Number(url.searchParams.get("limit") ?? "200");
    const values = await listMetricValues(ctx, id, {
      includeHistory: url.searchParams.get("history") === "1",
      limit: Number.isFinite(limit) ? limit : 200,
    });
    return NextResponse.json({ data: { metric, values } });
  });
}

/** POST /api/v1/metrics/:id/values — body `{ period, value, note? }`. A second value for the same period is a correction (history kept). */
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApi(async (ctx) => {
    const body = await readJson(req);
    if (isInvalidJson(body) || typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonError(400, "validation", "Body must be a JSON object");
    }
    const input = metricValueInputSchema.parse(body);
    const result = await recordMetricValue(ctx, id, input, "manual");
    return NextResponse.json({ data: result }, { status: result.action === "created" ? 201 : 200 });
  });
}
