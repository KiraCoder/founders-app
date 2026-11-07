import { NextResponse, type NextRequest } from "next/server";
import { handleApi, isInvalidJson, jsonError, readJson } from "@/server/api";
import { decideAction } from "@/server/assistant/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** POST /api/v1/assistant/actions/:id — body {token, decision: "confirm" | "cancel"}: the card's button. */
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params;
  return handleApi(async (ctx) => {
    const body = (await readJson(req)) as { token?: unknown; decision?: unknown };
    if (isInvalidJson(body) || typeof body !== "object" || body === null) return jsonError(400, "validation", "Body must be a JSON object");
    if (typeof body.token !== "string" || (body.decision !== "confirm" && body.decision !== "cancel")) {
      return jsonError(400, "validation", "Need token and decision (confirm | cancel)");
    }
    return NextResponse.json({ data: await decideAction(ctx, id, body.token, body.decision, { baseUrl: "" }) });
  });
}
