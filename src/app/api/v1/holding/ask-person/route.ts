import { NextResponse, type NextRequest } from "next/server";
import { askOverrideSchema } from "@/lib/holding-schemas";
import { handleApi, isInvalidJson, jsonError, readJson } from "@/server/api";
import { setAskOverride } from "@/server/services/holding";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/holding/ask-person — "who to ask" for one flow, this ask round only:
 * `{ flowId, personId }` (`personId: null` = back to the flow's own person). The person must
 * work for one of the flow's two companies. Nothing is ever sent to that person.
 */
export async function POST(req: NextRequest) {
  return handleApi(async (ctx) => {
    const body = await readJson(req);
    if (isInvalidJson(body) || typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonError(400, "validation", "Body must be a JSON object");
    }
    const data = askOverrideSchema.parse(body);
    return NextResponse.json({ data: await setAskOverride(ctx, data.flowId, data.personId) });
  });
}
