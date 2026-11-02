import { NextResponse, type NextRequest } from "next/server";
import { askedSchema } from "@/lib/holding-schemas";
import { handleApi, isInvalidJson, jsonError, readJson } from "@/server/api";
import { markAskedInApp } from "@/server/services/holding-asks";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/holding/asked — "I asked Elmurat": `{ cells: [{ flowId, period }], again?: true }`.
 * Missing cells become requested today (with `again`: requested cells get today's date).
 * The other founder's pending reminder for the same months is cancelled. Nothing is sent to Elmurat.
 */
export async function POST(req: NextRequest) {
  return handleApi(async (ctx) => {
    const body = await readJson(req);
    if (isInvalidJson(body) || typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonError(400, "validation", "Body must be a JSON object");
    }
    const { again, ...rest } = body as { again?: unknown };
    const data = askedSchema.parse(rest);
    const changed = await markAskedInApp(ctx, data.cells, again === true ? "again" : "missing");
    return NextResponse.json({ data: { changed } });
  });
}
